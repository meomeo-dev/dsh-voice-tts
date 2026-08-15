/**
 * siliconflow 预设音色表(权威见 https://api-docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech)。
 * 系统预设音色仅 CosyVoice2-0.5B 的 8 个;`voice_type` 用「模型:音色名」前缀形式。
 * @module dsh-voice-tts/siliconflow-voices
 */

import type { TtsVoice } from './types.js'

const MODEL = 'FunAudioLLM/CosyVoice2-0.5B'

/** CosyVoice2-0.5B 的 8 个系统预设音色。 */
export const SILICONFLOW_VOICES: readonly TtsVoice[] = [
  { voice_type: `${MODEL}:alex`, name: 'alex', scene: '通用场景', lang: '多语种', ability: '沉稳男声', group: 'standard' },
  { voice_type: `${MODEL}:benjamin`, name: 'benjamin', scene: '通用场景', lang: '多语种', ability: '低沉男声', group: 'standard' },
  { voice_type: `${MODEL}:charles`, name: 'charles', scene: '通用场景', lang: '多语种', ability: '磁性男声', group: 'standard' },
  { voice_type: `${MODEL}:david`, name: 'david', scene: '通用场景', lang: '多语种', ability: '欢快男声', group: 'standard' },
  { voice_type: `${MODEL}:anna`, name: 'anna', scene: '通用场景', lang: '多语种', ability: '沉稳女声', group: 'standard' },
  { voice_type: `${MODEL}:bella`, name: 'bella', scene: '通用场景', lang: '多语种', ability: '激情女声', group: 'standard' },
  { voice_type: `${MODEL}:claire`, name: 'claire', scene: '通用场景', lang: '多语种', ability: '温柔女声', group: 'standard' },
  { voice_type: `${MODEL}:diana`, name: 'diana', scene: '通用场景', lang: '多语种', ability: '欢快女声', group: 'standard' },
]
