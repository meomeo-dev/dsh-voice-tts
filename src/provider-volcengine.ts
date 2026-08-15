/**
 * volcengine TTS Provider:实现 {@link TtsProvider},调 volcengine 单向流式接口。
 * @module dsh-voice-tts/provider-volcengine
 */

import type {
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
  synthesizeVolcengine,
  VOLCENGINE_API_KEY_REF,
  VOLCENGINE_CONFIG_TEMPLATE,
} from './volcengine.js'

/** 把未知值收窄为合法的模型版本,非法回退默认。 */
function resourceIdOf(value: unknown): VolcengineResourceId {
  return value === 'seed-tts-2.0' || value === 'seed-icl-2.0' ? value : 'seed-tts-2.0'
}

/** 把未知值收窄为合法的音频格式,非法回退默认。 */
function formatOf(value: unknown): VolcengineFormat {
  return value === 'mp3' || value === 'pcm' || value === 'ogg_opus' || value === 'wav' ? value : 'mp3'
}

/** 把宽松的请求配置归一为已解析的 volcengine 配置(缺失字段回退默认)。 */
function resolveConfig(config: Record<string, unknown>): VolcengineConfig {
  return {
    voice_type: typeof config.voice_type === 'string' ? config.voice_type : DEFAULT_VOICE_TYPE,
    resource_id: resourceIdOf(config.resource_id),
    model: typeof config.model === 'string' ? config.model : '',
    format: formatOf(config.format),
    sample_rate: typeof config.sample_rate === 'number' ? config.sample_rate : 24000,
    speech_rate: typeof config.speech_rate === 'number' ? config.speech_rate : 0,
    loudness_rate: typeof config.loudness_rate === 'number' ? config.loudness_rate : 0,
    pitch: typeof config.pitch === 'number' ? config.pitch : 0,
    bilingual: 'both',
    voices: {},
  }
}

/**
 * volcengine TTS provider。API key 从环境变量 {@link VOLCENGINE_API_KEY_REF}
 * 读取(开发期由 dsh 从 `.env` 加载);最终发布版改走 credentials-local。
 */
export class VolcengineTtsProvider implements TtsProvider {
  readonly id = 'volcengine'
  readonly configTemplate = VOLCENGINE_CONFIG_TEMPLATE

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const apiKey = process.env[VOLCENGINE_API_KEY_REF]
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error(`missing API key: set ${VOLCENGINE_API_KEY_REF} in .env or the environment`)
    }
    return synthesizeVolcengine(resolveConfig(request.config), apiKey, request.text)
  }

  listVoices(): readonly TtsVoice[] {
    return VOLCENGINE_VOICES
  }
}
