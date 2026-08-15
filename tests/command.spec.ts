import { describe, expect, it } from 'vitest'
import {
  filterVoices,
  listVoicesText,
  parseTtsCommand,
  renderConfigTemplate,
  renderStatus,
} from '../src/command.js'
import type { TtsVoice, VoiceTtsSettings } from '../src/types.js'

const voice: TtsVoice = {
  voice_type: 'zh_female_vv_uranus_bigtts',
  name: 'Vivi 2.0',
  scene: '通用场景',
  lang: '中文',
  ability: '指令遵循',
  group: 'standard',
}

describe('parseTtsCommand', () => {
  it('treats empty input and status as status', () => {
    expect(parseTtsCommand('')).toEqual({ kind: 'status' })
    expect(parseTtsCommand('  status  ')).toEqual({ kind: 'status' })
  })

  it('parses help', () => {
    expect(parseTtsCommand('help')).toEqual({ kind: 'help' })
  })

  it('parses list-voices with provider and query', () => {
    expect(parseTtsCommand('list-voices')).toEqual({ kind: 'list-voices', provider: 'volcengine', query: '' })
    expect(parseTtsCommand('list-voices volcengine vivi')).toEqual({ kind: 'list-voices', provider: 'volcengine', query: 'vivi' })
  })

  it('parses config --template with a default provider', () => {
    expect(parseTtsCommand('config --template')).toEqual({ kind: 'config-template', provider: 'volcengine' })
    expect(parseTtsCommand('config --template volcengine')).toEqual({ kind: 'config-template', provider: 'volcengine' })
  })

  it('preserves JSON verbatim after --json (no whitespace splitting)', () => {
    expect(parseTtsCommand('config --json {"voice_type":"zh_male_a","format":"mp3"}'))
      .toEqual({ kind: 'config-json', json: '{"voice_type":"zh_male_a","format":"mp3"}' })
    // JSON with spaces must survive intact.
    expect(parseTtsCommand('config --json { "voice_type": "x", "sample_rate": 16000 }'))
      .toEqual({ kind: 'config-json', json: '{ "voice_type": "x", "sample_rate": 16000 }' })
  })

  it('parses speak with free text', () => {
    expect(parseTtsCommand('speak 你好，世界')).toEqual({ kind: 'speak', text: '你好，世界' })
  })

  it('falls back to help for unknown subcommands', () => {
    expect(parseTtsCommand('bogus')).toEqual({ kind: 'help' })
    expect(parseTtsCommand('config --nope')).toEqual({ kind: 'help' })
  })
})

describe('filterVoices', () => {
  it('returns all when query is empty', () => {
    expect(filterVoices([voice], '')).toHaveLength(1)
  })

  it('matches voice_type, name, scene, lang case-insensitively', () => {
    expect(filterVoices([voice], 'VIVI')).toHaveLength(1)
    expect(filterVoices([voice], '通用')).toHaveLength(1)
    expect(filterVoices([voice], '中文')).toHaveLength(1)
    expect(filterVoices([voice], 'nomatch')).toHaveLength(0)
  })
})

describe('listVoicesText', () => {
  it('renders a header and row', () => {
    const text = listVoicesText([voice], 'volcengine')
    expect(text).toContain('volcengine voices (1)')
    expect(text).toContain('voice_type')
    expect(text).toContain('zh_female_vv_uranus_bigtts')
  })
})

describe('renderStatus', () => {
  const settings: VoiceTtsSettings = {
    autoplay: false,
    provider: 'volcengine',
    providers: {
      volcengine: {
        voice_type: 'zh_female_vv_uranus_bigtts',
        resource_id: 'seed-tts-2.0',
        model: '',
        format: 'mp3',
        sample_rate: 24000,
        speech_rate: 0,
        loudness_rate: 0,
        pitch: 0,
        bilingual: 'both',
        voices: {},
      },
    },
  }

  it('reports provider, autoplay, and config', () => {
    const text = renderStatus(settings, ['volcengine'])
    expect(text).toContain('provider:  volcengine')
    expect(text).toContain('autoplay:  false')
    expect(text).toContain('voice_type:   zh_female_vv_uranus_bigtts')
  })
})

describe('renderConfigTemplate', () => {
  it('includes the full field set with defaults', () => {
    const template = renderConfigTemplate()
    const parsed = JSON.parse(template) as { provider: string; config: Record<string, unknown>; credentials: { apiKeyRef: string } }
    expect(parsed.provider).toBe('volcengine')
    expect(Object.keys(parsed.config)).toEqual([
      'voice_type', 'resource_id', 'model', 'format', 'sample_rate', 'speech_rate', 'loudness_rate', 'pitch', 'bilingual', 'voices',
    ])
    expect(parsed.credentials.apiKeyRef).toBe('VOLCENGINE_TTS_API_KEY')
  })
})
