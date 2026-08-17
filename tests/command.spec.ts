import { describe, expect, it } from 'vitest'
import {
  filterVoices,
  listVoicesText,
  parseKeyCommand,
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

  it('parses ui', () => {
    expect(parseTtsCommand('ui')).toEqual({ kind: 'ui' })
  })

  it('falls back to help for unknown subcommands', () => {
    expect(parseTtsCommand('bogus')).toEqual({ kind: 'help' })
    expect(parseTtsCommand('config --nope')).toEqual({ kind: 'help' })
  })
})

describe('parseKeyCommand', () => {
  it('parses set with a non-empty value (no target)', () => {
    expect(parseKeyCommand('set sk-abc123')).toEqual({ kind: 'set', value: 'sk-abc123' })
  })

  it('parses set with an explicit provider', () => {
    expect(parseKeyCommand('set volcengine sk-abc123', ['volcengine', 'siliconflow-cn']))
      .toEqual({ kind: 'set', target: 'volcengine', value: 'sk-abc123' })
  })

  it('parses set with an explicit vendor target', () => {
    expect(parseKeyCommand('set 302ai-openai sk-abc123', ['volcengine', 'openai', '302ai-openai']))
      .toEqual({ kind: 'set', target: '302ai-openai', value: 'sk-abc123' })
  })

  it('parses unset with optional target', () => {
    expect(parseKeyCommand('unset')).toEqual({ kind: 'unset' })
    expect(parseKeyCommand('unset volcengine')).toEqual({ kind: 'unset', target: 'volcengine' })
  })

  it('treats empty and status as status', () => {
    expect(parseKeyCommand('')).toEqual({ kind: 'status' })
    expect(parseKeyCommand('status')).toEqual({ kind: 'status' })
    expect(parseKeyCommand('status volcengine')).toEqual({ kind: 'status', target: 'volcengine' })
  })

  it('falls back to status for malformed input', () => {
    expect(parseKeyCommand('set')).toEqual({ kind: 'status' })
    expect(parseKeyCommand('bogus')).toEqual({ kind: 'status' })
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
    delivery: 'off',
    provider: 'volcengine',
    vendors: {
      '302ai-openai': { label: '302AI', provider: 'openai', baseUrl: 'https://api.302.ai/v1', apiKeyRef: 'TTS_302AI_API_KEY' },
      '302ai-minimax': { label: '302AI', provider: 'minimax', baseUrl: 'https://api.302.ai/minimaxi/v1', apiKeyRef: 'TTS_302AI_API_KEY' },
    },
    storage: { scope: 'user', dir: '' },
    player: { command: '' },
    providers: {
      volcengine: {
        apiKeyRef: 'VOLCENGINE_TTS_API_KEY',
        voice_type: 'zh_female_vv_uranus_bigtts',
        resource_id: 'seed-tts-2.0',
        model: '',
        format: 'mp3',
        play_format: 'wav',
        sample_rate: 24000,
        speech_rate: 0,
        loudness_rate: 0,
        pitch: 0,
        bilingual: 'both',
        voices: {},
        voice_profiles: {},
      },
      'siliconflow-cn': {
        apiKeyRef: 'SILICONFLOW_API_KEY',
        voice_type: 'FunAudioLLM/CosyVoice2-0.5B:alex',
        model: 'FunAudioLLM/CosyVoice2-0.5B',
        format: 'mp3',
        play_format: 'wav',
        sample_rate: 32000,
        speed: 1,
        gain: 0,
        bilingual: 'both',
        voices: {},
        voice_profiles: {},
      },
      host: {
        command: '/usr/bin/say',
        voice_type: '',
        rate: 175,
        bilingual: 'both',
        voices: {},
        voice_profiles: {},
      },
      openai: {
        vendor: '302ai-openai',
        model: 'tts-1',
        voice_type: 'alloy',
        instructions: '',
        format: 'mp3',
        play_format: 'mp3',
        speed: 1,
        bilingual: 'both',
        voices: {},
        voice_profiles: {},
      },
      minimax: {
        vendor: '302ai-minimax',
        model: 'speech-2.8-turbo',
        voice_type: 'Chinese (Mandarin)_Reliable_Executive',
        speed: 1,
        vol: 1,
        pitch: 0,
        emotion: '',
        sample_rate: 32000,
        format: 'mp3',
        play_format: 'wav',
        bitrate: 128000,
        channel: 1,
        bilingual: 'both',
        voices: {},
        voice_profiles: {},
      },
    },
  }

  it('reports provider, delivery, and per-provider key refs', () => {
    const text = renderStatus(settings, ['volcengine', 'siliconflow-cn'])
    expect(text).toContain('provider:  volcengine')
    expect(text).toContain('delivery:  off')
    expect(text).toContain('apiKeyRef:  VOLCENGINE_TTS_API_KEY')
    expect(text).toContain('apiKeyRef:  SILICONFLOW_API_KEY')
    expect(text).toContain('voice_type: zh_female_vv_uranus_bigtts')
    expect(text).toContain('bilingual:  both')
  })

  it('reports vendor + apiKeyRef for openai/minimax (not a provider apiKeyRef)', () => {
    const text = renderStatus(settings, ['volcengine', 'siliconflow-cn', 'host', 'openai', 'minimax'])
    expect(text).toContain('vendor:     302ai-openai (302AI)')
    expect(text).toContain('apiKeyRef:  TTS_302AI_API_KEY')
    expect(text).toContain('vendor:     302ai-minimax (302AI)')
  })
})

describe('renderConfigTemplate', () => {
  it('renders the volcengine template with defaults', () => {
    const template = renderConfigTemplate('volcengine')
    const parsed = JSON.parse(template) as { provider: string; config: Record<string, unknown>; credentials: { apiKeyRef: string } }
    expect(parsed.provider).toBe('volcengine')
    expect(Object.keys(parsed.config)).toEqual([
      'voice_type', 'resource_id', 'model', 'format', 'play_format', 'sample_rate', 'speech_rate', 'loudness_rate', 'pitch', 'bilingual', 'voices', 'voice_profiles',
    ])
    expect(parsed.credentials.apiKeyRef).toBe('VOLCENGINE_TTS_API_KEY')
  })

  it('renders the siliconflow template', () => {
    const parsed = JSON.parse(renderConfigTemplate('siliconflow-cn')) as { provider: string; credentials: { apiKeyRef: string } }
    expect(parsed.provider).toBe('siliconflow-cn')
    expect(parsed.credentials.apiKeyRef).toBe('SILICONFLOW_API_KEY')
  })
})
