/**
 * 面板根组件:active provider 选择 + 各 provider 配置卡片 + 每 provider 的 KEY NAME/值管理。
 * 配置(config)经 config-get/config-set 读写;key 值经 key-status/key-set/key-unset
 * 走 credentials seam(值永不回显,KEY NAME 存 settings 的 apiKeyRef 字段)。
 */
import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { readBootstrap, rpc } from './api'
import type {
  Bootstrap, KeyStatus, Settings, Status, SiliconflowConfig, Voice, Voices, VolcengineConfig,
} from './api'

const DELIVERY_OPTIONS = ['off', 'file', 'host_play', 'stream'] as const
const BILINGUAL_OPTIONS = ['both', 'english_only', 'chinese_only'] as const
const LANG_KEYS = ['zh', 'en', 'mixed'] as const
const PROVIDERS = ['volcengine', 'siliconflow-cn'] as const

/** 已知凭证引用名(KEY NAME)下拉候选。 */
const KNOWN_KEY_NAMES = ['VOLCENGINE_TTS_API_KEY', 'SILICONFLOW_API_KEY', 'DEEPSEEK_API_KEY'] as const

/** voice_profiles 的一行(React 编辑态)。 */
interface ProfileRow {
  id: string
  zh: string
  en: string
  mixed: string
}

function profilesToRows(profiles: Record<string, Voices>): ProfileRow[] {
  return Object.entries(profiles).map(([id, v]) => ({
    id, zh: v.zh ?? '', en: v.en ?? '', mixed: v.mixed ?? '',
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
  placeholder?: string
  onChange: (next: string) => void
}): JSX.Element {
  return (
    <label className="voice-field">
      <span className="mono key">{props.label}</span>
      <input type="text" list={props.listId} value={props.value} placeholder={props.placeholder ?? ''} onChange={e => props.onChange(e.target.value)} />
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

/** 凭证(KEY NAME + 值)管理区:值走 credentials,KEY NAME 是父级 apiKeyRef 字段。 */
function CredentialSection(props: { bootstrap: Bootstrap; ref: string }): JSX.Element {
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)

  useEffect(() => {
    setStatus(null)
    setBanner(undefined)
    if (props.ref.trim().length === 0) return
    rpc<{ key: KeyStatus }>(props.bootstrap, 'key-status', { ref: props.ref })
      .then(v => setStatus(v.key))
      .catch((err: unknown) => setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) }))
  }, [props.bootstrap, props.ref])

  const setKey = useCallback(async (): Promise<void> => {
    try {
      await rpc(props.bootstrap, 'key-set', { ref: props.ref, value })
      setValue('')
      const next = await rpc<{ key: KeyStatus }>(props.bootstrap, 'key-status', { ref: props.ref })
      setStatus(next.key)
      setBanner({ kind: 'ok', text: 'API key 已保存 (stored)' })
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }, [props.bootstrap, props.ref, value])

  const unset = useCallback(async (): Promise<void> => {
    try {
      await rpc(props.bootstrap, 'key-unset', { ref: props.ref })
      setValue('')
      const next = await rpc<{ key: KeyStatus }>(props.bootstrap, 'key-status', { ref: props.ref })
      setStatus(next.key)
      setBanner({ kind: 'ok', text: 'API key 已删除 (removed)' })
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }, [props.bootstrap, props.ref])

  return (
    <div className="credential">
      {banner !== undefined && <div className={`banner ${banner.kind}`}>{banner.text}</div>}
      <div className="meta">
        <span>configured: {status === null ? '—' : String(status.configured)}</span>
        {status?.source != null && <span>source: <span className="mono">{status.source}</span></span>}
        <span>writable: {status === null ? '—' : String(status.writable)}</span>
      </div>
      <div className="key-actions">
        <input type="password" value={value} onChange={e => setValue(e.target.value)} placeholder="输入新 key(不回显)" autoComplete="off" />
        <button type="button" className="primary" disabled={value.length === 0 || props.ref.trim().length === 0} onClick={() => void setKey()}>保存 key</button>
        <button type="button" className="refresh danger" onClick={() => void unset()}>清除 key</button>
      </div>
    </div>
  )
}

/** KEY NAME 下拉 + 值管理。 */
function KeyNameField(props: { value: string; onChange: (next: string) => void }): JSX.Element {
  return (
    <label className="field">
      <span className="field-head"><span className="mono key">apiKeyRef</span><span className="desc">KEY NAME(凭证引用名)</span></span>
      <input type="text" list="voice-tts-key-names" value={props.value} onChange={e => props.onChange(e.target.value)} placeholder="KEY_NAME" />
    </label>
  )
}

/** 双语共享字段(voice_type / bilingual / voices / voice_profiles)。 */
function BilingualFields(props: {
  cfg: { voice_type: string; bilingual: string; voices: Voices }
  listId: string
  onChange: (patch: { voice_type?: string; bilingual?: 'both' | 'english_only' | 'chinese_only'; voices?: Voices }) => void
}): JSX.Element {
  const { cfg } = props
  return (
    <>
      <div className="field-row">
        <VoiceField listId={props.listId} label="voice_type" value={cfg.voice_type} onChange={next => props.onChange({ voice_type: next })} />
        <label className="field">
          <span className="field-head"><span className="mono key">bilingual</span><span className="desc">双语播报过滤</span></span>
          <select value={cfg.bilingual} onChange={e => props.onChange({ bilingual: e.target.value as 'both' | 'english_only' | 'chinese_only' })}>
            {BILINGUAL_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      </div>
      <div className="field-row">
        <VoiceField listId={props.listId} label="voices.zh" value={cfg.voices.zh ?? ''} onChange={next => props.onChange({ voices: { ...cfg.voices, zh: next } })} />
        <VoiceField listId={props.listId} label="voices.en" value={cfg.voices.en ?? ''} onChange={next => props.onChange({ voices: { ...cfg.voices, en: next } })} />
        <VoiceField listId={props.listId} label="voices.mixed" value={cfg.voices.mixed ?? ''} onChange={next => props.onChange({ voices: { ...cfg.voices, mixed: next } })} />
      </div>
    </>
  )
}

/** voice_profiles 行编辑器。 */
function ProfilesEditor(props: {
  profiles: Record<string, Voices>
  listId: string
  onChange: (next: Record<string, Voices>) => void
}): JSX.Element {
  const rows = profilesToRows(props.profiles)
  const update = (next: ProfileRow[]): void => props.onChange(rowsToProfiles(next))
  return (
    <div className="profiles">
      <div className="section-title">per-voice 音色映射 (voice_profiles)</div>
      {rows.map((row, index) => (
        <div className="profile-row" key={index}>
          <input type="text" className="profile-id" placeholder="voice id (如 steve-jobs)" value={row.id}
            onChange={e => update(rows.map((r, i) => i === index ? { ...r, id: e.target.value } : r))} />
          <VoiceField listId={props.listId} label="zh" value={row.zh} onChange={next => update(rows.map((r, i) => i === index ? { ...r, zh: next } : r))} />
          <VoiceField listId={props.listId} label="en" value={row.en} onChange={next => update(rows.map((r, i) => i === index ? { ...r, en: next } : r))} />
          <VoiceField listId={props.listId} label="mixed" value={row.mixed} onChange={next => update(rows.map((r, i) => i === index ? { ...r, mixed: next } : r))} />
          <button type="button" className="refresh danger" onClick={() => update(rows.filter((_, i) => i !== index))}>删除</button>
        </div>
      ))}
      <button type="button" className="refresh" onClick={() => update([...rows, { id: '', zh: '', en: '', mixed: '' }])}>+ 添加映射</button>
    </div>
  )
}

/** volcengine provider 卡片。 */
function VolcengineCard(props: { bootstrap: Bootstrap; cfg: VolcengineConfig; listId: string; onChange: (next: VolcengineConfig) => void }): JSX.Element {
  const { cfg } = props
  const set = (patch: Partial<VolcengineConfig>): void => props.onChange({ ...cfg, ...patch })
  return (
    <div className="card provider-card">
      <div className="section-title">volcengine (seed-tts-2.0)</div>
      <KeyNameField value={cfg.apiKeyRef} onChange={next => set({ apiKeyRef: next })} />
      <CredentialSection bootstrap={props.bootstrap} ref={cfg.apiKeyRef} />
      <BilingualFields cfg={cfg} listId={props.listId} onChange={patch => set(patch)} />
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">resource_id</span><span className="desc">模型版本</span></span>
          <select value={cfg.resource_id} onChange={e => set({ resource_id: e.target.value as VolcengineConfig['resource_id'] })}>
            {['seed-tts-2.0', 'seed-icl-2.0'].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">model</span><span className="desc">显式覆盖(通常留空)</span></span>
          <input type="text" value={cfg.model} onChange={e => set({ model: e.target.value })} placeholder="(empty)" />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">format</span><span className="desc">file/stream 落盘格式</span></span>
          <select value={cfg.format} onChange={e => set({ format: e.target.value as VolcengineConfig['format'] })}>
            {['mp3', 'pcm', 'ogg_opus', 'wav'].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">play_format</span><span className="desc">host_play 播放格式</span></span>
          <select value={cfg.play_format} onChange={e => set({ play_format: e.target.value as VolcengineConfig['play_format'] })}>
            {['mp3', 'pcm', 'ogg_opus', 'wav'].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field"><span className="field-head"><span className="mono key">sample_rate</span><span className="desc">[8000,48000] Hz</span></span>
          <input type="number" min={8000} max={48000} value={cfg.sample_rate} onChange={e => set({ sample_rate: Number(e.target.value) || 24000 })} /></label>
        <label className="field"><span className="field-head"><span className="mono key">speech_rate</span><span className="desc">[-50,100] 语速</span></span>
          <input type="number" min={-50} max={100} value={cfg.speech_rate} onChange={e => set({ speech_rate: Number(e.target.value) || 0 })} /></label>
        <label className="field"><span className="field-head"><span className="mono key">loudness_rate</span><span className="desc">[-50,100] 音量</span></span>
          <input type="number" min={-50} max={100} value={cfg.loudness_rate} onChange={e => set({ loudness_rate: Number(e.target.value) || 0 })} /></label>
        <label className="field"><span className="field-head"><span className="mono key">pitch</span><span className="desc">[-12,12] 音调</span></span>
          <input type="number" min={-12} max={12} value={cfg.pitch} onChange={e => set({ pitch: Number(e.target.value) || 0 })} /></label>
      </div>
      <ProfilesEditor profiles={cfg.voice_profiles} listId={props.listId} onChange={next => set({ voice_profiles: next })} />
    </div>
  )
}

/** siliconflow provider 卡片。 */
function SiliconflowCard(props: { bootstrap: Bootstrap; cfg: SiliconflowConfig; listId: string; onChange: (next: SiliconflowConfig) => void }): JSX.Element {
  const { cfg } = props
  const set = (patch: Partial<SiliconflowConfig>): void => props.onChange({ ...cfg, ...patch })
  return (
    <div className="card provider-card">
      <div className="section-title">siliconflow-cn (CosyVoice2 / MOSS-TTSD)</div>
      <KeyNameField value={cfg.apiKeyRef} onChange={next => set({ apiKeyRef: next })} />
      <CredentialSection bootstrap={props.bootstrap} ref={cfg.apiKeyRef} />
      <BilingualFields cfg={cfg} listId={props.listId} onChange={patch => set(patch)} />
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">model</span><span className="desc">TTS 模型 id</span></span>
          <input type="text" value={cfg.model} onChange={e => set({ model: e.target.value })} placeholder="FunAudioLLM/CosyVoice2-0.5B" />
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">format</span><span className="desc">file/stream 落盘格式</span></span>
          <select value={cfg.format} onChange={e => set({ format: e.target.value as SiliconflowConfig['format'] })}>
            {['mp3', 'opus', 'wav', 'pcm'].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">play_format</span><span className="desc">host_play 播放格式</span></span>
          <select value={cfg.play_format} onChange={e => set({ play_format: e.target.value as SiliconflowConfig['play_format'] })}>
            {['mp3', 'opus', 'wav', 'pcm'].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field"><span className="field-head"><span className="mono key">sample_rate</span><span className="desc">[8000,48000] Hz</span></span>
          <input type="number" min={8000} max={48000} value={cfg.sample_rate} onChange={e => set({ sample_rate: Number(e.target.value) || 32000 })} /></label>
        <label className="field"><span className="field-head"><span className="mono key">speed</span><span className="desc">[0.25,4.0] 语速</span></span>
          <input type="number" min={0.25} max={4} step={0.01} value={cfg.speed} onChange={e => set({ speed: Number(e.target.value) || 1 })} /></label>
        <label className="field"><span className="field-head"><span className="mono key">gain</span><span className="desc">[-10,10] dB 增益</span></span>
          <input type="number" min={-10} max={10} step={0.1} value={cfg.gain} onChange={e => set({ gain: Number(e.target.value) || 0 })} /></label>
      </div>
      <ProfilesEditor profiles={cfg.voice_profiles} listId={props.listId} onChange={next => set({ voice_profiles: next })} />
    </div>
  )
}

/** 根组件:bootstrap → 加载数据 → 渲染多 provider 配置表单。 */
export function App(): JSX.Element {
  const [bootstrap] = useState(readBootstrap)
  if (bootstrap === undefined) {
    return <div className="empty">引导数据缺失 (bootstrap missing): 请从 /dsh-voice-tts ui 的链接打开面板</div>
  }

  const [config, setConfig] = useState<Settings | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [voices, setVoices] = useState<Record<string, Voice[]>>({ volcengine: [], 'siliconflow-cn': [] })
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      rpc<{ config: Settings }>(bootstrap, 'config-get'),
      rpc<{ status: Status }>(bootstrap, 'status-get'),
      rpc<{ voices: Voice[] }>(bootstrap, 'voices-list', { provider: 'volcengine' }),
      rpc<{ voices: Voice[] }>(bootstrap, 'voices-list', { provider: 'siliconflow-cn' }),
    ]).then(([c, s, v1, v2]) => {
      setConfig(c.config)
      setStatus(s.status)
      setVoices({ volcengine: v1.voices, 'siliconflow-cn': v2.voices })
    }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [bootstrap])

  if (loading) return <div className="page"><div className="empty">加载中 (Loading)…</div></div>
  if (error !== undefined || config === null || status === null) {
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
        <div className="card form">
          <div className="section-title">全局</div>
          <div className="field-row">
            <label className="field">
              <span className="field-head"><span className="mono key">delivery</span><span className="desc">turn-final 交付方式</span></span>
              <select value={config.delivery} onChange={e => setConfig(prev => prev === null ? prev : { ...prev, delivery: e.target.value as Settings['delivery'] })}>
                {DELIVERY_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-head"><span className="mono key">provider</span><span className="desc">当前合成用的 provider</span></span>
              <select value={config.provider} onChange={e => setConfig(prev => prev === null ? prev : { ...prev, provider: e.target.value })}>
                {PROVIDERS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          </div>
          <div className="form-actions">
            <button type="button" className="primary" onClick={() => {
              if (config === null) return
              rpc<{ config: Settings }>(bootstrap, 'config-set', { config }).then(v => {
                setConfig(v.config)
                rpc<{ status: Status }>(bootstrap, 'status-get').then(s => setStatus(s.status)).catch(() => {})
              }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
            }}>保存 (Save)</button>
            <span className="desc">保存 settings(不含 key 值;key 走下方各 provider 卡片)</span>
          </div>
        </div>
        <VolcengineCard bootstrap={bootstrap} cfg={config.providers.volcengine} listId="voice-tts-voices-volcengine"
          onChange={next => setConfig(prev => prev === null ? prev : { ...prev, providers: { ...prev.providers, volcengine: next } })} />
        <SiliconflowCard bootstrap={bootstrap} cfg={config.providers['siliconflow-cn']} listId="voice-tts-voices-siliconflow"
          onChange={next => setConfig(prev => prev === null ? prev : { ...prev, providers: { ...prev.providers, 'siliconflow-cn': next } })} />
        <datalist id="voice-tts-voices-volcengine">
          {voices.volcengine.map(v => <option key={v.voice_type} value={v.voice_type}>{v.name} ({v.lang})</option>)}
        </datalist>
        <datalist id="voice-tts-voices-siliconflow">
          {voices['siliconflow-cn'].map(v => <option key={v.voice_type} value={v.voice_type}>{v.name} ({v.lang})</option>)}
        </datalist>
        <datalist id="voice-tts-key-names">
          {KNOWN_KEY_NAMES.map(name => <option key={name} value={name} />)}
        </datalist>
      </div>
    </div>
  )
}
