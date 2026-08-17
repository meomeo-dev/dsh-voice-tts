/**
 * OpenAI TTS 纯逻辑(不 import cordis):请求构造、响应解析、HTTP 合成。
 * 权威接口见 https://developers.openai.com/api/docs/guides/text-to-speech。
 * 协议与 siliconflow 类似:`Authorization: Bearer` + 二进制音频响应(成功 200
 * 直接返回字节,非 NDJSON)。差异:OpenAI 无 `stream` body 参数(流式是 chunked
 * transfer 自动),无 sample_rate/gain;`instructions` 仅 gpt-4o-mini-tts 支持。
 *
 * 本模块只负责「拼 URL + 体 + 解析响应」;endpoint 的 host 部分由调用方(vendor
 * baseUrl)注入,path 恒为 `/audio/speech`(OpenAI 兼容协议)。
 * @module dsh-voice-tts/openai
 */

import type { ConfigTemplate, OpenaiConfig, TtsChunk, TtsResult, TunableParam } from './types.js'

/** OpenAI 兼容的 TTS 路径(相对 vendor baseUrl)。 */
export const OPENAI_API_PATH = '/audio/speech'

/** 默认 TTS 模型:tts-1(302AI 等 reseller 普遍支持;gpt-4o-mini-tts 302AI 不支持)。 */
export const DEFAULT_OPENAI_MODEL = 'tts-1'

/** 默认 vendor id(302AI 的 OpenAI 兼容 endpoint;在 settings.vendors 里定义)。 */
export const DEFAULT_OPENAI_VENDOR = '302ai-openai'

/** 可选的 TTS 模型 id(面板下拉联动音色)。 */
export const OPENAI_MODELS: readonly string[] = ['tts-1', 'tts-1-hd']

/** 默认音色:alloy(中性)。 */
export const DEFAULT_OPENAI_VOICE = 'alloy'

/**
 * 槽位可调参数注册表(单一真相源):驱动 schemastery 校验、Web 面板动态参数控件
 * 与 `config --template` 文档三处。键与 provider 顶层字段同名,槽位缺省回退顶层。
 */
export const OPENAI_TUNABLE_PARAMS: readonly TunableParam[] = [
  { key: 'speed', label: '语速', min: 0.25, max: 4, step: 0.05 },
]

/** OpenAI provider 的完整配置模板(对齐 docs/tts-vendor-credential-design.md §3.2)。 */
export const OPENAI_CONFIG_TEMPLATE: ConfigTemplate = {
  provider: 'openai',
  config: {
    vendor: {
      type: 'string', required: true, default: '',
      description: 'vendors 注册表里指向的 vendor id(该 vendor 提供 baseUrl + apiKeyRef)',
    },
    model: {
      type: 'string', required: true, default: DEFAULT_OPENAI_MODEL,
      description: 'TTS 模型 id:tts-1 / tts-1-hd(gpt-4o-mini-tts 302AI 不支持)',
    },
    voice_type: {
      type: 'string', required: true, default: DEFAULT_OPENAI_VOICE,
      description: '音色 ID(API 的 `voice`):alloy/ash/ballad/coral/echo/fable/nova/onyx/sage/shimmer/verse/marin/cedar',
    },
    instructions: {
      type: 'string', required: false, default: '',
      description: '自然语言控情绪/语速/口音(仅 gpt-4o-mini-tts;tts-1 忽略)',
    },
    format: {
      type: 'string', required: false, default: 'mp3', enum: ['mp3', 'opus', 'aac', 'flac'],
      description: '音频格式(映射到 API 的 response_format)',
    },
    play_format: {
      type: 'string', required: false, default: 'mp3', enum: ['mp3', 'opus', 'aac', 'flac'],
      description: 'host_play 的合成格式(OpenAI 无 wav,默认 mp3;ffplay/afplay 均播 mp3)',
    },
    speed: {
      type: 'number', required: false, default: 1,
      description: '语速 [0.25, 4.0]',
    },
    bilingual: {
      type: 'string', required: false, default: 'both', enum: ['both', 'english_only', 'chinese_only'],
      description: 'bilingual 播报模式:both 全读 / english_only 只读英文(含混合) / chinese_only 只读中文(含混合);中英混写句永远整句读',
    },
    voices: {
      type: 'object', required: false, default: null,
      description: '各语言类别槽位 { zh, en, mixed },每槽 { voice, speed? };缺省回退 voice,槽位参数缺省回退 provider 顶层字段',
    },
    voice_profiles: {
      type: 'object', required: false, default: null,
      description: 'per-voice 音色映射 { <voice id>: { zh, en, mixed } },槽位形状同 voices;命中当前 dsh-voice 的 voice id 时取代 voices',
    },
  },
  credentials: { apiKeyRef: '' },
}

/**
 * 构造一次合成请求(头 + JSON 体)。
 * @param config - 已解析的 OpenAI 配置。
 * @param apiKey - API key(`Authorization: Bearer` 头)。
 * @param text - 待合成文本。
 * @returns 请求头与 JSON 请求体。
 */
export function buildOpenaiRequest(
  config: OpenaiConfig,
  apiKey: string,
  text: string,
): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
  const payload: Record<string, unknown> = {
    model: config.model,
    input: text,
    voice: config.voice_type,
    response_format: config.format,
    speed: config.speed,
  }
  // `instructions` 仅 gpt-4o-mini-tts 支持;留空不发送,tts-1/tts-1-hd 也能正常合成。
  if (config.instructions.length > 0) payload.instructions = config.instructions
  return { headers, body: JSON.stringify(payload) }
}

/** 从非 2xx 响应体提取错误信息(JSON 错误体或纯文本)。 */
async function readError(response: Awaited<ReturnType<typeof fetch>>): Promise<string> {
  const text = await response.text()
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | { message?: unknown }; message?: unknown }
    const message = typeof parsed.error === 'object' && parsed.error !== null
      ? (parsed.error as { message?: unknown }).message
      : parsed.message
    if (typeof message === 'string') return message
    return JSON.stringify(parsed)
  } catch {
    return text.slice(0, 200)
  }
}

/**
 * 合成一段文本。成功 200 直接返回二进制音频,失败返回 JSON 错误。
 * @param config - 已解析的 OpenAI 配置。
 * @param baseUrl - endpoint 前缀(host + 版本前缀,来自 vendor)。
 * @param apiKey - API key。
 * @param text - 待合成文本。
 * @param fetchImpl - fetch 实现,默认 `globalThis.fetch`。
 * @returns 合成结果。
 */
export async function synthesizeOpenai(
  config: OpenaiConfig,
  baseUrl: string,
  apiKey: string,
  text: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TtsResult> {
  const { headers, body } = buildOpenaiRequest(config, apiKey, text)
  const response = await fetchImpl(`${baseUrl}${OPENAI_API_PATH}`, { method: 'POST', headers, body })
  if (!response.ok) {
    throw new Error(`openai TTS HTTP ${response.status}: ${await readError(response)}`)
  }
  const audio = new Uint8Array(await response.arrayBuffer())
  return { audio, format: config.format, textWords: 0 }
}

/**
 * 流式合成:OpenAI 无 `stream` body 参数,响应是 chunked transfer 的裸字节流,
 * 逐 chunk yield。`stream` 交付模式用它。
 * @param config - 已解析的 OpenAI 配置。
 * @param baseUrl - endpoint 前缀。
 * @param apiKey - API key。
 * @param text - 待合成文本。
 * @param fetchImpl - fetch 实现,默认 `globalThis.fetch`。
 * @returns 音频分片序列。
 */
export async function* streamOpenai(
  config: OpenaiConfig,
  baseUrl: string,
  apiKey: string,
  text: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): AsyncIterable<TtsChunk> {
  const { headers, body } = buildOpenaiRequest(config, apiKey, text)
  const response = await fetchImpl(`${baseUrl}${OPENAI_API_PATH}`, { method: 'POST', headers, body })
  if (!response.ok) {
    throw new Error(`openai TTS HTTP ${response.status}: ${await readError(response)}`)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    yield { audio: new Uint8Array(await response.arrayBuffer()) }
    return
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    yield { audio: value as Uint8Array }
  }
}
