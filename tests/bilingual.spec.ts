import { describe, expect, it } from 'vitest'
import {
  analyzeBilingual,
  classifySentence,
  concatAudio,
  effectiveVoices,
  filterSentences,
  planBilingualSpeech,
  scriptRuns,
  segmentSentences,
  suppressBySeparators,
  suppressSegments,
  voiceFor,
} from '../src/bilingual.js'
import type { VolcengineConfig } from '../src/types.js'

const base: VolcengineConfig = {
  voice_type: 'zh_default',
  resource_id: 'seed-tts-2.0',
  model: '',
  format: 'mp3',
  play_format: 'wav',
  sample_rate: 24000,
  speech_rate: 0,
  loudness_rate: 0,
  pitch: 0,
  bilingual: 'both',
  segment_strategy: 'sentence',
  segment_threshold: 5,
  segment_separators: '',
  voices: {},
  voice_profiles: {},
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

  it('splits mixed Chinese and English by terminal punctuation', () => {
    expect(segmentSentences('这段是中文。This is a sentence. 又是中文。')).toEqual([
      '这段是中文。', 'This is a sentence.', '又是中文。',
    ])
  })

  it('keeps newline content within a sentence (newline is not a boundary)', () => {
    expect(segmentSentences('第一行\n第二行。')).toEqual(['第一行\n第二行。'])
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

  it('keeps only English in english_only', () => {
    const kept = filterSentences(sentences, 'english_only')
    expect(kept.map(s => s.lang)).toEqual(['en'])
  })

  it('keeps only Chinese in chinese_only', () => {
    const kept = filterSentences(sentences, 'chinese_only')
    expect(kept.map(s => s.lang)).toEqual(['zh'])
  })

  it('drops a newline-spanning mixed sentence in language-only modes', () => {
    const newlineMixed = analyzeBilingual('中文内容\nEnglish content')
    expect(newlineMixed.map(s => s.lang)).toEqual(['mixed'])
    expect(filterSentences(newlineMixed, 'english_only')).toEqual([])
    expect(filterSentences(newlineMixed, 'chinese_only')).toEqual([])
  })
})

describe('voiceFor', () => {
  it('falls back to voice_type when no per-language voice is set', () => {
    expect(voiceFor('zh', base)).toBe('zh_default')
    expect(voiceFor('en', base)).toBe('zh_default')
    expect(voiceFor('mixed', base)).toBe('zh_default')
  })

  it('uses per-language voices and mixed falls back to zh then voice_type', () => {
    const cfg = { ...base, voices: { zh: { voice_type: 'zh_voice' }, en: { voice_type: 'en_voice' } } }
    expect(voiceFor('zh', cfg)).toBe('zh_voice')
    expect(voiceFor('en', cfg)).toBe('en_voice')
    expect(voiceFor('mixed', cfg)).toBe('zh_voice')

    const mixedOnly = { ...base, voices: { mixed: { voice_type: 'mixed_voice' } } }
    expect(voiceFor('mixed', mixedOnly)).toBe('mixed_voice')
  })

  it('falls back to voice_type when a slot has an empty voice_type', () => {
    const cfg = { ...base, voices: { zh: { voice_type: '' } } }
    expect(voiceFor('zh', cfg)).toBe('zh_default')
  })
})

describe('effectiveVoices / per-voice profiles', () => {
  it('falls back to default voices when voiceId is undefined', () => {
    const cfg = { ...base, voices: { zh: { voice_type: 'zh_default' } } }
    expect(effectiveVoices(cfg, undefined)).toEqual({ zh: { voice_type: 'zh_default' } })
  })

  it('returns the profile when voiceId matches, else falls back', () => {
    const cfg = {
      ...base,
      voices: { zh: { voice_type: 'zh_default' } },
      voice_profiles: { 'steve-jobs': { zh: { voice_type: 'zh_male' }, en: { voice_type: 'en_male' } } },
    }
    expect(effectiveVoices(cfg, 'steve-jobs')).toEqual({ zh: { voice_type: 'zh_male' }, en: { voice_type: 'en_male' } })
    expect(effectiveVoices(cfg, 'unknown-id')).toEqual({ zh: { voice_type: 'zh_default' } })
  })

  it('plan uses the matched profile voices', () => {
    const cfg = {
      ...base,
      voice_profiles: { 'steve-jobs': { zh: { voice_type: 'zh_male' }, en: { voice_type: 'en_male' } } },
    }
    const plan = planBilingualSpeech('中文句。English sentence.', cfg, 'steve-jobs')
    expect(plan.runs.map(r => r.voice)).toEqual(['zh_male', 'en_male'])
  })
})

describe('planBilingualSpeech', () => {
  it('groups consecutive same-voice sentences and reports stats', () => {
    const cfg = { ...base, voices: { zh: { voice_type: 'zh_v' }, en: { voice_type: 'en_v' } }, bilingual: 'both' as const }
    const plan = planBilingualSpeech('中文一句。中文二句。English one. English two. 混合 mixed 句。', cfg)
    expect(plan.total).toBe(5)
    expect(plan.spoken).toBe(5)
    expect(plan.byLang).toEqual({ zh: 2, en: 2, mixed: 1 })
    // 2 zh merged, 2 en merged, 1 mixed = 3 runs
    expect(plan.runs.map(r => r.voice)).toEqual(['zh_v', 'en_v', 'zh_v'])
    expect(plan.runs.map(r => r.count)).toEqual([2, 2, 1])
  })

  it('filters out mixed sentences in language-only modes', () => {
    const cfg = { ...base, bilingual: 'english_only' as const }
    const plan = planBilingualSpeech('中文句。English sentence. 混合 mixed 句。', cfg)
    expect(plan.spoken).toBe(1)
    expect(plan.byLang).toEqual({ zh: 0, en: 1, mixed: 0 })
  })

  it('returns zero runs when the filter drops everything', () => {
    const cfg = { ...base, bilingual: 'english_only' as const }
    const plan = planBilingualSpeech('纯中文一句。', cfg)
    expect(plan.runs).toHaveLength(0)
    expect(plan.spoken).toBe(0)
  })

  it('carries slot tunable params onto the run', () => {
    const cfg = {
      ...base,
      voices: { en: { voice_type: 'en_v', loudness_rate: 40, speech_rate: 10 } },
    }
    const plan = planBilingualSpeech('English one. English two.', cfg)
    expect(plan.runs).toHaveLength(1)
    expect(plan.runs[0]!.params).toEqual({ loudness_rate: 40, speech_rate: 10 })
  })

  it('does not merge same-voice sentences with different params', () => {
    const cfg = {
      ...base,
      voices: {
        zh: { voice_type: 'zh_v', loudness_rate: 0 },
        en: { voice_type: 'zh_v', loudness_rate: 40 },
      },
    }
    // zh 与 en 两个槽位都是同一音色 voice_type=zh_v,但 loudness_rate 不同,须拆两次。
    const plan = planBilingualSpeech('中文句。English sentence.', cfg)
    expect(plan.runs.map(r => r.voice)).toEqual(['zh_v', 'zh_v'])
    expect(plan.runs.map(r => r.params)).toEqual([{ loudness_rate: 0 }, { loudness_rate: 40 }])
  })
})

describe('scriptRuns', () => {
  it('groups consecutive same-script characters, skipping separators', () => {
    const runs = scriptRuns('大家好。Hello world. 继续')
    expect(runs.map(r => ({ text: r.text, script: r.script, scriptChars: r.scriptChars }))).toEqual([
      { text: '大家好。', script: 'zh', scriptChars: 3 },
      { text: 'Hello world. ', script: 'en', scriptChars: 10 },
      { text: '继续', script: 'zh', scriptChars: 2 },
    ])
  })

  it('keeps offsets aligned with the source text', () => {
    const runs = scriptRuns('a 好b')
    expect(runs.map(r => [r.start, r.end])).toEqual([[0, 2], [2, 3], [3, 4]])
  })

  it('returns no runs for text without CJK or Latin', () => {
    expect(scriptRuns(' .,。')).toEqual([])
  })
})

describe('suppressSegments', () => {
  it('drops a short English run sandwiched by Chinese', () => {
    expect(suppressSegments('大家好。Fox. 继续。', 5)).toBe('大家好。继续。')
  })

  it('keeps a long English run (not a short interjection)', () => {
    expect(suppressSegments('大家好。The quick brown fox jumps. 继续。', 5)).toBe('大家好。The quick brown fox jumps. 继续。')
  })

  it('keeps runs at either text edge (not sandwiched)', () => {
    expect(suppressSegments('The quick fox. 大家好。', 5)).toBe('The quick fox. 大家好。')
    expect(suppressSegments('大家好。The quick fox.', 5)).toBe('大家好。The quick fox.')
  })

  it('honors the threshold', () => {
    expect(suppressSegments('大家好。Fox. 继续。', 2)).toBe('大家好。Fox. 继续。')
    expect(suppressSegments('大家好。The fox. 继续。', 10)).toBe('大家好。继续。')
  })
})

describe('suppressBySeparators', () => {
  it('suppresses interjections inside each window independently', () => {
    expect(suppressBySeparators('中文一|中文 Fox. 中文|继续', '|', 5)).toBe('中文一|中文 中文|继续')
  })

  it('treats the window edge as text edge (no sandwich across windows)', () => {
    expect(suppressBySeparators('中文一|Fox. 中文|继续', '|', 5)).toBe('中文一|Fox. 中文|继续')
  })

  it('returns the text unchanged when the separator never matches', () => {
    expect(suppressBySeparators('中文 Fox. 中文', '|', 5)).toBe('中文 Fox. 中文')
    expect(suppressBySeparators('中文 Fox. 中文', '', 5)).toBe('中文 Fox. 中文')
  })

  it('supports multi-character separators', () => {
    expect(suppressBySeparators('甲||乙 Fox. 乙||丙', '||', 5)).toBe('甲||乙 乙||丙')
  })
})

describe('planBilingualSpeech · segment strategy off', () => {
  it('returns the whole text as a single run with the unified voice', () => {
    const cfg = { ...base, segment_strategy: 'off' as const }
    const plan = planBilingualSpeech('大家好。Fox. 继续。', cfg)
    expect(plan.runs).toHaveLength(1)
    expect(plan.runs[0]).toMatchObject({ voice: 'zh_default', count: 1, text: '大家好。Fox. 继续。' })
    expect(plan.total).toBe(1)
    expect(plan.spoken).toBe(1)
  })

  it('ignores the bilingual filter (reads everything)', () => {
    const cfg = { ...base, bilingual: 'english_only' as const, segment_strategy: 'off' as const }
    const plan = planBilingualSpeech('纯中文一句。', cfg)
    expect(plan.spoken).toBe(1)
  })
})

describe('planBilingualSpeech · segment strategy script-run', () => {
  const scriptCfg = { ...base, segment_strategy: 'script-run' as const }

  it('skips a short English interjection sentence', () => {
    const plan = planBilingualSpeech('大家好。Fox. 继续。', scriptCfg)
    expect(plan.spoken).toBe(2)
    expect(plan.runs).toHaveLength(1)
    expect(plan.runs[0]).toMatchObject({ count: 2, text: '大家好。 继续。' })
  })

  it('keeps a long English sentence and mixes by voice', () => {
    const cfg = { ...scriptCfg, voices: { zh: { voice_type: 'zh_v' }, en: { voice_type: 'en_v' } } }
    const plan = planBilingualSpeech('大家好。The quick brown fox jumps. 继续。', cfg)
    expect(plan.spoken).toBe(3)
    expect(plan.runs.map(r => r.voice)).toEqual(['zh_v', 'en_v', 'zh_v'])
  })

  it('does not suppress in language-only modes (strict filter unchanged)', () => {
    const cfg = { ...scriptCfg, bilingual: 'english_only' as const }
    const plan = planBilingualSpeech('大家好。Fox. 继续。', cfg)
    expect(plan.spoken).toBe(1)
    expect(plan.runs.map(r => r.text)).toEqual(['Fox.'])
  })
})

describe('planBilingualSpeech · segment strategy custom-separator', () => {
  const sepCfg = { ...base, segment_strategy: 'custom-separator' as const, segment_separators: '|' }

  it('suppresses interjections inside matched windows', () => {
    const plan = planBilingualSpeech('甲。|中文 Fox. 中文。|乙。', sepCfg)
    expect(plan.spoken).toBe(3)
    expect(plan.runs.map(r => r.text).join('')).not.toContain('Fox')
  })

  it('falls back to sentence-level when the separator never matches', () => {
    const plan = planBilingualSpeech('甲。中文 Fox. 中文。', sepCfg)
    expect(plan.spoken).toBe(3)
    expect(plan.runs.map(r => r.text).join('')).toContain('Fox')
  })
})

describe('concatAudio', () => {
  it('concatenates byte arrays in order', () => {
    const out = concatAudio([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])])
    expect([...out]).toEqual([1, 2, 3, 4, 5])
  })
})
