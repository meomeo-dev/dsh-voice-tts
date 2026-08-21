/**
 * siliconflow TTS Provider:实现 {@link TtsProvider},调 siliconflow 语音合成接口。
 * 与 volcengine 的差异:鉴权用 Bearer、响应是二进制音频。API key 由注入的
 * `resolveApiKey` 解析(编排层用 dsh credentials seam),provider 本身不读 env。
 * @module dsh-voice-tts/provider-siliconflow
 */

import type {
  SiliconflowConfig,
  TtsChunk,
  TtsProvider,
  TtsRequest,
  TtsResult,
  TtsVoice,
} from './types.js'
import { SILICONFLOW_VOICES } from './siliconflow-voices.js'
import {
  DEFAULT_SILICONFLOW_MODEL,
  DEFAULT_SILICONFLOW_VOICE,
  SILICONFLOW_CONFIG_TEMPLATE,
  streamSiliconflow,
  synthesizeSiliconflow,
} from './siliconflow.js'

/** 把未知值收窄为合法格式,非法回退默认(缺省用 `fallback`)。 */
function formatOf(value: unknown, fallback: SiliconflowConfig['format']): SiliconflowConfig['format'] {
  return value === 'mp3' || value === 'opus' || value === 'wav' || value === 'pcm' ? value : fallback
}

/** 把宽松的请求配置归一为已解析的 siliconflow 配置(缺失字段回退默认)。 */
function resolveConfig(config: Record<string, unknown>): SiliconflowConfig {
  return {
    model: typeof config.model === 'string' ? config.model : DEFAULT_SILICONFLOW_MODEL,
    voice_type: typeof config.voice_type === 'string' ? config.voice_type : DEFAULT_SILICONFLOW_VOICE,
    format: formatOf(config.format, 'mp3'),
    play_format: formatOf(config.play_format, 'wav'),
    sample_rate: typeof config.sample_rate === 'number' ? config.sample_rate : 32000,
    speed: typeof config.speed === 'number' ? config.speed : 1,
    gain: typeof config.gain === 'number' ? config.gain : 0,
    bilingual: 'both',
    segment_strategy: 'sentence',
    segment_threshold: 5,
    segment_separators: '',
    voices: {},
    voice_profiles: {},
  }
}

/**
 * siliconflow TTS provider。API key 由注入的 `resolveApiKey` 解析——
 * 编排层用 dsh 的 credentials seam(`ctx.credentials.resolve(credentialRef(...))`)
 * 实现,provider 本身不读 `process.env`、也不 import cordis(纯逻辑可单测)。
 */
export class SiliconflowTtsProvider implements TtsProvider {
  readonly id = 'siliconflow-cn'
  readonly configTemplate = SILICONFLOW_CONFIG_TEMPLATE

  private readonly resolveApiKey: () => Promise<string>

  /**
   * @param resolveApiKey - 每次合成调用时解析一次 API key(对齐 llm 适配器的 per-operation 语义)。
   */
  constructor(resolveApiKey: () => Promise<string>) {
    this.resolveApiKey = resolveApiKey
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    return synthesizeSiliconflow(resolveConfig(request.config), await this.resolveApiKey(), request.text)
  }

  async *streamSynthesize(request: TtsRequest): AsyncIterable<TtsChunk> {
    yield * streamSiliconflow(resolveConfig(request.config), await this.resolveApiKey(), request.text)
  }

  listVoices(): readonly TtsVoice[] {
    return SILICONFLOW_VOICES
  }
}
