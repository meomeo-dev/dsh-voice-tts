/**
 * MiniMax TTS 纯逻辑(不 import cordis):请求构造、响应解析、HTTP 合成。
 * 权威接口见 docs/tts-openai-minimax-integration.md §2(302AI 的 DashScope 风格端点)。
 * 协议与 volcengine 类似:JSON 响应,`data.audio` 为 hex 编码音频(非流式);
 * 流式加 `stream: true`,SSE 逐帧 hex。与 OpenAI 不同:MiniMax 不是 OpenAI 兼容,
 * path 由 vendor 决定(302AI 是 `/t2a_v2`,DashScope 原生是另一条)。
 *
 * 本模块只负责「拼 URL + 体 + 解析响应」;endpoint 的 host 部分由调用方(vendor
 * baseUrl)注入,path 恒为 `/t2a_v2`(302AI 协议)。
 * @module dsh-voice-tts/minimax
 */

import type { ConfigTemplate, MinimaxConfig, TtsChunk, TtsResult, TunableParam } from './types.js'

/** MiniMax(302AI)的 TTS 路径(相对 vendor baseUrl)。 */
export const MINIMAX_API_PATH = '/t2a_v2'

/** 默认 TTS 模型:speech-2.8-turbo。 */
export const DEFAULT_MINIMAX_MODEL = 'speech-2.8-turbo'

/** 默认 vendor id(302AI 的 MiniMax endpoint;在 settings.vendors 里定义)。 */
export const DEFAULT_MINIMAX_VENDOR = '302ai-minimax'

/** 可选的 TTS 模型 id(面板下拉)。 */
export const MINIMAX_MODELS: readonly string[] = ['speech-2.8-turbo', 'speech-2.8-hd', 'speech-2.6-hd']

/** 默认音色:中文普通话「可靠高管」(系统音色首个)。 */
export const DEFAULT_MINIMAX_VOICE = 'Chinese (Mandarin)_Reliable_Executive'

/**
 * 槽位可调参数注册表(单一真相源):驱动 schemastery 校验、Web 面板动态参数控件
 * 与 `config --template` 文档三处。键与 provider 顶层字段同名,槽位缺省回退顶层。
 */
export const MINIMAX_TUNABLE_PARAMS: readonly TunableParam[] = [
  { key: 'speed', label: '语速', min: 0.5, max: 2, step: 0.1 },
  { key: 'vol', label: '音量', min: 0.1, max: 10, step: 0.1 },
  { key: 'pitch', label: '音调', min: -12, max: 12, step: 1 },
]

/** MiniMax provider 的完整配置模板(对齐 docs/tts-vendor-credential-design.md §3.2)。 */
export const MINIMAX_CONFIG_TEMPLATE: ConfigTemplate = {
  provider: 'minimax',
  config: {
    vendor: {
      type: 'string', required: true, default: '',
      description: 'vendors 注册表里指向的 vendor id(该 vendor 提供 baseUrl + apiKeyRef)',
    },
    model: {
      type: 'string', required: true, default: DEFAULT_MINIMAX_MODEL,
      description: 'TTS 模型 id:speech-2.8-turbo / speech-2.8-hd / speech-2.6-hd',
    },
    voice_type: {
      type: 'string', required: true, default: DEFAULT_MINIMAX_VOICE,
      description: '音色 ID(API 的 `voice_id`,官方系统音色,如 Chinese (Mandarin)_Reliable_Executive)',
    },
    speed: {
      type: 'number', required: false, default: 1,
      description: '语速 [0.5, 2.0]',
    },
    vol: {
      type: 'number', required: false, default: 1,
      description: '音量 (0, 10]',
    },
    pitch: {
      type: 'number', required: false, default: 0,
      description: '音调 [-12, 12]',
    },
    emotion: {
      type: 'string', required: false, default: '',
      description: '情感:happy / sad / angry / calm / fluent(留空不发送)',
    },
    sample_rate: {
      type: 'number', required: false, default: 32000,
      description: '采样率 Hz',
    },
    format: {
      type: 'string', required: false, default: 'mp3', enum: ['mp3', 'pcm', 'flac', 'wav'],
      description: '音频格式',
    },
    bitrate: {
      type: 'number', required: false, default: 128000,
      description: '码率(仅 mp3)',
    },
    channel: {
      type: 'number', required: false, default: 1, enum: [1, 2],
      description: '声道数',
    },
    bilingual: {
      type: 'string', required: false, default: 'both', enum: ['both', 'english_only', 'chinese_only'],
      description: 'bilingual 播报模式:both 全读 / english_only 只读纯英文 / chinese_only 只读纯中文;中英混写句仅 both 播报',
    },
    segment_strategy: {
      type: 'string', required: false, default: 'sentence', enum: ['off', 'sentence', 'script-run', 'custom-separator'],
      description: '文本切分策略:off 整段单一音色 / sentence 句子级(现状) / script-run 连续区段夹杂抑制 / custom-separator 自定义分段符切窗口',
    },
    segment_threshold: {
      type: 'number', required: false, default: 5,
      description: '夹杂区段长度阈值:区段脚本字符数 ≤ 该值且被异语言区段夹持则跳过(仅 both 生效)',
    },
    segment_separators: {
      type: 'string', required: false, default: '',
      description: 'custom-separator 的自定义分段符(任一命中即切窗口;空串 = 无命中,退化为句子级)',
    },
    voices: {
      type: 'object', required: false, default: null,
      description: '各语言类别槽位 { zh, en, mixed },每槽 { voice_id, speed?, vol?, pitch? };缺省回退 voice_id',
    },
    voice_profiles: {
      type: 'object', required: false, default: null,
      description: 'per-voice 音色映射 { <voice id>: { zh, en, mixed } },槽位形状同 voices;命中当前 dsh-voice 的 voice id 时取代 voices',
    },
  },
  credentials: { apiKeyRef: '' },
}

/**
 * 构造一次合成请求(头 + JSON 体)。DashScope 风格:model/text/voice_setting/audio_setting。
 * 非流式(stream 缺省 false)。audio_setting.format 决定 `data.audio` 的编码(hex)。
 * @param config - 已解析的 MiniMax 配置。
 * @param apiKey - API key(`Authorization: Bearer` 头)。
 * @param text - 待合成文本。
 * @param stream - 是否流式。
 * @returns 请求头与 JSON 请求体。
 */
export function buildMinimaxRequest(
  config: MinimaxConfig,
  apiKey: string,
  text: string,
  stream = false,
): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
  const voiceSetting: Record<string, unknown> = {
    voice_id: config.voice_type,
    speed: config.speed,
    vol: config.vol,
    pitch: config.pitch,
  }
  if (config.emotion.length > 0) voiceSetting.emotion = config.emotion
  const audioSetting: Record<string, unknown> = {
    sample_rate: config.sample_rate,
    format: config.format,
    channel: config.channel,
  }
  // `bitrate` 仅 mp3 生效;非 mp3 发送会 400 或被忽略,故只对 mp3 附带。
  if (config.format === 'mp3') audioSetting.bitrate = config.bitrate
  const body = JSON.stringify({
    model: config.model,
    text,
    stream,
    voice_setting: voiceSetting,
    audio_setting: audioSetting,
  })
  return { headers, body }
}

/** 一条 MiniMax 响应(非流式 JSON)。 */
interface MinimaxPayload {
  data?: { audio?: unknown }
  code?: unknown
  message?: unknown
}

/** 从非 2xx 响应体提取错误信息。 */
async function readError(response: Awaited<ReturnType<typeof fetch>>): Promise<string> {
  const text = await response.text()
  try {
    const parsed = JSON.parse(text) as { message?: unknown; code?: unknown }
    if (typeof parsed.message === 'string') return parsed.message
    return JSON.stringify(parsed)
  } catch {
    return text.slice(0, 200)
  }
}

/** 把 `data.audio`(hex 字符串)解码为字节;非法/缺失抛错。 */
function decodeAudio(data: unknown): Uint8Array {
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('minimax TTS returned no audio data')
  }
  // Buffer.from(str, 'hex') 对非法 hex 不抛错而是静默截断,故先显式校验,
  // 让「非法音频」当场 fail loud(不静默产出残缺音频)。
  if (data.length % 2 !== 0 || !/^[0-9a-fA-F]+$/u.test(data)) {
    throw new Error('minimax TTS returned malformed audio (not hex)')
  }
  return Uint8Array.from(Buffer.from(data, 'hex'))
}

/**
 * 合成一段文本(非流式)。响应 JSON 的 `data.audio` 为 hex 编码音频。
 * @param config - 已解析的 MiniMax 配置。
 * @param baseUrl - endpoint 前缀(host + 版本前缀,来自 vendor)。
 * @param apiKey - API key。
 * @param text - 待合成文本。
 * @param fetchImpl - fetch 实现,默认 `globalThis.fetch`。
 * @returns 合成结果。
 */
export async function synthesizeMinimax(
  config: MinimaxConfig,
  baseUrl: string,
  apiKey: string,
  text: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TtsResult> {
  const { headers, body } = buildMinimaxRequest(config, apiKey, text, false)
  const response = await fetchImpl(`${baseUrl}${MINIMAX_API_PATH}`, { method: 'POST', headers, body })
  if (!response.ok) {
    throw new Error(`minimax TTS HTTP ${response.status}: ${await readError(response)}`)
  }
  const payload = await response.json() as MinimaxPayload
  const audio = decodeAudio(payload.data?.audio)
  return { audio, format: config.format, textWords: 0 }
}

/**
 * 从 SSE buffer 提取一个完整帧(空行分隔)。分隔符兼容 `\n\n` 与 `\r\n\r\n`。
 * 无完整帧时返回 undefined(buffered 里可能还有半帧)。
 * @param buffer - 累积的原始文本。
 * @returns 完整帧 + 剩余文本;无完整帧返回 undefined。
 */
function extractSseFrame(buffer: string): { frame: string; rest: string } | undefined {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf < 0 && crlf < 0) return undefined
  if (lf >= 0 && (crlf < 0 || lf < crlf)) return { frame: buffer.slice(0, lf), rest: buffer.slice(lf + 2) }
  return { frame: buffer.slice(0, crlf), rest: buffer.slice(crlf + 4) }
}

/** 解析一个 SSE 帧的 `data:` 行,解码出其中的音频分片。非 JSON 行忽略(注释/心跳)。 */
function parseSseFrame(frame: string): Uint8Array[] {
  const parts: Uint8Array[] = []
  for (const rawLine of frame.split(/\r?\n/u)) {
    const data = rawLine.startsWith('data:') ? rawLine.slice(5).trim() : ''
    if (data.length === 0) continue
    try {
      const payload = JSON.parse(data) as MinimaxPayload
      const audio = payload.data?.audio
      if (typeof audio === 'string' && audio.length > 0) parts.push(decodeAudio(audio))
    } catch {
      // 非 JSON 帧(如注释/心跳)忽略;音频帧才是有效载荷。
    }
  }
  return parts
}

/**
 * 流式合成:SSE 响应,逐帧 `data.audio` 为 hex,decode 后 yield。
 * @param config - 已解析的 MiniMax 配置。
 * @param baseUrl - endpoint 前缀。
 * @param apiKey - API key。
 * @param text - 待合成文本。
 * @param fetchImpl - fetch 实现,默认 `globalThis.fetch`。
 * @returns 音频分片序列。
 */
export async function* streamMinimax(
  config: MinimaxConfig,
  baseUrl: string,
  apiKey: string,
  text: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): AsyncIterable<TtsChunk> {
  const { headers, body } = buildMinimaxRequest(config, apiKey, text, true)
  const response = await fetchImpl(`${baseUrl}${MINIMAX_API_PATH}`, { method: 'POST', headers, body })
  if (!response.ok) {
    throw new Error(`minimax TTS HTTP ${response.status}: ${await readError(response)}`)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const payload = await response.json() as MinimaxPayload
    yield { audio: decodeAudio(payload.data?.audio) }
    return
  }
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    for (;;) {
      const extracted = extractSseFrame(buffer)
      if (extracted === undefined) break
      buffer = extracted.rest
      for (const part of parseSseFrame(extracted.frame)) yield { audio: part }
    }
  }
  // 冲刷:连接关闭时最后一帧可能不以空行结尾,剩余 buffer 仍要解析(否则丢末帧音频)。
  buffer += decoder.decode()
  for (const part of parseSseFrame(buffer)) yield { audio: part }
}
