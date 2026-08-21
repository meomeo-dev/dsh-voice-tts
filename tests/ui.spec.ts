import { describe, expect, it, vi } from 'vitest'
import {
  ASSET_PREFIX,
  assetContentType,
  describeStatus,
  generatePanelToken,
  handlePanelRpc,
  PANEL_CHANNEL,
  PANEL_PAGE,
  panelUrl,
  panelVoices,
  primaryLangOf,
  queryToken,
  renderPanelShell,
  resolvePanelAsset,
  safeTokenEqual,
  type PanelDeps,
} from '../src/ui.js'
import type { TtsVoice, VoiceTtsSettings, VolcengineConfig } from '../src/types.js'

const TOKEN = 'test-token-1234'

function makeVolcengineConfig(overrides: Partial<VolcengineConfig> = {}): VolcengineConfig {
  return {
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
    segment_strategy: 'sentence',
    segment_threshold: 5,
    segment_separators: '',
    voices: {},
    voice_profiles: {},
    ...overrides,
  }
}

function makeSettings(overrides: Partial<VolcengineConfig> = {}): VoiceTtsSettings {
  return {
    delivery: 'host_play',
    provider: 'volcengine',
    providers: {
      volcengine: { ...makeVolcengineConfig(overrides), apiKeyRef: 'VOLCENGINE_TTS_API_KEY' },
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
        segment_strategy: 'sentence',
        segment_threshold: 5,
        segment_separators: '',
        voices: {},
        voice_profiles: {},
      },
    },
  }
}

const voice: TtsVoice = {
  voice_type: 'zh_male_m191_uranus_bigtts',
  name: 'M191',
  scene: '通用场景',
  lang: '中文',
  ability: '指令遵循',
  group: 'standard',
}

describe('token', () => {
  it('generates a 64-char hex token', () => {
    const token = generatePanelToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(generatePanelToken()).not.toBe(token)
  })

  it('compares constant-time and rejects length mismatch', () => {
    expect(safeTokenEqual('abc', 'abc')).toBe(true)
    expect(safeTokenEqual('abc', 'abd')).toBe(false)
    expect(safeTokenEqual('abc', 'ab')).toBe(false)
  })

  it('extracts ac_token query param', () => {
    expect(queryToken('/voice-tts?ac_token=x')).toBe('x')
    expect(queryToken('/voice-tts')).toBeUndefined()
    expect(queryToken(undefined)).toBeUndefined()
  })
})

describe('panelUrl', () => {
  it('builds a loopback URL with the page and token', () => {
    expect(panelUrl(3080, 'tok')).toBe(`http://127.0.0.1:3080${PANEL_PAGE}?ac_token=tok`)
  })
})

describe('primaryLangOf', () => {
  it('derives zh / en from the volcengine voice_type prefix', () => {
    expect(primaryLangOf('zh_female_vv_uranus_bigtts')).toBe('zh')
    expect(primaryLangOf('en_male_david_uranus_bigtts')).toBe('en')
  })

  it('keeps other ISO prefixes as-is', () => {
    expect(primaryLangOf('ja_male_xxx_uranus_bigtts')).toBe('ja')
    expect(primaryLangOf('ko_female_yyy_uranus_bigtts')).toBe('ko')
  })

  it('treats siliconflow model:voice ids as multilingual', () => {
    expect(primaryLangOf('FunAudioLLM/CosyVoice2-0.5B:alex')).toBe('multi')
    expect(primaryLangOf('fnlp/MOSS-TTSD-v0.5:diana')).toBe('multi')
  })
})

describe('panelVoices', () => {
  const fishSettings: VoiceTtsSettings = {
    delivery: 'off',
    provider: 'fish-audio',
    providers: {
      volcengine: { ...makeVolcengineConfig(), apiKeyRef: 'V' },
      'siliconflow-cn': makeSettings().providers['siliconflow-cn'],
      host: { command: 'say', voice_type: '', rate: 175, bilingual: 'both', segment_strategy: 'sentence', segment_threshold: 5, segment_separators: '', voices: {}, voice_profiles: {} },
      openai: { vendor: 'o', model: 'tts-1', voice_type: '', instructions: '', format: 'mp3', play_format: 'mp3', speed: 1, bilingual: 'both', segment_strategy: 'sentence', segment_threshold: 5, segment_separators: '', voices: {}, voice_profiles: {} },
      minimax: { vendor: 'm', model: 'speech-2.8-turbo', voice_type: '', speed: 1, vol: 1, pitch: 0, emotion: '', sample_rate: 32000, format: 'mp3', play_format: 'wav', bitrate: 128000, channel: 1, bilingual: 'both', segment_strategy: 'sentence', segment_threshold: 5, segment_separators: '', voices: {}, voice_profiles: {} },
      'fish-audio': { vendor: '302ai-fish-audio', model: 's1', voice_type: 'voice-1', format: 'mp3', play_format: 'wav', sample_rate: 44100, mp3_bitrate: 128, opus_bitrate: -1000, speed: 1, volume: 0, normalize: true, normalize_loudness: true, latency: 'normal', chunk_length: 200, temperature: 0.7, top_p: 0.7, max_new_tokens: 1024, repetition_penalty: 1.2, min_chunk_length: 50, condition_on_previous_chunks: true, early_stop_threshold: 1, bilingual: 'both', segment_strategy: 'sentence', segment_threshold: 5, segment_separators: '', voices: {}, voice_profiles: {} },
    },
    vendors: {
      'fish-audio-official': { label: 'Fish Audio 官方', provider: 'fish-audio', kind: 'official', baseUrl: 'https://api.fish.audio', apiKeyRef: 'TTS_FISH_AUDIO_API_KEY' },
      '302ai-fish-audio': { label: '302AI', provider: 'fish-audio', kind: 'reseller', baseUrl: 'https://api.302.ai/fish-audio', apiKeyRef: 'TTS_302AI_API_KEY' },
    },
    storage: { scope: 'user', dir: '' },
    player: { command: '' },
  }

  const remoteVoice: TtsVoice = { voice_type: 'voice-1', name: 'Voice', scene: 's', lang: 'en', ability: 'a', group: 'remote' }
  const staticVoice: TtsVoice = { voice_type: 'zh_female_vv_uranus_bigtts', name: 'V', scene: 's', lang: 'zh', ability: 'a', group: 'standard' }

  function catalog(overrides: Partial<{
    listVoicePage: () => Promise<{ voices: TtsVoice[]; total: number; pageSize: number; pageNumber: number; hasMore: boolean }>
    listVoices: () => readonly TtsVoice[]
  }> = {}): Parameters<typeof panelVoices>[0] {
    return {
      listVoicePage: async () => ({ voices: [remoteVoice], total: 1, pageSize: 100, pageNumber: 1, hasMore: false }),
      listVoices: () => [staticVoice],
      ...overrides,
    }
  }

  it('maps remote pages and derives the primary language', async () => {
    const out = await panelVoices(catalog(), fishSettings, 'fish-audio')
    expect(out).toEqual([{ ...remoteVoice, primaryLang: 'multi' }])
  })

  it('falls back to the static catalog when the official vendor lookup fails', async () => {
    const out = await panelVoices(catalog({ listVoicePage: async () => { throw new Error('upstream down') } }), { ...fishSettings, providers: { ...fishSettings.providers, 'fish-audio': { ...fishSettings.providers['fish-audio'], vendor: 'fish-audio-official' } } }, 'fish-audio')
    expect(out).toEqual([{ ...staticVoice, primaryLang: 'zh' }])
  })

  it('fails loud when the reseller (302AI) vendor lookup fails', async () => {
    await expect(panelVoices(catalog({ listVoicePage: async () => { throw new Error('missing key') } }), fishSettings, 'fish-audio')).rejects.toThrow('missing key')
  })
})

describe('resolvePanelAsset', () => {
  it('resolves a whitelisted single-segment file', () => {
    expect(resolvePanelAsset('/pkg/panel/dist', `${ASSET_PREFIX}panel.js`)).toBe('/pkg/panel/dist/panel.js')
  })

  it('rejects path traversal and nested segments', () => {
    expect(resolvePanelAsset('/pkg/panel/dist', `${ASSET_PREFIX}../secret.js`)).toBeUndefined()
    expect(resolvePanelAsset('/pkg/panel/dist', `${ASSET_PREFIX}a/b.js`)).toBeUndefined()
  })

  it('rejects non-whitelisted extensions and wrong prefix', () => {
    expect(resolvePanelAsset('/pkg/panel/dist', `${ASSET_PREFIX}x.exe`)).toBeUndefined()
    expect(resolvePanelAsset('/pkg/panel/dist', '/other/panel.js')).toBeUndefined()
  })

  it('maps extensions to content types', () => {
    expect(assetContentType('panel.js')).toBe('text/javascript; charset=utf-8')
    expect(assetContentType('style.css')).toBe('text/css; charset=utf-8')
  })
})

describe('renderPanelShell', () => {
  it('renders a CSP-tight shell with escaped bootstrap', () => {
    const html = renderPanelShell({ token: '<x>', channel: PANEL_CHANNEL })
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('panel.js')
    expect(html).toContain('dsh-voice-tts-bootstrap')
    // token 的 `<` 被转义,防止破坏 script 边界(`>` 无需转义)。
    expect(html).toContain('\\u003cx>')
  })
})

describe('describeStatus', () => {
  it('resolves per-language voices through a matched profile', () => {
    const cfg = makeVolcengineConfig({
      voice_profiles: { 'steve-jobs': { zh: { voice_type: 'zh_male' }, en: { voice_type: 'en_male' }, mixed: { voice_type: 'zh_male' } } },
    })
    expect(describeStatus(cfg, 'steve-jobs')).toEqual({
      voiceId: 'steve-jobs',
      matchedProfile: true,
      voices: { zh: 'zh_male', en: 'en_male', mixed: 'zh_male' },
    })
  })

  it('falls back to voice_type when no profile matches', () => {
    const cfg = makeVolcengineConfig()
    expect(describeStatus(cfg, 'unknown-id')).toEqual({
      voiceId: 'unknown-id',
      matchedProfile: false,
      voices: { zh: 'zh_female_vv_uranus_bigtts', en: 'zh_female_vv_uranus_bigtts', mixed: 'zh_female_vv_uranus_bigtts' },
    })
    expect(describeStatus(cfg, undefined).voiceId).toBeNull()
  })
})

describe('handlePanelRpc', () => {
  const settings = makeSettings()

  function deps(overrides: Partial<PanelDeps> = {}): PanelDeps {
    return {
      getConfig: () => settings,
      setConfig: async () => settings,
      status: () => describeStatus(settings.providers.volcengine, undefined),
      listVoices: () => ({ voices: [voice], total: 1, pageSize: 100, pageNumber: 1, hasMore: false }),
      listModels: () => ['seed-tts-2.0', 'seed-icl-2.0'],
      listParams: () => [{ key: 'pitch', label: '音调', min: -12, max: 12, step: 1 }],
      keyStatus: async () => ({ configured: true, source: 'file', writable: true }),
      setKey: async () => {},
      unsetKey: async () => {},
      ...overrides,
    }
  }

  it('rejects a missing or wrong token', async () => {
    const result = await handlePanelRpc('config-get', { acToken: 'wrong' }, TOKEN, deps())
    expect(result).toEqual({ ok: false, error: { code: 'bad-request', message: 'missing or invalid acToken', details: { issues: [] } } })
  })

  it('rejects an unknown endpoint', async () => {
    const result = await handlePanelRpc('bogus', { acToken: TOKEN }, TOKEN, deps())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('unknown endpoint')
  })

  it('config-get returns the current config', async () => {
    const result = await handlePanelRpc('config-get', { acToken: TOKEN }, TOKEN, deps())
    expect(result).toEqual({ ok: true, value: { config: settings } })
  })

  it('config-set delegates to deps.setConfig and returns the result', async () => {
    const setConfig = vi.fn(async () => settings)
    const result = await handlePanelRpc('config-set', { acToken: TOKEN, config: settings }, TOKEN, deps({ setConfig }))
    expect(setConfig).toHaveBeenCalledWith(settings)
    expect(result).toEqual({ ok: true, value: { config: settings } })
  })

  it('config-set rejects a payload without config', async () => {
    const result = await handlePanelRpc('config-set', { acToken: TOKEN }, TOKEN, deps())
    expect(result.ok).toBe(false)
  })

  it('voices-list returns the voice catalog + models + params for a provider', async () => {
    const listVoices = vi.fn(() => ({ voices: [voice], total: 1, pageSize: 100, pageNumber: 1, hasMore: false }))
    const listModels = vi.fn(() => ['seed-tts-2.0', 'seed-icl-2.0'])
    const listParams = vi.fn(() => [{ key: 'pitch', label: '音调', min: -12, max: 12, step: 1 }])
    const result = await handlePanelRpc('voices-list', { acToken: TOKEN, provider: 'volcengine' }, TOKEN, deps({ listVoices, listModels, listParams }))
    expect(listVoices).toHaveBeenCalledWith('volcengine', { pageNumber: 1, pageSize: 100 })
    expect(listModels).toHaveBeenCalledWith('volcengine')
    expect(listParams).toHaveBeenCalledWith('volcengine')
    expect(result).toEqual({ ok: true, value: { voices: [voice], total: 1, pageSize: 100, pageNumber: 1, hasMore: false, models: ['seed-tts-2.0', 'seed-icl-2.0'], params: [{ key: 'pitch', label: '音调', min: -12, max: 12, step: 1 }] } })
  })

  it('voices-list forwards an explicit page request', async () => {
    const listVoices = vi.fn(() => ({ voices: [voice], total: 201, pageSize: 100, pageNumber: 2, hasMore: true }))
    const result = await handlePanelRpc('voices-list', { acToken: TOKEN, provider: 'fish-audio', pageNumber: 2, pageSize: 100 }, TOKEN, deps({ listVoices }))
    expect(listVoices).toHaveBeenCalledWith('fish-audio', { pageNumber: 2, pageSize: 100 })
    expect(result).toMatchObject({ ok: true, value: { pageNumber: 2, total: 201, hasMore: true } })
  })

  it('voice-info delegates a provider detail lookup', async () => {
    const getVoiceInfo = vi.fn(async () => ({ id: 'voice-1', voice, metadata: { _id: 'voice-1' } }))
    const result = await handlePanelRpc('voice-info', { acToken: TOKEN, provider: 'fish-audio', voiceId: 'voice-1' }, TOKEN, deps({ getVoiceInfo }))
    expect(getVoiceInfo).toHaveBeenCalledWith('fish-audio', 'voice-1')
    expect(result).toEqual({ ok: true, value: { voice: { id: 'voice-1', voice, metadata: { _id: 'voice-1' } } } })
  })

  it('key-status returns configured/source/writable without a value', async () => {
    const result = await handlePanelRpc('key-status', { acToken: TOKEN, ref: 'SILICONFLOW_API_KEY' }, TOKEN, deps())
    expect(result).toEqual({ ok: true, value: { key: { configured: true, source: 'file', writable: true } } })
  })

  it('key-set delegates to deps.setKey', async () => {
    const setKey = vi.fn(async () => {})
    const result = await handlePanelRpc('key-set', { acToken: TOKEN, ref: 'SILICONFLOW_API_KEY', value: 'sk-x' }, TOKEN, deps({ setKey }))
    expect(setKey).toHaveBeenCalledWith('SILICONFLOW_API_KEY', 'sk-x')
    expect(result).toEqual({ ok: true, value: {} })
  })

  it('key-unset delegates to deps.unsetKey', async () => {
    const unsetKey = vi.fn(async () => {})
    const result = await handlePanelRpc('key-unset', { acToken: TOKEN, ref: 'SILICONFLOW_API_KEY' }, TOKEN, deps({ unsetKey }))
    expect(unsetKey).toHaveBeenCalledWith('SILICONFLOW_API_KEY')
    expect(result).toEqual({ ok: true, value: {} })
  })
})
