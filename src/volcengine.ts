/**
 * volcengine TTS 纯逻辑(不 import cordis):请求构造、响应解析、HTTP 合成。
 * 权威接口见 docs/tech_stack/tts/volcengine/api-unidirectional-http.md。
 * @module dsh-voice-tts/volcengine
 */

import { randomUUID } from 'node:crypto'
import type { ConfigTemplate, TtsChunk, TtsResult, VolcengineConfig } from './types.js'

/** 单向流式合成接口。 */
export const VOLCENGINE_API_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'

/**
 * API key 的凭证引用名(credential-ref,存 `~/.dsh/.credentials.yaml`)。
 * 配置载体只存这个引用名、不存秘密本身;运行时经 `ctx.credentials.resolve`
 * 解析,底层 credentials-local 会把 process env / `.env` 作为回退层。
 */
export const VOLCENGINE_API_KEY_REF = 'VOLCENGINE_TTS_API_KEY'

/** 默认音色:2.0 标准首个通用女声 Vivi 2.0。 */
export const DEFAULT_VOICE_TYPE = 'zh_female_vv_uranus_bigtts'

/** volcengine provider 的完整配置模板(对齐 design.md §4.1)。 */
export const VOLCENGINE_CONFIG_TEMPLATE: ConfigTemplate = {
  provider: 'volcengine',
  config: {
    voice_type: {
      type: 'string', required: true, default: null,
      description: '音色 ID(speaker),值见 voices.md,如 zh_female_vv_uranus_bigtts',
    },
    resource_id: {
      type: 'string', required: false, default: 'seed-tts-2.0', enum: ['seed-tts-2.0', 'seed-icl-2.0'],
      description: '模型版本;复刻音色用 seed-icl-2.0',
    },
    model: {
      type: 'string', required: false, default: '',
      description: 'req_params.model 显式覆盖(通常留空;仅旧版 1.0 音色需指定,如 seed-tts-1.1)。2.0 合成/复刻由 X-Api-Resource-Id 决定,勿设',
    },
    format: {
      type: 'string', required: false, default: 'mp3', enum: ['mp3', 'pcm', 'ogg_opus', 'wav'],
      description: '音频格式(file/stream 落盘用)',
    },
    play_format: {
      type: 'string', required: false, default: 'wav', enum: ['mp3', 'pcm', 'ogg_opus', 'wav'],
      description: 'host_play 的合成格式(跨平台系统播放器兼容,默认 wav)',
    },
    sample_rate: {
      type: 'number', required: false, default: 24000,
      description: '采样率 Hz,可选 8000/16000/22050/24000/32000/44100/48000',
    },
    speech_rate: {
      type: 'number', required: false, default: 0,
      description: '语速 [-50,100],100=2 倍速,-50=0.5 倍速',
    },
    loudness_rate: {
      type: 'number', required: false, default: 0,
      description: '音量 [-50,100],100=2 倍音量',
    },
    pitch: {
      type: 'number', required: false, default: 0,
      description: '音调 [-12,12]',
    },
    bilingual: {
      type: 'string', required: false, default: 'both', enum: ['both', 'english_only', 'chinese_only'],
      description: 'bilingual 播报模式:both 全读 / english_only 只读英文(含混合) / chinese_only 只读中文(含混合);中英混写句永远整句读',
    },
    voices: {
      type: 'object', required: false, default: null,
      description: '各语言类别音色覆盖 { zh, en, mixed },缺省回退 voice_type;mixed 先回退 zh 再回退 voice_type',
    },
    voice_profiles: {
      type: 'object', required: false, default: null,
      description: 'per-voice 音色映射 { <voice id>: { zh, en, mixed } },命中当前 dsh-voice 的 voice id 时取代 voices',
    },
  },
  credentials: { apiKeyRef: VOLCENGINE_API_KEY_REF },
}

/**
 * 构造一次单向流式合成请求(头 + JSON 体)。
 * @param config - 已解析的 volcengine 配置。
 * @param apiKey - API key(`X-Api-Key` 头)。
 * @param text - 待合成文本。
 * @returns 请求头与 JSON 请求体。
 */
export function buildVolcengineRequest(
  config: VolcengineConfig,
  apiKey: string,
  text: string,
): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': config.resource_id,
    'X-Api-Request-Id': randomUUID(),
    'X-Control-Require-Usage-Tokens-Return': '*',
    'Content-Type': 'application/json',
  }
  const reqParams: Record<string, unknown> = {
    text,
    speaker: config.voice_type,
    audio_params: {
      format: config.format,
      sample_rate: config.sample_rate,
      speech_rate: config.speech_rate,
      loudness_rate: config.loudness_rate,
    },
  }
  // `model` 是可选显式覆盖:留空不发送,由 X-Api-Resource-Id 决定模型
  // (2.0 合成/复刻都这样);仅旧版 1.0 音色需显式指定(如 seed-tts-1.1)。
  if (config.model.length > 0) {
    reqParams.model = config.model
  }
  const body = JSON.stringify({
    req_params: reqParams,
    post_process: { pitch: config.pitch },
  })
  return { headers, body }
}

/** 单行 NDJSON 载荷。 */
interface VolcengineLine {
  code?: unknown
  message?: unknown
  data?: unknown
  usage?: { text_words?: unknown }
}

/** 解析一行 NDJSON,校验 code,返回 base64 音频串(可能为空)与计费字数(可能为 undefined)。 */
function parseLine(line: string): { data: string; textWords: number | undefined } {
  let payload: VolcengineLine
  try {
    payload = JSON.parse(line) as VolcengineLine
  } catch {
    throw new Error(`volcengine TTS returned malformed JSON: ${line.slice(0, 80)}`)
  }
  const code = payload.code
  if (code !== 0 && code !== 20000000) {
    const message = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload)
    throw new Error(`volcengine TTS failed (code ${String(code)}): ${message}`)
  }
  const data = typeof payload.data === 'string' && payload.data.length > 0 ? payload.data : ''
  const textWords = typeof payload.usage?.text_words === 'number' ? payload.usage.text_words : undefined
  return { data, textWords }
}

/**
 * 解析 volcengine 单向流式响应为合成结果。响应为**换行分隔的 JSON 流**(NDJSON):
 * 每行一个 JSON 对象——音频分片行 `{"code":0,"data":"<base64>"}`,末尾一行是成功摘要
 * `{"code":20000000,"message":"OK","data":null,"usage":{...}}`。两个码都是成功:
 * `0` 表示音频分片,`20000000` 表示整体成功。
 * @param text - 原始响应文本。
 * @param format - 请求的音频格式(结果沿用)。
 * @returns 拼接并解码后的合成结果。
 * @throws 当任一行 `code` 非成功码、或行非 JSON、或无音频时抛错。
 */
export function parseVolcengineStream(text: string, format: string): TtsResult {
  const parts: Uint8Array[] = []
  let textWords = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    const parsed = parseLine(line)
    // 每个分片是独立 base64 编码、末尾可能带 `=` padding;必须单独解码再拼字节,
    // 不能 join base64 字符串后一次性解码(中间的 `=` 会让解码提前停止)。
    if (parsed.data.length > 0) parts.push(Uint8Array.from(Buffer.from(parsed.data, 'base64')))
    if (parsed.textWords !== undefined) textWords = parsed.textWords
  }
  if (parts.length === 0) {
    throw new Error('volcengine TTS returned no audio data')
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const audio = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    audio.set(part, offset)
    offset += part.byteLength
  }
  return { audio, format, textWords }
}

/**
 * 合成一段文本。`fetchImpl` 可注入以便单测替换真实网络。
 * @param config - 已解析的 volcengine 配置。
 * @param apiKey - API key。
 * @param text - 待合成文本。
 * @param fetchImpl - fetch 实现,默认 `globalThis.fetch`。
 * @returns 合成结果。
 */
export async function synthesizeVolcengine(
  config: VolcengineConfig,
  apiKey: string,
  text: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TtsResult> {
  const { headers, body } = buildVolcengineRequest(config, apiKey, text)
  const response = await fetchImpl(VOLCENGINE_API_URL, { method: 'POST', headers, body })
  if (!response.ok) {
    throw new Error(`volcengine TTS HTTP ${response.status}: ${await response.text()}`)
  }
  return parseVolcengineStream(await response.text(), config.format)
}

/**
 * 流式合成:基于响应 body 的 ReadableStream 逐行解析 NDJSON,每遇到一个音频分片
 * 就 yield 一次,不攒完整音频。`stream` 交付模式用它。
 * `fetchImpl` 可注入以便单测替换真实网络;无 body reader 时退化为整体单分片。
 * @param config - 已解析的 volcengine 配置。
 * @param apiKey - API key。
 * @param text - 待合成文本。
 * @param fetchImpl - fetch 实现,默认 `globalThis.fetch`。
 * @returns 音频分片序列。
 */
export async function* streamVolcengine(
  config: VolcengineConfig,
  apiKey: string,
  text: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): AsyncIterable<TtsChunk> {
  const { headers, body } = buildVolcengineRequest(config, apiKey, text)
  const response = await fetchImpl(VOLCENGINE_API_URL, { method: 'POST', headers, body })
  if (!response.ok) {
    throw new Error(`volcengine TTS HTTP ${response.status}: ${await response.text()}`)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    // 无流式 body 的环境:整体解析后作为单分片。
    const result = parseVolcengineStream(await response.text(), config.format)
    yield { audio: result.audio }
    return
  }
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim().length === 0) continue
      const { data } = parseLine(line)
      if (data.length > 0) yield { audio: Uint8Array.from(Buffer.from(data, 'base64')) }
    }
  }
  const tail = buffer.trim()
  if (tail.length > 0) {
    const { data } = parseLine(tail)
    if (data.length > 0) yield { audio: Uint8Array.from(Buffer.from(data, 'base64')) }
  }
}
