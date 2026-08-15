/**
 * 双语文本的切分、语言判定、bilingual 过滤与音色规划(纯函数,不 import cordis)。
 * 规则(对齐 design.md §bilingual):
 * - 连续双语文本按句子/段落切分,每句判定 `zh`/`en`/`mixed`。
 * - `bilingual` 过滤:both 全读;english_only 读英文+混合;chinese_only 读中文+混合。
 * - 中英混写句永远整句读,不做过滤。
 * - 各语言类别可用不同音色(voices),缺省回退 voice_type。
 * @module dsh-voice-tts/bilingual
 */

import type { BilingualMode, SentenceLang, VoiceTtsVoices, VolcengineConfig } from './types.js'

/** 一句已判定语言的文本。 */
export interface BilingualSentence {
  readonly text: string
  readonly lang: SentenceLang
}

/** 一段连续同音色的待合成文本(相邻同音色句子已合并)。 */
export interface VoiceRun {
  readonly voice: string
  readonly lang: SentenceLang
  readonly text: string
  readonly count: number
}

/** 双语播报规划结果。 */
export interface BilingualPlan {
  /** 有序的音色分片(相邻同音色已合并)。 */
  readonly runs: readonly VoiceRun[]
  /** 过滤前的句子总数。 */
  readonly total: number
  /** 过滤后要播报的句子数。 */
  readonly spoken: number
  /** 各语言类别要播报的句子数。 */
  readonly byLang: Record<SentenceLang, number>
}

const CJK_RE = /[一-鿿]/
const LATIN_RE = /[A-Za-z]/
/** 中文全角句末符 + 英文 `!`/`?` 都是确定句界。 */
const TERMINAL = new Set(['。', '！', '？', '；', '!', '?'])
/** 英文常见缩写(其后的 `.` 不是句界)。 */
const EN_ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'prof', 'rev', 'gen', 'vs', 'etc', 'eg', 'ie',
  'no', 'fig', 'inc', 'ltd', 'co', 'corp', 'approx', 'dept', 'est', 'vol', 'ed', 'pp', 'al',
])

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

function isLatin(ch: string | undefined): boolean {
  return ch !== undefined && LATIN_RE.test(ch)
}

/** 判断 `.` 前的单词是否英文缩写(单字母或命中缩写表)。 */
function isAbbrevPeriod(chars: readonly string[], i: number): boolean {
  let j = i - 1
  let word = ''
  while (j >= 0 && isLatin(chars[j])) {
    word = chars[j]! + word
    j--
  }
  if (word.length === 1) return true
  return EN_ABBREV.has(word.toLowerCase())
}

/** 判断 chars[i] 是否句界。 */
function isTerminal(chars: readonly string[], i: number): boolean {
  const ch = chars[i]
  if (ch === undefined) return false
  if (TERMINAL.has(ch)) return true
  if (ch !== '.') return false
  const prev = chars[i - 1]
  const next = chars[i + 1]
  if (next === '.') return false // 省略号 ".."
  if (isLatin(next)) return false // 词中/缩写 "e.g." "U.S." "github.com"
  if (isDigit(prev) && isDigit(next)) return false // 小数 "3.14"
  if (isAbbrevPeriod(chars, i)) return false // "Mr." "Dr." 等
  return true
}

/** 把文本切成句子(先按段落,段内按句末符)。 */
export function segmentSentences(text: string): string[] {
  const paragraphs = text.split(/\r?\n+/).map(paragraph => paragraph.trim()).filter(paragraph => paragraph.length > 0)
  const sentences: string[] = []
  for (const paragraph of paragraphs) {
    const chars = [...paragraph]
    let buffer = ''
    for (let i = 0; i < chars.length; i++) {
      buffer += chars[i]
      if (isTerminal(chars, i)) {
        const sentence = buffer.trim()
        if (sentence.length > 0) sentences.push(sentence)
        buffer = ''
      }
    }
    const tail = buffer.trim()
    if (tail.length > 0) sentences.push(tail)
  }
  return sentences
}

/** 判定一句文本的语言类别。 */
export function classifySentence(sentence: string): SentenceLang {
  let cjk = 0
  let latin = 0
  for (const ch of sentence) {
    if (CJK_RE.test(ch)) cjk++
    else if (LATIN_RE.test(ch)) latin++
  }
  if (latin === 0) return 'zh'
  if (cjk === 0) return 'en'
  return 'mixed'
}

/** 切分并判定语言。 */
export function analyzeBilingual(text: string): BilingualSentence[] {
  return segmentSentences(text).map(sentence => ({ text: sentence, lang: classifySentence(sentence) }))
}

/** 按 bilingual 模式过滤句子(混合句永远保留)。 */
export function filterSentences(
  sentences: readonly BilingualSentence[],
  mode: BilingualMode,
): BilingualSentence[] {
  if (mode === 'both') return [...sentences]
  const keep = mode === 'english_only' ? 'en' : 'zh'
  return sentences.filter(sentence => sentence.lang === 'mixed' || sentence.lang === keep)
}

/**
 * 解析某语言类别应使用的音色(先 per-voice profile,再缺省 voices,最后 voice_type)。
 * @param lang - 语言类别。
 * @param voices - 已解析的音色覆盖(可能来自 voice_profiles 或缺省 voices)。
 * @param fallback - voice_type 兜底。
 */
function voiceForVoices(lang: SentenceLang, voices: VoiceTtsVoices, fallback: string): string {
  if (lang === 'zh') return voices.zh || fallback
  if (lang === 'en') return voices.en || fallback
  return voices.mixed || voices.zh || fallback
}

/**
 * 解析某语言类别应使用的音色(缺省 voices)。
 * @param lang - 语言类别。
 * @param config - volcengine 配置。
 */
export function voiceFor(lang: SentenceLang, config: VolcengineConfig): string {
  return voiceForVoices(lang, config.voices, config.voice_type)
}

/**
 * 解析某语言类别在当前 voice id 下的最终音色:先 per-voice profile,再缺省
 * voices,最后 voice_type。与 {@link planBilingualSpeech} 的分配规则同源
 * (status 预览用),避免两处漂移。
 * @param lang - 语言类别。
 * @param config - volcengine 配置。
 * @param voiceId - 当前 dsh-voice 的 voice id;无则走缺省 voices。
 */
export function resolvedVoice(lang: SentenceLang, config: VolcengineConfig, voiceId?: string): string {
  return voiceForVoices(lang, effectiveVoices(config, voiceId), config.voice_type)
}

/**
 * 命中当前 voice id 时返回 per-voice 音色覆盖,否则回退缺省 voices。
 * @param config - volcengine 配置。
 * @param voiceId - 当前 dsh-voice 的 voice id(如 `steve-jobs`);无则用缺省。
 * @returns 生效的音色覆盖。
 */
export function effectiveVoices(config: VolcengineConfig, voiceId: string | undefined): VoiceTtsVoices {
  if (voiceId !== undefined) {
    const profile = config.voice_profiles[voiceId]
    if (profile !== undefined) return profile
  }
  return config.voices
}

/** 规划双语播报:过滤后按语言分配音色,相邻同音色句子合并为一个分片。 */
export function planBilingualSpeech(
  text: string,
  config: VolcengineConfig,
  voiceId?: string,
): BilingualPlan {
  const voices = effectiveVoices(config, voiceId)
  const sentences = analyzeBilingual(text)
  const selected = filterSentences(sentences, config.bilingual)
  const runs: VoiceRun[] = []
  const byLang: Record<SentenceLang, number> = { zh: 0, en: 0, mixed: 0 }
  for (const sentence of selected) {
    byLang[sentence.lang]++
    const voice = voiceForVoices(sentence.lang, voices, config.voice_type)
    const last = runs[runs.length - 1]
    if (last !== undefined && last.voice === voice) {
      runs[runs.length - 1] = { voice, lang: sentence.lang, text: `${last.text} ${sentence.text}`, count: last.count + 1 }
    } else {
      runs.push({ voice, lang: sentence.lang, text: sentence.text, count: 1 })
    }
  }
  return { runs, total: sentences.length, spoken: selected.length, byLang }
}

/** 拼接多个音频字节段。 */
export function concatAudio(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
