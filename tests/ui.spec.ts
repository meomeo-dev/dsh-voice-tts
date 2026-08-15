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
      voice_profiles: { 'steve-jobs': { zh: 'zh_male', en: 'en_male', mixed: 'zh_male' } },
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
      listVoices: () => [voice],
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

  it('voices-list returns the voice catalog for a provider', async () => {
    const listVoices = vi.fn(() => [voice])
    const result = await handlePanelRpc('voices-list', { acToken: TOKEN, provider: 'volcengine' }, TOKEN, deps({ listVoices }))
    expect(listVoices).toHaveBeenCalledWith('volcengine')
    expect(result).toEqual({ ok: true, value: { voices: [voice] } })
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
