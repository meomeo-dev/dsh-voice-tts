import { describe, expect, it } from 'vitest'
import {
  analyzeBilingual,
  classifySentence,
  concatAudio,
  filterSentences,
  planBilingualSpeech,
  segmentSentences,
  voiceFor,
} from '../src/bilingual.js'
import type { VolcengineConfig } from '../src/types.js'

const base: VolcengineConfig = {
  voice_type: 'zh_default',
  resource_id: 'seed-tts-2.0',
  model: '',
  format: 'mp3',
  sample_rate: 24000,
  speech_rate: 0,
  loudness_rate: 0,
  pitch: 0,
  bilingual: 'both',
  voices: {},
}

describe('segmentSentences', () => {
  it('splits Chinese by full-width terminals', () => {
    expect(segmentSentences('这是第一句。这是第二句！')).toEqual(['这是第一句。', '这是第二句！'])
  })

  it('splits English by period, exclamation, question', () => {
    expect(segmentSentences('Hello world. This is English! Is it clear?')).toEqual([
      'Hello world.', 'This is English!', 'Is it clear?',
    ])
  })

  it('does not split English abbreviations and decimals', () => {
    expect(segmentSentences('Dr. Smith said 3.14 is pi. Done.')).toEqual([
      'Dr. Smith said 3.14 is pi.', 'Done.',
    ])
  })

  it('splits on newlines as paragraph boundaries', () => {
    expect(segmentSentences('第一行\n第二行。')).toEqual(['第一行', '第二行。'])
  })
})

describe('classifySentence', () => {
  it('classifies pure Chinese, pure English, and mixed', () => {
    expect(classifySentence('这是一个中文句子。')).toBe('zh')
    expect(classifySentence('This is an English sentence.')).toBe('en')
    expect(classifySentence('这是 mixed 混合句 with English.')).toBe('mixed')
  })
})

describe('filterSentences', () => {
  const sentences = analyzeBilingual('中文句。English sentence. 这是 mixed 混合句 with both。')

  it('keeps everything in both mode', () => {
    expect(filterSentences(sentences, 'both')).toHaveLength(3)
  })

  it('keeps English + mixed in english_only', () => {
    const kept = filterSentences(sentences, 'english_only')
    expect(kept.map(s => s.lang).sort()).toEqual(['en', 'mixed'])
  })

  it('keeps Chinese + mixed in chinese_only', () => {
    const kept = filterSentences(sentences, 'chinese_only')
    expect(kept.map(s => s.lang).sort()).toEqual(['mixed', 'zh'])
  })
})

describe('voiceFor', () => {
  it('falls back to voice_type when no per-language voice is set', () => {
    expect(voiceFor('zh', base)).toBe('zh_default')
    expect(voiceFor('en', base)).toBe('zh_default')
    expect(voiceFor('mixed', base)).toBe('zh_default')
  })

  it('uses per-language voices and mixed falls back to zh then voice_type', () => {
    const cfg = { ...base, voices: { zh: 'zh_voice', en: 'en_voice' } }
    expect(voiceFor('zh', cfg)).toBe('zh_voice')
    expect(voiceFor('en', cfg)).toBe('en_voice')
    expect(voiceFor('mixed', cfg)).toBe('zh_voice')

    const mixedOnly = { ...base, voices: { mixed: 'mixed_voice' } }
    expect(voiceFor('mixed', mixedOnly)).toBe('mixed_voice')
  })
})

describe('planBilingualSpeech', () => {
  it('groups consecutive same-voice sentences and reports stats', () => {
    const cfg = { ...base, voices: { zh: 'zh_v', en: 'en_v' }, bilingual: 'both' as const }
    const plan = planBilingualSpeech('中文一句。中文二句。English one. English two. 混合 mixed 句。', cfg)
    expect(plan.total).toBe(5)
    expect(plan.spoken).toBe(5)
    expect(plan.byLang).toEqual({ zh: 2, en: 2, mixed: 1 })
    // 2 zh merged, 2 en merged, 1 mixed = 3 runs
    expect(plan.runs.map(r => r.voice)).toEqual(['zh_v', 'en_v', 'zh_v'])
    expect(plan.runs.map(r => r.count)).toEqual([2, 2, 1])
  })

  it('filters by mode while always keeping mixed', () => {
    const cfg = { ...base, bilingual: 'english_only' as const }
    const plan = planBilingualSpeech('中文句。English sentence. 混合 mixed 句。', cfg)
    expect(plan.spoken).toBe(2)
    expect(plan.byLang).toEqual({ zh: 0, en: 1, mixed: 1 })
  })

  it('returns zero runs when the filter drops everything', () => {
    const cfg = { ...base, bilingual: 'english_only' as const }
    const plan = planBilingualSpeech('纯中文一句。', cfg)
    expect(plan.runs).toHaveLength(0)
    expect(plan.spoken).toBe(0)
  })
})

describe('concatAudio', () => {
  it('concatenates byte arrays in order', () => {
    const out = concatAudio([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])])
    expect([...out]).toEqual([1, 2, 3, 4, 5])
  })
})
