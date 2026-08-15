/**
 * 面板根组件:状态预览条 + 设置表单 + voice_profiles 行编辑器 + API key 区。
 * 全部经 config-get / config-set / status-get / voices-list / key-* RPC 与 host 交互;
 * 表单只做类型转换,校验在 host 侧 schemastery schema(config-set 走 scope.replace)。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { readBootstrap, rpc } from './api'
import type { Bootstrap, KeyStatus, Settings, Status, Voice, Voices, VolcengineConfig } from './api'

const DELIVERY_OPTIONS = ['off', 'file', 'host_play', 'stream'] as const
const RESOURCE_OPTIONS = ['seed-tts-2.0', 'seed-icl-2.0'] as const
const FORMAT_OPTIONS = ['mp3', 'pcm', 'ogg_opus', 'wav'] as const
const BILINGUAL_OPTIONS = ['both', 'english_only', 'chinese_only'] as const
const LANG_KEYS = ['zh', 'en', 'mixed'] as const

/** voice_profiles 的一行(React 编辑态)。 */
interface ProfileRow {
  id: string
  zh: string
  en: string
  mixed: string
}

function profilesToRows(profiles: Record<string, Voices>): ProfileRow[] {
  return Object.entries(profiles).map(([id, v]) => ({
    id,
    zh: v.zh ?? '',
    en: v.en ?? '',
    mixed: v.mixed ?? '',
  }))
}

function rowsToProfiles(rows: readonly ProfileRow[]): Record<string, Voices> {
  const out: Record<string, Voices> = {}
  for (const row of rows) {
    const id = row.id.trim()
    if (id.length === 0) continue
    out[id] = {
      ...(row.zh.trim().length > 0 ? { zh: row.zh.trim() } : {}),
      ...(row.en.trim().length > 0 ? { en: row.en.trim() } : {}),
      ...(row.mixed.trim().length > 0 ? { mixed: row.mixed.trim() } : {}),
    }
  }
  return out
}

/** 一个带 datalist 的音色输入框。 */
function VoiceField(props: {
  value: string
  listId: string
  label: string
  onChange: (next: string) => void
}): JSX.Element {
  return (
    <label className="voice-field">
      <span className="mono key">{props.label}</span>
      <input type="text" list={props.listId} value={props.value} onChange={e => props.onChange(e.target.value)} placeholder="voice_type" />
    </label>
  )
}

/** 状态预览条:当前 voice id + 生效音色。 */
function StatusStrip(props: { status: Status }): JSX.Element {
  const { status } = props
  return (
    <div className="card status-strip">
      <div className="section-title">当前生效音色 (effective voices)</div>
      <div className="meta">
        <span>dsh-voice id: <span className="mono">{status.voiceId ?? '—'}</span></span>
        <span>{status.matchedProfile ? '命中 voice_profiles' : '未命中 → 回退缺省 voices'}</span>
      </div>
      <div className="status-voices">
        {LANG_KEYS.map(lang => (
          <div className="status-voice" key={lang}>
            <span className="mono key">{lang}</span>
            <span className="mono">{status.voices[lang]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 设置表单。 */
function SettingsForm(props: {
  bootstrap: Bootstrap
  initial: Settings
  voices: readonly Voice[]
  onSaved: (next: Settings) => void
}): JSX.Element {
  const [draft, setDraft] = useState<Settings>(props.initial)
  const [profiles, setProfiles] = useState<ProfileRow[]>(() => profilesToRows(props.initial.providers.volcengine.voice_profiles))
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)
  const [saving, setSaving] = useState(false)

  const volc = draft.providers.volcengine
  const setVolc = (patch: Partial<VolcengineConfig>): void => {
    setDraft(prev => ({ ...prev, providers: { volcengine: { ...prev.providers.volcengine, ...patch } } }))
  }
  const setVoice = (key: keyof Voices, value: string): void => {
    setVolc({ voices: { ...volc.voices, [key]: value } })
  }

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(props.initial)
    || JSON.stringify(rowsToProfiles(profiles)) !== JSON.stringify(props.initial.providers.volcengine.voice_profiles), [draft, profiles, props.initial])

  const save = useCallback(async (): Promise<void> => {
    setSaving(true)
    try {
      const config: Settings = {
        ...draft,
        providers: { volcengine: { ...draft.providers.volcengine, voice_profiles: rowsToProfiles(profiles) } },
      }
      const value = await rpc<{ config: Settings }>(props.bootstrap, 'config-set', { config })
      props.onSaved(value.config)
      setDraft(value.config)
      setProfiles(profilesToRows(value.config.providers.volcengine.voice_profiles))
      setBanner({ kind: 'ok', text: '已保存 (Saved)' })
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }, [draft, profiles, props])

  return (
    <div className="card form">
      {banner !== undefined && <div className={`banner ${banner.kind}`}>{banner.text}</div>}

      <div className="section-title">交付与模型</div>
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">delivery</span><span className="desc">turn-final 交付方式</span></span>
          <select value={draft.delivery} onChange={e => setDraft(prev => ({ ...prev, delivery: e.target.value as Settings['delivery'] }))}>
            {DELIVERY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">resource_id</span><span className="desc">模型版本</span></span>
          <select value={volc.resource_id} onChange={e => setVolc({ resource_id: e.target.value as VolcengineConfig['resource_id'] })}>
            {RESOURCE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">bilingual</span><span className="desc">双语播报过滤</span></span>
          <select value={volc.bilingual} onChange={e => setVolc({ bilingual: e.target.value as VolcengineConfig['bilingual'] })}>
            {BILINGUAL_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      </div>

      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">voice_type</span><span className="desc">默认音色</span></span>
          <VoiceField listId="voice-tts-voices" label="" value={volc.voice_type} onChange={next => setVolc({ voice_type: next })} />
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">model</span><span className="desc">显式覆盖(通常留空)</span></span>
          <input type="text" value={volc.model} onChange={e => setVolc({ model: e.target.value })} placeholder="(empty)" />
        </label>
      </div>

      <div className="section-title">音频参数</div>
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">format</span><span className="desc">file/stream 落盘格式</span></span>
          <select value={volc.format} onChange={e => setVolc({ format: e.target.value as VolcengineConfig['format'] })}>
            {FORMAT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">play_format</span><span className="desc">host_play 播放格式</span></span>
          <select value={volc.play_format} onChange={e => setVolc({ play_format: e.target.value as VolcengineConfig['play_format'] })}>
            {FORMAT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">sample_rate</span><span className="desc">[8000,48000] Hz</span></span>
          <input type="number" min={8000} max={48000} value={volc.sample_rate} onChange={e => setVolc({ sample_rate: Number(e.target.value) || 24000 })} />
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">speech_rate</span><span className="desc">[-50,100] 语速</span></span>
          <input type="number" min={-50} max={100} value={volc.speech_rate} onChange={e => setVolc({ speech_rate: Number(e.target.value) || 0 })} />
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">loudness_rate</span><span className="desc">[-50,100] 音量</span></span>
          <input type="number" min={-50} max={100} value={volc.loudness_rate} onChange={e => setVolc({ loudness_rate: Number(e.target.value) || 0 })} />
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">pitch</span><span className="desc">[-12,12] 音调</span></span>
          <input type="number" min={-12} max={12} value={volc.pitch} onChange={e => setVolc({ pitch: Number(e.target.value) || 0 })} />
        </label>
      </div>

      <div className="section-title">各语言类别音色 (voices)</div>
      <div className="field-row">
        <VoiceField listId="voice-tts-voices" label="zh" value={volc.voices.zh ?? ''} onChange={next => setVoice('zh', next)} />
        <VoiceField listId="voice-tts-voices" label="en" value={volc.voices.en ?? ''} onChange={next => setVoice('en', next)} />
        <VoiceField listId="voice-tts-voices" label="mixed" value={volc.voices.mixed ?? ''} onChange={next => setVoice('mixed', next)} />
      </div>

      <div className="section-title">per-voice 音色映射 (voice_profiles)</div>
      <div className="profiles">
        {profiles.map((row, index) => (
          <div className="profile-row" key={index}>
            <input type="text" className="profile-id" placeholder="voice id (如 steve-jobs)" value={row.id}
              onChange={e => setProfiles(prev => prev.map((r, i) => i === index ? { ...r, id: e.target.value } : r))} />
            <VoiceField listId="voice-tts-voices" label="zh" value={row.zh}
              onChange={next => setProfiles(prev => prev.map((r, i) => i === index ? { ...r, zh: next } : r))} />
            <VoiceField listId="voice-tts-voices" label="en" value={row.en}
              onChange={next => setProfiles(prev => prev.map((r, i) => i === index ? { ...r, en: next } : r))} />
            <VoiceField listId="voice-tts-voices" label="mixed" value={row.mixed}
              onChange={next => setProfiles(prev => prev.map((r, i) => i === index ? { ...r, mixed: next } : r))} />
            <button type="button" className="refresh danger" onClick={() => setProfiles(prev => prev.filter((_, i) => i !== index))}>删除</button>
          </div>
        ))}
        <button type="button" className="refresh" onClick={() => setProfiles(prev => [...prev, { id: '', zh: '', en: '', mixed: '' }])}>+ 添加映射</button>
      </div>

      <div className="form-actions">
        <button type="button" className="primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存 (Save)'}
        </button>
        {dirty && <span className="desc">有未保存的修改</span>}
      </div>
    </div>
  )
}

/** API key 区:只读状态 + 掩码输入 set/unset。 */
function KeySection(props: { bootstrap: Bootstrap; initial: KeyStatus; onChanged: (next: KeyStatus) => void }): JSX.Element {
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<KeyStatus>(props.initial)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)

  const setKey = useCallback(async (): Promise<void> => {
    try {
      await rpc(props.bootstrap, 'key-set', { value })
      setValue('')
      const next = await rpc<{ key: KeyStatus }>(props.bootstrap, 'key-status')
      setStatus(next.key)
      props.onChanged(next.key)
      setBanner({ kind: 'ok', text: 'API key 已保存 (stored)' })
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }, [value, props])

  const unset = useCallback(async (): Promise<void> => {
    try {
      await rpc(props.bootstrap, 'key-unset')
      setValue('')
      const next = await rpc<{ key: KeyStatus }>(props.bootstrap, 'key-status')
      setStatus(next.key)
      props.onChanged(next.key)
      setBanner({ kind: 'ok', text: 'API key 已删除 (removed)' })
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }, [props])

  return (
    <div className="card">
      <div className="section-title">API key (credentials)</div>
      {banner !== undefined && <div className={`banner ${banner.kind}`}>{banner.text}</div>}
      <div className="meta">
        <span>configured: {String(status.configured)}</span>
        {status.source !== null && <span>source: <span className="mono">{status.source}</span></span>}
        <span>writable: {String(status.writable)}</span>
      </div>
      <div className="key-actions">
        <input type="password" value={value} onChange={e => setValue(e.target.value)} placeholder="输入新 key(不回显)" autoComplete="off" />
        <button type="button" className="primary" disabled={value.length === 0} onClick={() => void setKey()}>保存 key</button>
        <button type="button" className="refresh danger" onClick={() => void unset()}>清除 key</button>
      </div>
    </div>
  )
}

/** 根组件:bootstrap → 加载数据 → 渲染。 */
export function App(): JSX.Element {
  const [bootstrap] = useState(readBootstrap)
  if (bootstrap === undefined) {
    return <div className="empty">引导数据缺失 (bootstrap missing): 请从 /dsh-voice-tts ui 的链接打开面板</div>
  }

  const [config, setConfig] = useState<Settings | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [voices, setVoices] = useState<readonly Voice[]>([])
  const [key, setKey] = useState<KeyStatus | null>(null)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      rpc<{ config: Settings }>(bootstrap, 'config-get'),
      rpc<{ status: Status }>(bootstrap, 'status-get'),
      rpc<{ voices: Voice[] }>(bootstrap, 'voices-list'),
      rpc<{ key: KeyStatus }>(bootstrap, 'key-status'),
    ]).then(([c, s, v, k]) => {
      setConfig(c.config)
      setStatus(s.status)
      setVoices(v.voices)
      setKey(k.key)
    }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [bootstrap])

  if (loading) return <div className="page"><div className="empty">加载中 (Loading)…</div></div>
  if (error !== undefined || config === null || status === null || key === null) {
    return <div className="page"><div className="empty">加载失败: {error ?? '未知错误'}</div></div>
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">dsh-voice-tts</span>
        <span className="meta">配置面板 (config panel)</span>
      </header>
      <div className="page">
        <StatusStrip status={status} />
        <SettingsForm bootstrap={bootstrap} initial={config} voices={voices} onSaved={next => setConfig(next)} />
        <KeySection bootstrap={bootstrap} initial={key} onChanged={next => setKey(next)} />
        <datalist id="voice-tts-voices">
          {voices.map(v => <option key={v.voice_type} value={v.voice_type}>{v.name} ({v.lang})</option>)}
        </datalist>
      </div>
    </div>
  )
}
