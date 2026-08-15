/**
 * siliconflow 预设音色表(权威见 https://api-docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech)。
 * CosyVoice2-0.5B 与 MOSS-TTSD-v0.5 共用同一套 8 个系统预设音色;`voice_type`
 * 用「模型:音色名」前缀形式(如 `FunAudioLLM/CosyVoice2-0.5B:alex`、
 * `fnlp/MOSS-TTSD-v0.5:alex`)。本表对每个模型各生成一份,供面板按模型联动过滤。
 * @module dsh-voice-tts/siliconflow-voices
 */

import type { TtsVoice } from './types.js'
import { SILICONFLOW_MODELS } from './siliconflow.js'

/** 8 个系统预设音色的共享定义(与模型无关)。 */
const VOICE_DEFS: ReadonlyArray<{ readonly voice: string; readonly ability: string }> = [
  { voice: 'alex', ability: '沉稳男声' },
  { voice: 'benjamin', ability: '低沉男声' },
  { voice: 'charles', ability: '磁性男声' },
  { voice: 'david', ability: '欢快男声' },
  { voice: 'anna', ability: '沉稳女声' },
  { voice: 'bella', ability: '激情女声' },
  { voice: 'claire', ability: '温柔女声' },
  { voice: 'diana', ability: '欢快女声' },
]

/** 每个模型各一份的预设音色(CosyVoice2 + MOSS-TTSD 共 16 条)。 */
export const SILICONFLOW_VOICES: readonly TtsVoice[] = SILICONFLOW_MODELS.flatMap(model =>
  VOICE_DEFS.map(({ voice, ability }) => ({
    voice_type: `${model}:${voice}`,
    name: voice,
    scene: '通用场景',
    lang: '多语种',
    ability,
    group: 'standard',
  }))
)
