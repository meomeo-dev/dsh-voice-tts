/**
 * OpenAI TTS 音色表(内置参考,供 list-voices 与 config 校验)。
 * 数据来源:OpenAI Audio speech 官方文档(https://developers.openai.com/api/docs/guides/text-to-speech)。
 *
 * OpenAI 的 TTS 音色**不区分语言**:13 个音色都支持同一套「Whisper 语言」(57 种,
 * 含中文),官方仅注明「英文优化」。故 `lang` 用共享常量列出支持语言,让
 * `filterVoices` 搜索与未来 zh/en 槽位推荐都能命中「中文/英语」等关键词——而不是
 * 写无匹配价值的「多语种」。音色风格差异放 `ability`。
 * @module dsh-voice-tts/openai-voices
 */

import type { TtsVoice } from './types.js'

/** OpenAI TTS 全音色共用的支持语言(跟随 Whisper,官方 57 种;列主要 + 中英日韩,末尾注明)。 */
const OPENAI_LANGS = '中文、美式英语、英式英语、日语、韩语、德语、法语、西班牙语、葡萄牙语、俄语、意大利语、荷兰语、波兰语、阿拉伯语、土耳其语、印尼语、泰语、越南语、印地语、马来语（等 Whisper 57 种语言）'

/** gpt-4o-mini-tts 的 13 个音色(含 tts-1 系列没有的 ballad/verse/marin/cedar)。 */
export const OPENAI_GPT_4O_MINI_TTS_VOICES: readonly TtsVoice[] = [
  { voice_type: 'alloy', name: 'Alloy', scene: '通用场景', lang: OPENAI_LANGS, ability: '中性、多功能', group: 'standard' },
  { voice_type: 'ash', name: 'Ash', scene: '通用场景', lang: OPENAI_LANGS, ability: '低沉男声', group: 'standard' },
  { voice_type: 'ballad', name: 'Ballad', scene: '通用场景', lang: OPENAI_LANGS, ability: '英音男声', group: 'standard' },
  { voice_type: 'coral', name: 'Coral', scene: '通用场景', lang: OPENAI_LANGS, ability: '柔和中性', group: 'standard' },
  { voice_type: 'echo', name: 'Echo', scene: '通用场景', lang: OPENAI_LANGS, ability: '柔和男声', group: 'standard' },
  { voice_type: 'fable', name: 'Fable', scene: '通用场景', lang: OPENAI_LANGS, ability: '英音男声', group: 'standard' },
  { voice_type: 'nova', name: 'Nova', scene: '通用场景', lang: OPENAI_LANGS, ability: '温暖女声', group: 'standard' },
  { voice_type: 'onyx', name: 'Onyx', scene: '通用场景', lang: OPENAI_LANGS, ability: '深沉男声', group: 'standard' },
  { voice_type: 'sage', name: 'Sage', scene: '通用场景', lang: OPENAI_LANGS, ability: '睿智中性', group: 'standard' },
  { voice_type: 'shimmer', name: 'Shimmer', scene: '通用场景', lang: OPENAI_LANGS, ability: '温暖女声', group: 'standard' },
  { voice_type: 'verse', name: 'Verse', scene: '通用场景', lang: OPENAI_LANGS, ability: '有力男声', group: 'standard' },
  { voice_type: 'marin', name: 'Marin', scene: '通用场景', lang: OPENAI_LANGS, ability: '清亮女声', group: 'standard' },
  { voice_type: 'cedar', name: 'Cedar', scene: '通用场景', lang: OPENAI_LANGS, ability: '成熟男声', group: 'standard' },
]

/** tts-1 / tts-1-hd 共用的 9 个音色(gpt-4o-mini-tts 的子集)。 */
export const OPENAI_TTS_1_VOICES: readonly TtsVoice[] = OPENAI_GPT_4O_MINI_TTS_VOICES.filter(voice =>
  !['ballad', 'verse', 'marin', 'cedar'].includes(voice.voice_type))
