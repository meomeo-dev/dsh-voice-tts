/**
 * OpenAI TTS Provider:实现 {@link TtsProvider},调 OpenAI 兼容语音合成接口。
 * 与 volcengine/siliconflow 的差异:endpoint 由 vendor 决定——baseUrl + apiKeyRef 挂在
 * settings.vendors,provider 只持有 vendor 引用 + 合成参数。endpoint 由注入的
 * `resolveEndpoint` 解析(编排层用 dsh credentials seam),provider 本身不读 env。
 * @module dsh-voice-tts/provider-openai
 */

import type {
  OpenaiConfig,
  ResolvedEndpoint,
  TtsChunk,
  TtsProvider,
  TtsRequest,
  TtsResult,
  TtsVoice,
} from './types.js'
import { OPENAI_TTS_1_VOICES } from './openai-voices.js'
import {
  DEFAULT_OPENAI_MODEL,
  DEFAULT_OPENAI_VENDOR,
  DEFAULT_OPENAI_VOICE,
  OPENAI_CONFIG_TEMPLATE,
  streamOpenai,
  synthesizeOpenai,
} from './openai.js'

/** 把未知值收窄为合法格式,非法回退默认(缺省用 `fallback`)。 */
function formatOf(value: unknown, fallback: OpenaiConfig['format']): OpenaiConfig['format'] {
  return value === 'mp3' || value === 'opus' || value === 'aac' || value === 'flac' ? value : fallback
}

/** 把宽松的请求配置归一为已解析的 openai 配置(缺失字段回退默认)。 */
function resolveConfig(config: Record<string, unknown>): OpenaiConfig {
  return {
    vendor: typeof config.vendor === 'string' ? config.vendor : DEFAULT_OPENAI_VENDOR,
    model: typeof config.model === 'string' ? config.model : DEFAULT_OPENAI_MODEL,
    voice_type: typeof config.voice_type === 'string' ? config.voice_type : DEFAULT_OPENAI_VOICE,
    instructions: typeof config.instructions === 'string' ? config.instructions : '',
    format: formatOf(config.format, 'mp3'),
    play_format: formatOf(config.play_format, 'mp3'),
    speed: typeof config.speed === 'number' ? config.speed : 1,
    bilingual: 'both',
    voices: {},
    voice_profiles: {},
  }
}

/**
 * OpenAI TTS provider。endpoint 由注入的 `resolveEndpoint` 解析——编排层按 config.vendor
 * 查 settings.vendors 得 baseUrl + apiKeyRef,再经 dsh 的 credentials seam 解析密钥;
 * provider 本身不 import cordis(纯逻辑可单测)。
 */
export class OpenaiTtsProvider implements TtsProvider {
  readonly id = 'openai'
  readonly configTemplate = OPENAI_CONFIG_TEMPLATE

  private readonly resolveEndpoint: (vendorId: string) => Promise<ResolvedEndpoint>

  /**
   * @param resolveEndpoint - 每次合成按 vendor id 解析一次 endpoint(对齐 llm 适配器的 per-operation 语义)。
   */
  constructor(resolveEndpoint: (vendorId: string) => Promise<ResolvedEndpoint>) {
    this.resolveEndpoint = resolveEndpoint
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const config = resolveConfig(request.config)
    const { baseUrl, apiKey } = await this.resolveEndpoint(config.vendor)
    return synthesizeOpenai(config, baseUrl, apiKey, request.text)
  }

  async *streamSynthesize(request: TtsRequest): AsyncIterable<TtsChunk> {
    const config = resolveConfig(request.config)
    const { baseUrl, apiKey } = await this.resolveEndpoint(config.vendor)
    yield * streamOpenai(config, baseUrl, apiKey, request.text)
  }

  listVoices(): readonly TtsVoice[] {
    return OPENAI_TTS_1_VOICES
  }
}
