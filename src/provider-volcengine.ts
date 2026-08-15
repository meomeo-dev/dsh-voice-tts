/**
 * volcengine TTS Provider:实现 {@link TtsProvider},调 volcengine 单向流式接口。
 * @module dsh-voice-tts/provider-volcengine
 */

import type {
  TtsChunk,
  TtsProvider,
  TtsRequest,
  TtsResult,
  TtsVoice,
  VolcengineConfig,
  VolcengineFormat,
  VolcengineResourceId,
} from './types.js'
import { VOLCENGINE_VOICES } from './voices.js'
import {
  DEFAULT_VOICE_TYPE,
  streamVolcengine,
  synthesizeVolcengine,
  VOLCENGINE_CONFIG_TEMPLATE,
} from './volcengine.js'

/** 把未知值收窄为合法的模型版本,非法回退默认。 */
function resourceIdOf(value: unknown): VolcengineResourceId {
  return value === 'seed-tts-2.0' || value === 'seed-icl-2.0' ? value : 'seed-tts-2.0'
}

/** 把未知值收窄为合法的音频格式,非法回退默认(缺省格式用 `fallback`)。 */
function formatOf(value: unknown, fallback: VolcengineFormat): VolcengineFormat {
  return value === 'mp3' || value === 'pcm' || value === 'ogg_opus' || value === 'wav' ? value : fallback
}

/** 把宽松的请求配置归一为已解析的 volcengine 配置(缺失字段回退默认)。 */
function resolveConfig(config: Record<string, unknown>): VolcengineConfig {
  return {
    voice_type: typeof config.voice_type === 'string' ? config.voice_type : DEFAULT_VOICE_TYPE,
    resource_id: resourceIdOf(config.resource_id),
    model: typeof config.model === 'string' ? config.model : '',
    format: formatOf(config.format, 'mp3'),
    play_format: formatOf(config.play_format, 'wav'),
    sample_rate: typeof config.sample_rate === 'number' ? config.sample_rate : 24000,
    speech_rate: typeof config.speech_rate === 'number' ? config.speech_rate : 0,
    loudness_rate: typeof config.loudness_rate === 'number' ? config.loudness_rate : 0,
    pitch: typeof config.pitch === 'number' ? config.pitch : 0,
    bilingual: 'both',
    voices: {},
    voice_profiles: {},
  }
}

/**
 * volcengine TTS provider。API key 由注入的 `resolveApiKey` 解析——编排层用
 * dsh 的 credentials seam(`ctx.credentials.resolve(credentialRef(...))`)实现,
 * provider 本身不读 `process.env`、也不 import cordis(纯逻辑可单测)。
 */
export class VolcengineTtsProvider implements TtsProvider {
  readonly id = 'volcengine'
  readonly configTemplate = VOLCENGINE_CONFIG_TEMPLATE

  private readonly resolveApiKey: () => Promise<string>

  /**
   * @param resolveApiKey - 每次合成调用时解析一次 API key(对齐 llm 适配器的 per-operation 语义)。
   */
  constructor(resolveApiKey: () => Promise<string>) {
    this.resolveApiKey = resolveApiKey
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    return synthesizeVolcengine(resolveConfig(request.config), await this.resolveApiKey(), request.text)
  }

  async *streamSynthesize(request: TtsRequest): AsyncIterable<TtsChunk> {
    yield * streamVolcengine(resolveConfig(request.config), await this.resolveApiKey(), request.text)
  }

  listVoices(): readonly TtsVoice[] {
    return VOLCENGINE_VOICES
  }
}
