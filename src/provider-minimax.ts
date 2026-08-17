/**
 * MiniMax TTS Provider:实现 {@link TtsProvider},调 MiniMax(302AI DashScope 风格)接口。
 * endpoint 由 vendor 决定——baseUrl + apiKeyRef 挂在 settings.vendors,provider 只持有
 * vendor 引用 + 合成参数。endpoint 由注入的 `resolveEndpoint` 解析(编排层用 dsh
 * credentials seam),provider 本身不读 env。
 * @module dsh-voice-tts/provider-minimax
 */

import type {
  MinimaxConfig,
  ResolvedEndpoint,
  TtsChunk,
  TtsProvider,
  TtsRequest,
  TtsResult,
  TtsVoice,
} from './types.js'
import { MINIMAX_SPEECH_02_TURBO_VOICES } from './minimax-voices.js'
import {
  DEFAULT_MINIMAX_MODEL,
  DEFAULT_MINIMAX_VENDOR,
  DEFAULT_MINIMAX_VOICE,
  MINIMAX_CONFIG_TEMPLATE,
  streamMinimax,
  synthesizeMinimax,
} from './minimax.js'

/** 把未知值收窄为合法格式,非法回退默认(缺省用 `fallback`)。 */
function formatOf(value: unknown, fallback: MinimaxConfig['format']): MinimaxConfig['format'] {
  return value === 'mp3' || value === 'pcm' || value === 'flac' || value === 'wav' ? value : fallback
}

/** 把宽松的请求配置归一为已解析的 minimax 配置(缺失字段回退默认)。 */
function resolveConfig(config: Record<string, unknown>): MinimaxConfig {
  return {
    vendor: typeof config.vendor === 'string' ? config.vendor : DEFAULT_MINIMAX_VENDOR,
    model: typeof config.model === 'string' ? config.model : DEFAULT_MINIMAX_MODEL,
    voice_type: typeof config.voice_type === 'string' ? config.voice_type : DEFAULT_MINIMAX_VOICE,
    speed: typeof config.speed === 'number' ? config.speed : 1,
    vol: typeof config.vol === 'number' ? config.vol : 1,
    pitch: typeof config.pitch === 'number' ? config.pitch : 0,
    emotion: typeof config.emotion === 'string' ? config.emotion : '',
    sample_rate: typeof config.sample_rate === 'number' ? config.sample_rate : 32000,
    format: formatOf(config.format, 'mp3'),
    play_format: formatOf(config.play_format, 'wav'),
    bitrate: typeof config.bitrate === 'number' ? config.bitrate : 128000,
    channel: config.channel === 2 ? 2 : 1,
    bilingual: 'both',
    voices: {},
    voice_profiles: {},
  }
}

/**
 * MiniMax TTS provider。endpoint 由注入的 `resolveEndpoint` 解析——编排层按 config.vendor
 * 查 settings.vendors 得 baseUrl + apiKeyRef,再经 dsh 的 credentials seam 解析密钥;
 * provider 本身不 import cordis(纯逻辑可单测)。
 */
export class MinimaxTtsProvider implements TtsProvider {
  readonly id = 'minimax'
  readonly configTemplate = MINIMAX_CONFIG_TEMPLATE

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
    return synthesizeMinimax(config, baseUrl, apiKey, request.text)
  }

  async *streamSynthesize(request: TtsRequest): AsyncIterable<TtsChunk> {
    const config = resolveConfig(request.config)
    const { baseUrl, apiKey } = await this.resolveEndpoint(config.vendor)
    yield * streamMinimax(config, baseUrl, apiKey, request.text)
  }

  listVoices(): readonly TtsVoice[] {
    return MINIMAX_SPEECH_02_TURBO_VOICES
  }
}
