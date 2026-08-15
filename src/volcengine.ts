/**
 * volcengine TTS 纯逻辑(不 import cordis):请求构造、响应解析、HTTP 合成。
 * 权威接口见 docs/tech_stack/tts/volcengine/api-unidirectional-http.md。
 * @module dsh-voice-tts/volcengine
 */

import { randomUUID } from 'node:crypto'
import type { ConfigTemplate, TtsResult, VolcengineConfig } from './types.js'

/** 单向流式合成接口。 */
export const VOLCENGINE_API_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'

/**
 * 开发期 API key 的环境变量引用名。最终发布版改走 dsh 的 credentials-local
 * 凭证机制(凭据引用),此常量仅作开发停靠,不硬编码任何值。
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
      description: '音频格式',
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
  const chunks: string[] = []
  let textWords = 0
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let payload: { code?: unknown; message?: unknown; data?: unknown; usage?: { text_words?: unknown } }
    try {
      payload = JSON.parse(line) as typeof payload
    } catch {
      throw new Error(`volcengine TTS returned malformed JSON: ${line.slice(0, 80)}`)
    }
    const code = payload.code
    if (code !== 0 && code !== 20000000) {
      const message = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload)
      throw new Error(`volcengine TTS failed (code ${String(code)}): ${message}`)
    }
    if (typeof payload.data === 'string' && payload.data.length > 0) chunks.push(payload.data)
    if (typeof payload.usage?.text_words === 'number') textWords = payload.usage.text_words
  }
  if (chunks.length === 0) {
    throw new Error('volcengine TTS returned no audio data')
  }
  const audio = Uint8Array.from(Buffer.from(chunks.join(''), 'base64'))
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
