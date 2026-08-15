/**
 * 面板根组件:active provider 选择 + 各 provider 配置卡片 + 每 provider 的 KEY NAME/值管理。
 * 配置(config)经 config-get/config-set 读写;key 值经 key-status/key-set/key-unset
 * 走 credentials seam(值永不回显,KEY NAME 存 settings 的 apiKeyRef 字段)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { readBootstrap, rpc } from './api'
import type {
  Bootstrap, KeyStatus, Settings, Status, SiliconflowConfig, Voice, Voices, VolcengineConfig,
} from './api'

const DELIVERY_OPTIONS = ['off', 'file', 'host_play', 'stream'] as const
const BILINGUAL_OPTIONS = ['both', 'english_only', 'chinese_only'] as const
const LANG_KEYS = ['zh', 'en', 'mixed'] as const
const PROVIDERS = ['volcengine', 'siliconflow-cn'] as const

/** 音色 `group` → 下拉分组名。 */
const GROUP_LABEL: Record<string, string> = { standard: '标准', multilingual: '多语种' }

/** 主要语种 → 展示名。 */
const LANG_LABEL: Record<string, string> = { zh: '中文', en: '英文', multi: '多语种' }

/** siliconflow 模型 id → 简短标签。 */
const MODEL_LABEL: Record<string, string> = {
  'FunAudioLLM/CosyVoice2-0.5B': 'CosyVoice2-0.5B',
  'fnlp/MOSS-TTSD-v0.5': 'MOSS-TTSD-v0.5',
}

/** volcengine resource_id → 简短标签。 */
const RESOURCE_LABEL: Record<string, string> = {
  'seed-tts-2.0': 'seed-tts-2.0（合成）',
  'seed-icl-2.0': 'seed-icl-2.0（复刻）',
}

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

/**
 * 计算 zh/en 槽位的语种软提示。返回 undefined 表示不提示:
 * 未推导、多语种音色、或语种匹配时都不提示。
 */
function mismatchWarning(expectedLang: 'zh' | 'en', primaryLang: string | undefined): string | undefined {
  if (primaryLang === undefined || primaryLang === 'multi' || primaryLang === expectedLang) return undefined
  const langName = LANG_LABEL[primaryLang] ?? primaryLang
  return expectedLang === 'zh'
    ? `⚠ 该音色主要语种是「${langName}」,zh 槽位通常应选中文音色`
    : `⚠ 该音色主要语种是「${langName}」,en 槽位通常应选英文音色`
}

/**
 * 音色选择器:可搜索下拉,每行展示 name / scene / ability / lang / group / voice_type,
 * 也允许直接输入音色 id。`voices` 应是**按当前 model/resource_id 过滤后**的列表。
 */
function VoicePicker(props: {
  value: string
  voices: readonly Voice[]
  label: string
  desc?: string
  placeholder?: string
  expectedLang?: 'zh' | 'en'
  onChange: (next: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const options = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return props.voices
    return props.voices.filter(v =>
      v.name.toLowerCase().includes(q)
      || v.voice_type.toLowerCase().includes(q)
      || v.scene.toLowerCase().includes(q)
      || v.ability.toLowerCase().includes(q)
      || v.lang.toLowerCase().includes(q)
    )
  }, [props.voices, query])

  const close = useCallback((): void => { setOpen(false); setActive(0) }, [])
  const openList = useCallback((): void => { setOpen(true); setQuery(''); setActive(0) }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, close])

  const selected = props.value.length > 0 ? props.voices.find(v => v.voice_type === props.value) : undefined
  // 关闭时显示已选音色的友好名;打开时显示搜索词。自定义 id 原样显示。
  const display = open ? query : (selected !== undefined ? selected.name : props.value)
  // 语种软提示:选中音色与槽位期望语种不匹配时给出黄色警告,不阻止保存。
  const warn = props.expectedLang !== undefined && selected !== undefined
    ? mismatchWarning(props.expectedLang, selected.primaryLang)
    : undefined

  const commit = (voiceType: string): void => {
    props.onChange(voiceType)
    close()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) { openList(); return }
      setActive(i => Math.min(i + 1, options.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      if (open && options[active] !== undefined) {
        e.preventDefault()
        commit(options[active]!.voice_type)
      }
    } else if (e.key === 'Escape') {
      close()
    }
  }

  return (
    <div className="voice-picker" ref={rootRef}>
      <span className="field-head">
        <span className="mono key">{props.label}</span>
        {props.desc !== undefined && <span className="desc">{props.desc}</span>}
      </span>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        value={display}
        placeholder={props.placeholder ?? '搜索或输入音色 id…'}
        onFocus={openList}
        onChange={e => { setQuery(e.target.value); setOpen(true); setActive(0) }}
        onKeyDown={onKeyDown}
      />
      {warn !== undefined && <div className="vp-warn">{warn}</div>}
      {open && (
        <div className="vp-list" role="listbox">
          {options.length === 0 && <div className="vp-empty">无匹配音色(可直接输入 voice id)</div>}
          {options.map((v, i) => (
            <div key={v.voice_type} role="option" aria-selected={v.voice_type === props.value}
              className={`vp-option${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={e => { e.preventDefault(); commit(v.voice_type) }}>
              <div className="vp-row-head">
                <span className="vp-name">{v.name}</span>
                {v.group !== undefined && <span className="vp-group">{GROUP_LABEL[v.group] ?? v.group}</span>}
                {v.voice_type === props.value && <span className="vp-check">✓</span>}
              </div>
              <div className="vp-row-sub">{v.scene} · {v.ability}</div>
              <div className="vp-row-lang" title={v.voice_type}>{v.lang} · <span className="mono">{v.voice_type}</span></div>
            </div>
          ))}
        </div>
      )}
    </div>
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
function CredentialSection(props: { bootstrap: Bootstrap; keyRef: string }): JSX.Element {
  const [value, setValue] = useState('')
  const [status, setStatus] = useState<KeyStatus | null>(null)
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error'; text: string } | undefined>(undefined)

  useEffect(() => {
    setStatus(null)
    setBanner(undefined)
    if (props.keyRef.trim().length === 0) return
    rpc<{ key: KeyStatus }>(props.bootstrap, 'key-status', { ref: props.keyRef })
      .then(v => setStatus(v.key))
      .catch((err: unknown) => setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) }))
  }, [props.bootstrap, props.keyRef])

  const setKey = useCallback(async (): Promise<void> => {
    try {
      await rpc(props.bootstrap, 'key-set', { ref: props.keyRef, value })
      setValue('')
      const next = await rpc<{ key: KeyStatus }>(props.bootstrap, 'key-status', { ref: props.keyRef })
      setStatus(next.key)
      setBanner({ kind: 'ok', text: 'API key 已保存 (stored)' })
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }, [props.bootstrap, props.keyRef, value])

  const unset = useCallback(async (): Promise<void> => {
    try {
      await rpc(props.bootstrap, 'key-unset', { ref: props.keyRef })
      setValue('')
      const next = await rpc<{ key: KeyStatus }>(props.bootstrap, 'key-status', { ref: props.keyRef })
      setStatus(next.key)
      setBanner({ kind: 'ok', text: 'API key 已删除 (removed)' })
    } catch (err) {
      setBanner({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }, [props.bootstrap, props.keyRef])

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
        <button type="button" className="primary" disabled={value.length === 0 || props.keyRef.trim().length === 0} onClick={() => void setKey()}>保存 key</button>
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
  voices: readonly Voice[]
  onChange: (patch: { voice_type?: string; bilingual?: 'both' | 'english_only' | 'chinese_only'; voices?: Voices }) => void
}): JSX.Element {
  const { cfg } = props
  return (
    <>
      <div className="field-row">
        <VoicePicker voices={props.voices} label="voice_type" desc="默认音色" value={cfg.voice_type} onChange={next => props.onChange({ voice_type: next })} />
        <label className="field">
          <span className="field-head"><span className="mono key">bilingual</span><span className="desc">双语播报过滤</span></span>
          <select value={cfg.bilingual} onChange={e => props.onChange({ bilingual: e.target.value as 'both' | 'english_only' | 'chinese_only' })}>
            {BILINGUAL_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
      </div>
      <div className="field-row">
        <VoicePicker voices={props.voices} label="voices.zh" desc="中文音色" expectedLang="zh" value={cfg.voices.zh ?? ''} onChange={next => props.onChange({ voices: { ...cfg.voices, zh: next } })} />
        <VoicePicker voices={props.voices} label="voices.en" desc="英文音色" expectedLang="en" value={cfg.voices.en ?? ''} onChange={next => props.onChange({ voices: { ...cfg.voices, en: next } })} />
        <VoicePicker voices={props.voices} label="voices.mixed" desc="混合音色" value={cfg.voices.mixed ?? ''} onChange={next => props.onChange({ voices: { ...cfg.voices, mixed: next } })} />
      </div>
    </>
  )
}

/** voice_profiles 行编辑器。 */
function ProfilesEditor(props: {
  profiles: Record<string, Voices>
  voices: readonly Voice[]
  onChange: (next: Record<string, Voices>) => void
}): JSX.Element {
  // 本地编辑态:允许存在「空 id 行」供用户填写;提交时才把非空 id 行折叠成 profiles。
  // 不能直接从 props.profiles 派生 rows——空 id 行会被 rowsToProfiles 丢弃,导致「+ 添加映射」加的空行立即消失。
  const [rows, setRows] = useState<ProfileRow[]>(() => profilesToRows(props.profiles))
  const update = (next: ProfileRow[]): void => {
    setRows(next)
    props.onChange(rowsToProfiles(next))
  }
  return (
    <div className="profiles">
      <div className="section-title">per-voice 音色映射 (voice_profiles)</div>
      {rows.map((row, index) => (
        <div className="profile-row" key={index}>
          <input type="text" className="profile-id" placeholder="voice id (如 steve-jobs)" value={row.id}
            onChange={e => update(rows.map((r, i) => i === index ? { ...r, id: e.target.value } : r))} />
          <VoicePicker voices={props.voices} label="zh" expectedLang="zh" value={row.zh} onChange={next => update(rows.map((r, i) => i === index ? { ...r, zh: next } : r))} />
          <VoicePicker voices={props.voices} label="en" expectedLang="en" value={row.en} onChange={next => update(rows.map((r, i) => i === index ? { ...r, en: next } : r))} />
          <VoicePicker voices={props.voices} label="mixed" value={row.mixed} onChange={next => update(rows.map((r, i) => i === index ? { ...r, mixed: next } : r))} />
          <button type="button" className="refresh danger" onClick={() => update(rows.filter((_, i) => i !== index))}>删除</button>
        </div>
      ))}
      <button type="button" className="refresh" onClick={() => update([...rows, { id: '', zh: '', en: '', mixed: '' }])}>+ 添加映射</button>
    </div>
  )
}

/** 顶层字段级 diff:比较两个对象的顶层 key,返回值不同的 key 数(对象值 JSON 深比较)。 */
function countDiff(a: object, b: object): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  let n = 0
  for (const key of keys) {
    if (JSON.stringify((a as Record<string, unknown>)[key]) !== JSON.stringify((b as Record<string, unknown>)[key])) n++
  }
  return n
}

/** 区域保存条:脏时高亮并显示未保存字段数,干净时禁用。 */
function SaveBar(props: { dirty: number; onSave: () => void }): JSX.Element {
  return (
    <div className="form-actions">
      <button type="button" className={`primary${props.dirty > 0 ? ' dirty' : ''}`} disabled={props.dirty === 0} onClick={props.onSave}>
        {props.dirty > 0 ? `保存 (${props.dirty} 处未保存)` : '保存 (Save)'}
      </button>
      <span className="desc">{props.dirty > 0 ? '有未保存改动' : '已保存'}</span>
    </div>
  )
}

/** volcengine provider 卡片。 */
function VolcengineCard(props: { bootstrap: Bootstrap; cfg: VolcengineConfig; voices: readonly Voice[]; dirty: number; onChange: (next: VolcengineConfig) => void; onSave: () => void }): JSX.Element {
  const { cfg } = props
  const set = (patch: Partial<VolcengineConfig>): void => props.onChange({ ...cfg, ...patch })
  // 联动:seed-tts-2.0 有 230 个预置音色;seed-icl-2.0(复刻)无预置音色列表。
  const voices = cfg.resource_id === 'seed-tts-2.0' ? props.voices : []
  const changeResource = (next: VolcengineConfig['resource_id']): void => {
    // 切到复刻:清空预置音色相关字段(复刻用 model 字段,不用 speaker)。
    if (next === 'seed-icl-2.0') set({ resource_id: next, voice_type: '', voices: {} })
    else set({ resource_id: next })
  }
  return (
    <div className="card provider-card">
      <div className="section-title">volcengine (seed-tts-2.0)</div>
      <KeyNameField value={cfg.apiKeyRef} onChange={next => set({ apiKeyRef: next })} />
      <CredentialSection bootstrap={props.bootstrap} keyRef={cfg.apiKeyRef} />
      <BilingualFields cfg={cfg} voices={voices} onChange={patch => set(patch)} />
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">resource_id</span><span className="desc">模型版本</span></span>
          <select value={cfg.resource_id} onChange={e => changeResource(e.target.value as VolcengineConfig['resource_id'])}>
            {['seed-tts-2.0', 'seed-icl-2.0'].map(o => <option key={o} value={o} title={o}>{RESOURCE_LABEL[o] ?? o}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">model</span><span className="desc">复刻音色 id(seed-icl-2.0 用)</span></span>
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
      <ProfilesEditor profiles={cfg.voice_profiles} voices={voices} onChange={next => set({ voice_profiles: next })} />
      <SaveBar dirty={props.dirty} onSave={props.onSave} />
    </div>
  )
}

/** siliconflow provider 卡片。 */
function SiliconflowCard(props: { bootstrap: Bootstrap; cfg: SiliconflowConfig; voices: readonly Voice[]; models: readonly string[]; dirty: number; onChange: (next: SiliconflowConfig) => void; onSave: () => void }): JSX.Element {
  const { cfg } = props
  const set = (patch: Partial<SiliconflowConfig>): void => props.onChange({ ...cfg, ...patch })
  // 联动:voice_type 是「模型:音色名」前缀形式,按当前 model 过滤。
  const voices = props.voices.filter(v => v.voice_type.startsWith(`${cfg.model}:`))
  const changeModel = (next: string): void => {
    // 切模型会改变 voice 前缀,旧音色必然失效,清空重选。
    set({ model: next, voice_type: '', voices: {} })
  }
  return (
    <div className="card provider-card">
      <div className="section-title">siliconflow-cn (CosyVoice2 / MOSS-TTSD)</div>
      <KeyNameField value={cfg.apiKeyRef} onChange={next => set({ apiKeyRef: next })} />
      <CredentialSection bootstrap={props.bootstrap} keyRef={cfg.apiKeyRef} />
      <BilingualFields cfg={cfg} voices={voices} onChange={patch => set(patch)} />
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">model</span><span className="desc">TTS 模型(联动下方音色)</span></span>
          <select value={cfg.model} onChange={e => changeModel(e.target.value)}>
            {props.models.map(m => <option key={m} value={m} title={m}>{MODEL_LABEL[m] ?? m}</option>)}
          </select>
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
      <ProfilesEditor profiles={cfg.voice_profiles} voices={voices} onChange={next => set({ voice_profiles: next })} />
      <SaveBar dirty={props.dirty} onSave={props.onSave} />
    </div>
  )
}

/** 根组件:bootstrap → 加载数据 → 渲染多 provider 配置表单。 */
export function App(): JSX.Element {
  const [bootstrap] = useState(readBootstrap)
  const [config, setConfig] = useState<Settings | null>(null)
  const [saved, setSaved] = useState<Settings | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [voices, setVoices] = useState<Record<string, Voice[]>>({ volcengine: [], 'siliconflow-cn': [] })
  const [models, setModels] = useState<Record<string, string[]>>({ volcengine: [], 'siliconflow-cn': [] })
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (bootstrap === undefined) return
    Promise.all([
      rpc<{ config: Settings }>(bootstrap, 'config-get'),
      rpc<{ status: Status }>(bootstrap, 'status-get'),
      rpc<{ voices: Voice[]; models: string[] }>(bootstrap, 'voices-list', { provider: 'volcengine' }),
      rpc<{ voices: Voice[]; models: string[] }>(bootstrap, 'voices-list', { provider: 'siliconflow-cn' }),
    ]).then(([c, s, v1, v2]) => {
      setConfig(c.config)
      setSaved(c.config)
      setStatus(s.status)
      setVoices({ volcengine: v1.voices, 'siliconflow-cn': v2.voices })
      setModels({ volcengine: v1.models, 'siliconflow-cn': v2.models })
    }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [bootstrap])

  const saveRegion = useCallback(async (region: 'global' | 'volcengine' | 'siliconflow-cn'): Promise<void> => {
    if (bootstrap === undefined || config === null || saved === null) return
    const toSave: Settings = {
      delivery: region === 'global' ? config.delivery : saved.delivery,
      provider: region === 'global' ? config.provider : saved.provider,
      providers: {
        volcengine: region === 'volcengine' ? config.providers.volcengine : saved.providers.volcengine,
        'siliconflow-cn': region === 'siliconflow-cn' ? config.providers['siliconflow-cn'] : saved.providers['siliconflow-cn'],
      },
    }
    try {
      const v = await rpc<{ config: Settings }>(bootstrap, 'config-set', { config: toSave })
      setSaved(v.config)
      setConfig(prev => prev === null ? v.config : {
        delivery: region === 'global' ? v.config.delivery : prev.delivery,
        provider: region === 'global' ? v.config.provider : prev.provider,
        providers: {
          volcengine: region === 'volcengine' ? v.config.providers.volcengine : prev.providers.volcengine,
          'siliconflow-cn': region === 'siliconflow-cn' ? v.config.providers['siliconflow-cn'] : prev.providers['siliconflow-cn'],
        },
      })
      rpc<{ status: Status }>(bootstrap, 'status-get').then(s => setStatus(s.status)).catch(() => {})
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [bootstrap, config, saved])

  if (bootstrap === undefined) {
    return <div className="empty">引导数据缺失 (bootstrap missing): 请从 /dsh-voice-tts ui 的链接打开面板</div>
  }
  if (loading) return <div className="page"><div className="empty">加载中 (Loading)…</div></div>
  if (error !== undefined || config === null || saved === null || status === null) {
    return <div className="page"><div className="empty">加载失败: {error ?? '未知错误'}</div></div>
  }

  const globalDirty = countDiff(
    { delivery: config.delivery, provider: config.provider },
    { delivery: saved.delivery, provider: saved.provider },
  )
  const volDirty = countDiff(config.providers.volcengine, saved.providers.volcengine)
  const sfDirty = countDiff(config.providers['siliconflow-cn'], saved.providers['siliconflow-cn'])

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
          <SaveBar dirty={globalDirty} onSave={() => void saveRegion('global')} />
        </div>
        <VolcengineCard bootstrap={bootstrap} cfg={config.providers.volcengine} voices={voices.volcengine} dirty={volDirty}
          onChange={next => setConfig(prev => prev === null ? prev : { ...prev, providers: { ...prev.providers, volcengine: next } })}
          onSave={() => void saveRegion('volcengine')} />
        <SiliconflowCard bootstrap={bootstrap} cfg={config.providers['siliconflow-cn']} voices={voices['siliconflow-cn']} models={models['siliconflow-cn']} dirty={sfDirty}
          onChange={next => setConfig(prev => prev === null ? prev : { ...prev, providers: { ...prev.providers, 'siliconflow-cn': next } })}
          onSave={() => void saveRegion('siliconflow-cn')} />
        <datalist id="voice-tts-key-names">
          {KNOWN_KEY_NAMES.map(name => <option key={name} value={name} />)}
        </datalist>
      </div>
    </div>
  )
}
