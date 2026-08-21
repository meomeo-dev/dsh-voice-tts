/**
 * 双语文本的切分、语言判定、bilingual 过滤与音色规划(纯函数,不 import cordis)。
 * 规则(对齐 design.md §bilingual):
 * - 连续双语文本用 sentence-splitter 按句末符切句(同时正确处理中英文句界,
 *   选型见 docs/sentence-splitting-selection.md),每句判定 `zh`/`en`/`mixed`。
 * - `bilingual` 过滤:both 全读;english_only 只读英文;chinese_only 只读中文。
 * - 中英混写句仅在 `both` 模式保留,语言限定模式会过滤。
 * - 各语言类别可用不同音色(voices),缺省回退 voice_type。
 * @module dsh-voice-tts/bilingual
 */

import { split as splitSentences } from 'sentence-splitter'
import type { BilingualMode, BilingualVoiceConfig, SentenceLang, VoiceSlot, VoiceTtsVoices } from './types.js'

/** 一句已判定语言的文本。 */
export interface BilingualSentence {
  readonly text: string
  readonly lang: SentenceLang
}

/** 一段连续同音色且同参数的待合成文本(相邻同音色同参数句子已合并)。 */
export interface VoiceRun {
  readonly voice: string
  readonly lang: SentenceLang
  readonly text: string
  readonly count: number
  /** 该分片携带的槽位可调参数覆盖(仅数值键);合成时展开覆盖 provider 顶层同名字段。 */
  readonly params: Record<string, number>
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

/** 一个连续同脚本区段(空白与标点跳过但不打断区段,归入前一个区段的文本)。 */
export interface ScriptRun {
  /** 区段文本(含跳过但未打断的空白/标点)。 */
  readonly text: string
  /** 区段脚本类别:`zh` CJK / `en` Latin。 */
  readonly script: 'zh' | 'en'
  /** 区段内的脚本字符数(空白/标点不计)。 */
  readonly scriptChars: number
  /** 区段在原文中的起止 UTF-16 偏移(含跳过字符)。 */
  readonly start: number
  readonly end: number
}

/**
 * 扫描连续同脚本区段:复用 `classifySentence` 的 `[一-鿿]`/`[A-Za-z]` 字符集,
 * 空白与标点跳过但不打断区段。区段是“夹杂判定”的输入,不拆散 mixed 句。
 * @param text - 待扫描文本。
 * @returns 按序的脚本区段数组。
 */
export function scriptRuns(text: string): ScriptRun[] {
  const runs: ScriptRun[] = []
  let current: { text: string; script: 'zh' | 'en'; scriptChars: number; start: number; end: number } | null = null
  let position = 0
  for (const ch of text) {
    const width = ch.length
    if (CJK_RE.test(ch)) {
      if (current === null || current.script !== 'zh') {
        current = { text: '', script: 'zh', scriptChars: 0, start: position, end: position }
        runs.push(current)
      }
      current.text += ch
      current.scriptChars++
    } else if (LATIN_RE.test(ch)) {
      if (current === null || current.script !== 'en') {
        current = { text: '', script: 'en', scriptChars: 0, start: position, end: position }
        runs.push(current)
      }
      current.text += ch
      current.scriptChars++
    } else if (current !== null) {
      current.text += ch
    }
    if (current !== null) current.end = position + width
    position += width
  }
  return runs.map(run => ({ ...run }))
}

/** 判定区段是否夹杂:脚本字符数 ≤ 阈值,且左右都被异语言区段夹持。 */
function isSuppressedRun(runs: readonly ScriptRun[], index: number, threshold: number): boolean {
  const run = runs[index]
  if (run === undefined || run.scriptChars > threshold) return false
  const prev = runs[index - 1]
  const next = runs[index + 1]
  return prev !== undefined && next !== undefined
    && prev.script !== run.script && next.script !== run.script
}

/**
 * 挖掉被抑制的夹杂区段(策略 3「script-run」):区段脚本字符数 ≤ 阈值且被异语言
 * 区段夹持 → 从文本中移除,剩余文本再走句子级管线。
 * @param text - 待处理文本。
 * @param threshold - 夹杂区段长度阈值。
 * @returns 移除夹杂区段后的文本(无夹杂时原样返回)。
 */
export function suppressSegments(text: string, threshold: number): string {
  const runs = scriptRuns(text)
  const suppressed = new Set<ScriptRun>(runs.filter((_, i) => isSuppressedRun(runs, i, threshold)))
  if (suppressed.size === 0) return text
  const parts: string[] = []
  let cursor = 0
  for (const run of runs) {
    if (suppressed.has(run)) {
      cursor = run.end
      continue
    }
    if (run.start > cursor) parts.push(text.slice(cursor, run.start))
    parts.push(run.text)
    cursor = run.end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.join('')
}

/**
 * 按自定义分段符切窗口,窗口内独立做夹杂抑制(策略 4「custom-separator」):
 * 窗口边界即文本边界——窗口内首/末区段不判夹持。分段符无命中时原样返回
 * (退化为句子级切分,不引入额外窗口)。
 * @param text - 待处理文本。
 * @param separators - 自定义分段符(任一命中即切窗口;空串 = 无命中)。
 * @param threshold - 夹杂区段长度阈值(复用策略 3 的判定)。
 * @returns 各窗口抑制后的文本(保留分段符)。
 */
export function suppressBySeparators(text: string, separators: string, threshold: number): string {
  if (separators === '' || !text.includes(separators)) return text
  return text.split(separators).map(part => suppressSegments(part, threshold)).join(separators)
}

/** 把文本切成句子(sentence-splitter,中英双语句界)。 */
export function segmentSentences(text: string): string[] {
  return splitSentences(text)
    .filter(node => node.type === 'Sentence')
    .map(node => node.raw.trim())
    .filter(sentence => sentence.length > 0)
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

/** 按 bilingual 模式过滤句子(语言限定模式不保留混合句)。 */
export function filterSentences(
  sentences: readonly BilingualSentence[],
  mode: BilingualMode,
): BilingualSentence[] {
  if (mode === 'both') return [...sentences]
  const keep = mode === 'english_only' ? 'en' : 'zh'
  return sentences.filter(sentence => sentence.lang === keep)
}

/**
 * 解析某语言类别应使用的音色(先 per-voice profile,再缺省 voices,最后 voice_type)。
 * @param lang - 语言类别。
 * @param voices - 已解析的音色槽位覆盖(可能来自 voice_profiles 或缺省 voices)。
 * @param fallback - voice_type 兜底。
 */
function voiceForVoices(lang: SentenceLang, voices: VoiceTtsVoices, fallback: string): string {
  if (lang === 'zh') return voices.zh?.voice_type || fallback
  if (lang === 'en') return voices.en?.voice_type || fallback
  return voices.mixed?.voice_type || voices.zh?.voice_type || fallback
}

/**
 * 提取某槽位携带的可调参数(仅数值键,排除 `voice_type`)。槽位未写的参数回退
 * provider 顶层字段,故此处只返回显式配置的覆盖值。
 * @param slot - 语言类别槽位。
 * @returns 参数覆盖映射(键随 provider,如 `loudness_rate` / `speed`)。
 */
function slotParams(slot: VoiceSlot | undefined): Record<string, number> {
  if (slot === undefined) return {}
  const params: Record<string, number> = {}
  for (const [key, value] of Object.entries(slot)) {
    if (key === 'voice_type') continue
    if (typeof value === 'number') params[key] = value
  }
  return params
}

/** 比较两个参数覆盖映射是否相等(键序无关,键集一致即相等)。 */
function paramsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every(key => a[key] === b[key])
}

/**
 * 解析某语言类别应使用的音色(缺省 voices)。
 * @param lang - 语言类别。
 * @param config - volcengine 配置。
 */
export function voiceFor(lang: SentenceLang, config: BilingualVoiceConfig): string {
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
export function resolvedVoice(lang: SentenceLang, config: BilingualVoiceConfig, voiceId?: string): string {
  return voiceForVoices(lang, effectiveVoices(config, voiceId), config.voice_type)
}

/**
 * 命中当前 voice id 时返回 per-voice 音色覆盖,否则回退缺省 voices。
 * @param config - volcengine 配置。
 * @param voiceId - 当前 dsh-voice 的 voice id(如 `steve-jobs`);无则用缺省。
 * @returns 生效的音色覆盖。
 */
export function effectiveVoices(config: BilingualVoiceConfig, voiceId: string | undefined): VoiceTtsVoices {
  if (voiceId !== undefined) {
    const profile = config.voice_profiles[voiceId]
    if (profile !== undefined) return profile
  }
  return config.voices
}

/**
 * 规划双语播报:按 `segment_strategy` 切分/抑制后,过滤并按语言分配音色,
 * 相邻同音色且同参数的句子合并为一个分片。
 * - `off`:整段单一 VoiceRun,不做语言判定与抑制(忽略 bilingual 过滤)。
 * - `script-run` / `custom-separator`:夹杂抑制只在 `both` 生效,语言限定模式
 *   保持现状严格过滤。
 */
export function planBilingualSpeech(
  text: string,
  config: BilingualVoiceConfig,
  voiceId?: string,
): BilingualPlan {
  const voices = effectiveVoices(config, voiceId)
  if (config.segment_strategy === 'off') {
    const lang = classifySentence(text)
    const byLang: Record<SentenceLang, number> = { zh: 0, en: 0, mixed: 0 }
    byLang[lang] = 1
    return {
      runs: [{
        voice: voiceForVoices('zh', voices, config.voice_type),
        lang,
        text,
        count: 1,
        params: slotParams(voices.zh),
      }],
      total: 1,
      spoken: 1,
      byLang,
    }
  }
  let speechText = text
  if (config.bilingual === 'both') {
    if (config.segment_strategy === 'script-run') {
      speechText = suppressSegments(text, config.segment_threshold)
    } else if (config.segment_strategy === 'custom-separator') {
      speechText = suppressBySeparators(text, config.segment_separators, config.segment_threshold)
    }
  }
  const sentences = analyzeBilingual(speechText)
  const selected = filterSentences(sentences, config.bilingual)
  const runs: VoiceRun[] = []
  const byLang: Record<SentenceLang, number> = { zh: 0, en: 0, mixed: 0 }
  for (const sentence of selected) {
    byLang[sentence.lang]++
    const voice = voiceForVoices(sentence.lang, voices, config.voice_type)
    const params = slotParams(voices[sentence.lang])
    const last = runs[runs.length - 1]
    if (last !== undefined && last.voice === voice && paramsEqual(last.params, params)) {
      runs[runs.length - 1] = { voice, lang: sentence.lang, text: `${last.text} ${sentence.text}`, count: last.count + 1, params }
    } else {
      runs.push({ voice, lang: sentence.lang, text: sentence.text, count: 1, params })
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
