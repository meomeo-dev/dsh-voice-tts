/**
 * siliconflow TTS 纯逻辑(不 import cordis):请求构造、响应解析、HTTP 合成。
 * 权威接口见 https://api-docs.siliconflow.cn/docs/api/audio-speech-post。
 * 与 volcengine 的差异:鉴权用 `Authorization: Bearer`(非 X-Api-Key),
 * 响应是**二进制音频**(成功 200 直接返回字节,非 NDJSON),流式也是裸字节流。
 * @module dsh-voice-tts/siliconflow
 */

import type { ConfigTemplate, SiliconflowConfig, TtsChunk, TtsResult, TunableParam } from './types.js'

/** 语音合成接口。 */
export const SILICONFLOW_API_URL = 'https://api.siliconflow.cn/v1/audio/speech'

/** API key 的默认凭证引用名(KEY NAME)。 */
export const DEFAULT_SILICONFLOW_API_KEY_REF = 'SILICONFLOW_API_KEY'

/** 默认 TTS 模型:CosyVoice2-0.5B(跨语种 + 情感控制)。 */
export const DEFAULT_SILICONFLOW_MODEL = 'FunAudioLLM/CosyVoice2-0.5B'

/**
 * 可选的 TTS 模型 id,供面板下拉联动音色。
 * CosyVoice2-0.5B 有 8 个系统预设音色;MOSS-TTSD-v0.5 无预设音色(双人声复刻)。
 */
export const SILICONFLOW_MODELS: readonly string[] = ['FunAudioLLM/CosyVoice2-0.5B', 'fnlp/MOSS-TTSD-v0.5']

/** 默认音色:alex(沉稳男声)。 */
export const DEFAULT_SILICONFLOW_VOICE = 'FunAudioLLM/CosyVoice2-0.5B:alex'

/**
 * 槽位可调参数注册表(单一真相源):驱动 schemastery 校验、Web 面板动态参数控件
 * 与 `config --template` 文档三处。键与 provider 顶层字段同名,槽位缺省回退顶层。
 */
export const SILICONFLOW_TUNABLE_PARAMS: readonly TunableParam[] = [
  { key: 'speed', label: '语速', min: 0.25, max: 4, step: 0.01 },
  { key: 'gain', label: '音量增益', min: -10, max: 10, step: 0.1 },
]

/** siliconflow provider 的完整配置模板(对齐 design.md §4.1)。 */
export const SILICONFLOW_CONFIG_TEMPLATE: ConfigTemplate = {
  provider: 'siliconflow-cn',
  config: {
    model: {
      type: 'string', required: true, default: DEFAULT_SILICONFLOW_MODEL,
      description: 'TTS 模型 id,如 FunAudioLLM/CosyVoice2-0.5B 或 fnlp/MOSS-TTSD-v0.5',
    },
    voice_type: {
      type: 'string', required: true, default: DEFAULT_SILICONFLOW_VOICE,
      description: '音色 ID(`voice`),如 FunAudioLLM/CosyVoice2-0.5B:alex',
    },
    format: {
      type: 'string', required: false, default: 'mp3', enum: ['mp3', 'opus', 'wav', 'pcm'],
      description: '音频格式(映射到 API 的 response_format)',
    },
    play_format: {
      type: 'string', required: false, default: 'wav', enum: ['mp3', 'opus', 'wav', 'pcm'],
      description: 'host_play 的合成格式(跨平台播放器兼容,默认 wav)',
    },
    sample_rate: {
      type: 'number', required: false, default: 32000,
      description: '采样率 Hz;opus 仅 48000,wav/pcm 8000–44100,mp3 32000/44100',
    },
    speed: {
      type: 'number', required: false, default: 1,
      description: '语速 [0.25, 4.0]',
    },
    gain: {
      type: 'number', required: false, default: 0,
      description: '音量增益 dB [-10, 10]',
    },
    bilingual: {
      type: 'string', required: false, default: 'both', enum: ['both', 'english_only', 'chinese_only'],
      description: 'bilingual 播报模式:both 全读 / english_only 只读纯英文 / chinese_only 只读纯中文;中英混写句仅 both 播报',
    },
    voices: {
      type: 'object', required: false, default: null,
      description: '各语言类别槽位 { zh, en, mixed },每槽 { voice_type, speed?, gain? };缺省回退 voice_type,槽位参数缺省回退 provider 顶层字段',
    },
    voice_profiles: {
      type: 'object', required: false, default: null,
      description: 'per-voice 音色映射 { <voice id>: { zh, en, mixed } },槽位形状同 voices;命中当前 dsh-voice 的 voice id 时取代 voices',
    },
  },
  credentials: { apiKeyRef: DEFAULT_SILICONFLOW_API_KEY_REF },
}

/**
 * 构造一次合成请求(头 + JSON 体)。
 * @param config - 已解析的 siliconflow 配置。
 * @param apiKey - API key(`Authorization: Bearer` 头)。
 * @param text - 待合成文本。
 * @param stream - 是否流式。
 * @returns 请求头与 JSON 请求体。
 */
export function buildSiliconflowRequest(
  config: SiliconflowConfig,
  apiKey: string,
  text: string,
  stream = false,
): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
  const body = JSON.stringify({
    model: config.model,
    input: text,
    voice: config.voice_type,
    response_format: config.format,
    sample_rate: config.sample_rate,
    speed: config.speed,
    gain: config.gain,
    stream,
  })
  return { headers, body }
}

/** 从非 2xx 响应体提取错误信息(JSON 错误体或纯文本)。 */
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

/**
 * 合成一段文本。成功 200 直接返回二进制音频,失败返回 JSON 错误。
 * `fetchImpl` 可注入以便单测替换真实网络。
 * @param config - 已解析的 siliconflow 配置。
 * @param apiKey - API key。
 * @param text - 待合成文本。
 * @param fetchImpl - fetch 实现,默认 `globalThis.fetch`。
 * @returns 合成结果。
 */
export async function synthesizeSiliconflow(
  config: SiliconflowConfig,
  apiKey: string,
  text: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TtsResult> {
  const { headers, body } = buildSiliconflowRequest(config, apiKey, text, false)
  const response = await fetchImpl(SILICONFLOW_API_URL, { method: 'POST', headers, body })
  if (!response.ok) {
    throw new Error(`siliconflow TTS HTTP ${response.status}: ${await readError(response)}`)
  }
  const audio = new Uint8Array(await response.arrayBuffer())
  return { audio, format: config.format, textWords: 0 }
}

/**
 * 流式合成:siliconflow 的 `stream: true` 返回裸音频字节流(非 NDJSON),
 * 逐 chunk yield。`stream` 交付模式用它。
 * `fetchImpl` 可注入以便单测替换真实网络;无 body reader 时退化为整体单分片。
 * @param config - 已解析的 siliconflow 配置。
 * @param apiKey - API key。
 * @param text - 待合成文本。
 * @param fetchImpl - fetch 实现,默认 `globalThis.fetch`。
 * @returns 音频分片序列。
 */
export async function* streamSiliconflow(
  config: SiliconflowConfig,
  apiKey: string,
  text: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): AsyncIterable<TtsChunk> {
  const { headers, body } = buildSiliconflowRequest(config, apiKey, text, true)
  const response = await fetchImpl(SILICONFLOW_API_URL, { method: 'POST', headers, body })
  if (!response.ok) {
    throw new Error(`siliconflow TTS HTTP ${response.status}: ${await readError(response)}`)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const audio = new Uint8Array(await response.arrayBuffer())
    yield { audio }
    return
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    yield { audio: value as Uint8Array }
  }
}
