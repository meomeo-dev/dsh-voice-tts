/**
 * 面板根组件:active provider 选择 + 各 provider 配置卡片 + 每 provider 的 KEY NAME/值管理。
 * 配置(config)经 config-get/config-set 读写;key 值经 key-status/key-set/key-unset
 * 走 credentials seam(值永不回显,KEY NAME 存 settings 的 apiKeyRef 字段)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { readBootstrap, rpc } from './api'
import type {
  Bootstrap, HostConfig, KeyStatus, MinimaxConfig, OpenaiConfig, Settings, SiliconflowConfig, Status, TunableParam, VendorRecord, Voice, Voices, VoiceSlot, VolcengineConfig,
} from './api'

const DELIVERY_OPTIONS = ['off', 'file', 'host_play', 'stream'] as const
const BILINGUAL_OPTIONS = ['both', 'english_only', 'chinese_only'] as const
const LANG_KEYS = ['zh', 'en', 'mixed'] as const
const PROVIDERS = ['volcengine', 'siliconflow-cn', 'host', 'openai', 'minimax'] as const
/** vendor 允许归属的协议。 */
const VENDOR_PROVIDERS = ['openai', 'minimax'] as const

/** 面板可独立保存的区域(与 config 顶层字段/ provider 键一一对应)。 */
type Region = 'global' | 'vendors' | 'volcengine' | 'siliconflow-cn' | 'host' | 'openai' | 'minimax'

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
const KNOWN_KEY_NAMES = ['VOLCENGINE_TTS_API_KEY', 'SILICONFLOW_API_KEY', 'TTS_302AI_API_KEY', 'DEEPSEEK_API_KEY'] as const

/** voice_profiles 的一行(React 编辑态)。 */
interface ProfileRow {
  id: string
  zh: VoiceSlot
  en: VoiceSlot
  mixed: VoiceSlot
}

/** 槽位是否有有效内容(音色非空或任一参数已设)。 */
function isNonEmptySlot(slot: VoiceSlot): boolean {
  return Object.values(slot).some(value => typeof value === 'string' ? value.length > 0 : true)
}

/** 读槽位某参数键的数值(非 number 视为未配置)。 */
function slotParamValue(slot: VoiceSlot, key: string): number | undefined {
  const value = (slot as Record<string, unknown>)[key]
  return typeof value === 'number' ? value : undefined
}

/** 从 provider 顶层配置里取参数注册表的继承默认值(非 number 视为 0)。 */
function inheritedParams(cfg: unknown, params: readonly TunableParam[]): Record<string, number> {
  const record = cfg as Record<string, unknown>
  const out: Record<string, number> = {}
  for (const param of params) {
    const value = record[param.key]
    out[param.key] = typeof value === 'number' ? value : 0
  }
  return out
}

function profilesToRows(profiles: Record<string, Voices>): ProfileRow[] {
  return Object.entries(profiles).map(([id, v]) => ({
    id, zh: v.zh ?? {}, en: v.en ?? {}, mixed: v.mixed ?? {},
  }))
}

function rowsToProfiles(rows: readonly ProfileRow[]): Record<string, Voices> {
  const out: Record<string, Voices> = {}
  for (const row of rows) {
    const id = row.id.trim()
    if (id.length === 0) continue
    out[id] = {
      ...(isNonEmptySlot(row.zh) ? { zh: row.zh } : {}),
      ...(isNonEmptySlot(row.en) ? { en: row.en } : {}),
      ...(isNonEmptySlot(row.mixed) ? { mixed: row.mixed } : {}),
    }
  }
  return out
}

/** vendor 注册表的一行(React 编辑态;id 是 vendors 的 key)。 */
interface VendorRow {
  id: string
  label: string
  provider: 'openai' | 'minimax'
  baseUrl: string
  apiKeyRef: string
}

function vendorsToRows(vendors: Record<string, VendorRecord>): VendorRow[] {
  return Object.entries(vendors).map(([id, v]) => ({ id, label: v.label, provider: v.provider, baseUrl: v.baseUrl, apiKeyRef: v.apiKeyRef }))
}

function rowsToVendors(rows: readonly VendorRow[]): Record<string, VendorRecord> {
  const out: Record<string, VendorRecord> = {}
  for (const row of rows) {
    const id = row.id.trim()
    if (id.length === 0) continue
    out[id] = { label: row.label, provider: row.provider, baseUrl: row.baseUrl, apiKeyRef: row.apiKeyRef }
  }
  return out
}

/** 某协议的 vendor id 列表(供 openai/minimax 卡片的 vendor 下拉)。 */
function vendorIdsOf(vendors: Record<string, VendorRecord>, provider: 'openai' | 'minimax'): string[] {
  return Object.entries(vendors)
    .filter(([, v]) => v.provider === provider)
    .map(([id]) => id)
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

/** 单个可调参数的滑块 + 数字输入控件;未配置时显示继承的 provider 顶层默认。 */
function ParamControl(props: {
  param: TunableParam
  value: number | undefined
  inherited: number
  onChange: (next: number | undefined) => void
}): JSX.Element {
  const { param } = props
  const display = props.value ?? props.inherited
  const inherited = props.value === undefined
  return (
    <div className="param-control">
      <div className="param-head">
        <span className="mono key">{param.key}</span>
        <span className="desc">{param.label}</span>
        <span className={`param-state${inherited ? ' inherited' : ''}`}>{inherited ? `继承 ${props.inherited}` : '自定义'}</span>
        {!inherited && (
          <button type="button" className="param-clear" onClick={() => props.onChange(undefined)} title="恢复继承 provider 顶层默认">清除</button>
        )}
      </div>
      <div className="param-row">
        <input type="range" min={param.min} max={param.max} step={param.step} value={display}
          onChange={e => props.onChange(Number(e.target.value))} />
        <input type="number" min={param.min} max={param.max} step={param.step}
          value={props.value ?? ''} placeholder={String(props.inherited)}
          onChange={e => props.onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
      </div>
    </div>
  )
}

/** 一个语言类别槽位编辑器:音色选择 + 动态参数控件(参数集随 provider)。 */
function SlotEditor(props: {
  slot: VoiceSlot
  voices: readonly Voice[]
  params: readonly TunableParam[]
  inherited: Record<string, number>
  label: string
  desc?: string
  expectedLang?: 'zh' | 'en'
  onChange: (next: VoiceSlot) => void
}): JSX.Element {
  const { slot } = props
  const setVoice = (voice_type: string): void => props.onChange({ ...slot, voice_type })
  const setParam = (key: string, value: number | undefined): void => {
    const next = { ...slot } as Record<string, unknown>
    if (value === undefined) delete next[key]
    else next[key] = value
    props.onChange(next as VoiceSlot)
  }
  return (
    <div className="slot-editor">
      <VoicePicker voices={props.voices} label={props.label} desc={props.desc} value={slot.voice_type ?? ''} expectedLang={props.expectedLang} onChange={setVoice} />
      {props.params.length > 0 && (
        <div className="slot-params">
          {props.params.map(param => (
            <ParamControl key={param.key} param={param} value={slotParamValue(slot, param.key)}
              inherited={props.inherited[param.key] ?? 0}
              onChange={next => setParam(param.key, next)} />
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

/** 双语共享字段(voice_type / bilingual / voices)。每个语言槽位含音色 + 可调参数。 */
function BilingualFields(props: {
  cfg: { voice_type: string; bilingual: string; voices: Voices }
  voices: readonly Voice[]
  params: readonly TunableParam[]
  inherited: Record<string, number>
  onChange: (patch: { voice_type?: string; bilingual?: 'both' | 'english_only' | 'chinese_only'; voices?: Voices }) => void
}): JSX.Element {
  const { cfg } = props
  const setSlot = (lang: 'zh' | 'en' | 'mixed', slot: VoiceSlot): void => {
    props.onChange({ voices: { ...cfg.voices, [lang]: slot } })
  }
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
      <div className="voice-slots">
        <SlotEditor slot={cfg.voices.zh ?? {}} voices={props.voices} params={props.params} inherited={props.inherited} label="voices.zh" desc="中文槽位" expectedLang="zh" onChange={slot => setSlot('zh', slot)} />
        <SlotEditor slot={cfg.voices.en ?? {}} voices={props.voices} params={props.params} inherited={props.inherited} label="voices.en" desc="英文槽位" expectedLang="en" onChange={slot => setSlot('en', slot)} />
        <SlotEditor slot={cfg.voices.mixed ?? {}} voices={props.voices} params={props.params} inherited={props.inherited} label="voices.mixed" desc="混合槽位" onChange={slot => setSlot('mixed', slot)} />
      </div>
    </>
  )
}

/** voice_profiles 行编辑器。 */
function ProfilesEditor(props: {
  profiles: Record<string, Voices>
  voices: readonly Voice[]
  params: readonly TunableParam[]
  inherited: Record<string, number>
  onChange: (next: Record<string, Voices>) => void
}): JSX.Element {
  // 本地编辑态:允许存在「空 id 行」供用户填写;提交时才把非空 id 行折叠成 profiles。
  // 不能直接从 props.profiles 派生 rows——空 id 行会被 rowsToProfiles 丢弃,导致「+ 添加映射」加的空行立即消失。
  const [rows, setRows] = useState<ProfileRow[]>(() => profilesToRows(props.profiles))
  const update = (next: ProfileRow[]): void => {
    setRows(next)
    props.onChange(rowsToProfiles(next))
  }
  const setSlot = (index: number, lang: 'zh' | 'en' | 'mixed', slot: VoiceSlot): void => {
    update(rows.map((r, i) => i === index ? { ...r, [lang]: slot } : r))
  }
  return (
    <div className="profiles">
      <div className="section-title">per-voice 音色映射 (voice_profiles)</div>
      {rows.map((row, index) => (
        <div className="profile-row" key={index}>
          <div className="profile-head">
            <input type="text" className="profile-id" placeholder="voice id (如 steve-jobs)" value={row.id}
              onChange={e => update(rows.map((r, i) => i === index ? { ...r, id: e.target.value } : r))} />
            <button type="button" className="refresh danger" onClick={() => update(rows.filter((_, i) => i !== index))}>删除</button>
          </div>
          <div className="voice-slots">
            <SlotEditor slot={row.zh} voices={props.voices} params={props.params} inherited={props.inherited} label="zh" expectedLang="zh" onChange={slot => setSlot(index, 'zh', slot)} />
            <SlotEditor slot={row.en} voices={props.voices} params={props.params} inherited={props.inherited} label="en" expectedLang="en" onChange={slot => setSlot(index, 'en', slot)} />
            <SlotEditor slot={row.mixed} voices={props.voices} params={props.params} inherited={props.inherited} label="mixed" onChange={slot => setSlot(index, 'mixed', slot)} />
          </div>
        </div>
      ))}
      <button type="button" className="refresh" onClick={() => update([...rows, { id: '', zh: {}, en: {}, mixed: {} }])}>+ 添加映射</button>
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
function VolcengineCard(props: { bootstrap: Bootstrap; cfg: VolcengineConfig; voices: readonly Voice[]; params: readonly TunableParam[]; dirty: number; onChange: (next: VolcengineConfig) => void; onSave: () => void }): JSX.Element {
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
      <BilingualFields cfg={cfg} voices={voices} params={props.params} inherited={inheritedParams(cfg, props.params)} onChange={patch => set(patch)} />
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
      <ProfilesEditor profiles={cfg.voice_profiles} voices={voices} params={props.params} inherited={inheritedParams(cfg, props.params)} onChange={next => set({ voice_profiles: next })} />
      <SaveBar dirty={props.dirty} onSave={props.onSave} />
    </div>
  )
}

/** siliconflow provider 卡片。 */
function SiliconflowCard(props: { bootstrap: Bootstrap; cfg: SiliconflowConfig; voices: readonly Voice[]; models: readonly string[]; params: readonly TunableParam[]; dirty: number; onChange: (next: SiliconflowConfig) => void; onSave: () => void }): JSX.Element {
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
      <BilingualFields cfg={cfg} voices={voices} params={props.params} inherited={inheritedParams(cfg, props.params)} onChange={patch => set(patch)} />
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
      <ProfilesEditor profiles={cfg.voice_profiles} voices={voices} params={props.params} inherited={inheritedParams(cfg, props.params)} onChange={next => set({ voice_profiles: next })} />
      <SaveBar dirty={props.dirty} onSave={props.onSave} />
    </div>
  )
}

/** host provider 卡片。 */
function HostCard(props: { cfg: HostConfig; voices: readonly Voice[]; dirty: number; onChange: (next: HostConfig) => void; onSave: () => void }): JSX.Element {
  const { cfg } = props
  const set = (patch: Partial<HostConfig>): void => props.onChange({ ...cfg, ...patch })
  return (
    <div className="card provider-card">
      <div className="section-title">host (本地 say · macOS)</div>
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">command</span><span className="desc">本地 TTS 命令绝对路径</span></span>
          <input type="text" value={cfg.command} onChange={e => set({ command: e.target.value })} placeholder="/usr/bin/say" />
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">rate</span><span className="desc">语速 wpm (-r)</span></span>
          <input type="number" min={1} max={600} value={cfg.rate} onChange={e => set({ rate: Number(e.target.value) || 175 })} />
        </label>
      </div>
      <BilingualFields cfg={cfg} voices={props.voices} params={[]} inherited={{}} onChange={patch => set(patch)} />
      <ProfilesEditor profiles={cfg.voice_profiles} voices={props.voices} params={[]} inherited={{}} onChange={next => set({ voice_profiles: next })} />
      <SaveBar dirty={props.dirty} onSave={props.onSave} />
    </div>
  )
}

/** vendor 注册表卡片:label / provider / baseUrl / apiKeyRef 的增删改。 */
function VendorsCard(props: {
  vendors: Record<string, VendorRecord>
  dirty: number
  onChange: (next: Record<string, VendorRecord>) => void
  onSave: () => void
}): JSX.Element {
  const [rows, setRows] = useState<VendorRow[]>(() => vendorsToRows(props.vendors))
  const update = (next: VendorRow[]): void => {
    setRows(next)
    props.onChange(rowsToVendors(next))
  }
  const set = (index: number, patch: Partial<VendorRow>): void =>
    update(rows.map((r, i) => i === index ? { ...r, ...patch } : r))
  return (
    <div className="card provider-card">
      <div className="section-title">vendors (endpoint 源)</div>
      <div className="meta">一个协议可挂多个 vendor(不同折扣的 baseUrl + apiKeyRef);openai/minimax 卡片从此选源。</div>
      {rows.map((row, index) => (
        <div className="vendor-row" key={index}>
          <div className="vendor-grid">
            <label className="field">
              <span className="field-head"><span className="mono key">id</span><span className="desc">唯一标识(providers 里引用)</span></span>
              <input type="text" value={row.id} placeholder="302ai-openai" onChange={e => set(index, { id: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-head"><span className="mono key">label</span><span className="desc">展示名</span></span>
              <input type="text" value={row.label} onChange={e => set(index, { label: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-head"><span className="mono key">provider</span><span className="desc">所属协议</span></span>
              <select value={row.provider} onChange={e => set(index, { provider: e.target.value as 'openai' | 'minimax' })}>
                {VENDOR_PROVIDERS.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          </div>
          <div className="vendor-grid">
            <label className="field">
              <span className="field-head"><span className="mono key">baseUrl</span><span className="desc">endpoint 前缀(明文,openai 需含 /v1)</span></span>
              <input type="text" value={row.baseUrl} placeholder="https://api.302.ai/v1" onChange={e => set(index, { baseUrl: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-head"><span className="mono key">apiKeyRef</span><span className="desc">KEY NAME(密钥引用名)</span></span>
              <input type="text" list="voice-tts-key-names" value={row.apiKeyRef} placeholder="TTS_302AI_API_KEY" onChange={e => set(index, { apiKeyRef: e.target.value })} />
            </label>
            <button type="button" className="refresh danger vendor-del" onClick={() => update(rows.filter((_, i) => i !== index))}>删除</button>
          </div>
        </div>
      ))}
      <button type="button" className="refresh" onClick={() => update([...rows, { id: '', label: '', provider: 'openai', baseUrl: '', apiKeyRef: '' }])}>+ 添加 vendor</button>
      <SaveBar dirty={props.dirty} onSave={props.onSave} />
    </div>
  )
}

/** OpenAI provider 卡片:vendor 选择 + 选中 vendor 的 key 管理 + 合成参数。 */
function OpenaiCard(props: {
  bootstrap: Bootstrap
  cfg: OpenaiConfig
  vendors: Record<string, VendorRecord>
  voices: readonly Voice[]
  models: readonly string[]
  params: readonly TunableParam[]
  dirty: number
  onChange: (next: OpenaiConfig) => void
  onSave: () => void
}): JSX.Element {
  const { cfg, vendors } = props
  const set = (patch: Partial<OpenaiConfig>): void => props.onChange({ ...cfg, ...patch })
  const vendorIds = vendorIdsOf(vendors, 'openai')
  const selected = vendors[cfg.vendor]
  return (
    <div className="card provider-card">
      <div className="section-title">openai (tts-1 / tts-1-hd)</div>
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">vendor</span><span className="desc">endpoint 源(在 Vendors 区管理)</span></span>
          <select value={cfg.vendor} onChange={e => set({ vendor: e.target.value })}>
            {vendorIds.length === 0 && <option value="">(no openai vendor)</option>}
            {vendorIds.map(id => <option key={id} value={id}>{vendors[id]!.label || id} — {id}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">baseUrl</span><span className="desc">来自选中 vendor(只读)</span></span>
          <input type="text" value={selected?.baseUrl ?? ''} disabled placeholder="(no vendor)" />
        </label>
      </div>
      {selected !== undefined
        ? <CredentialSection bootstrap={props.bootstrap} keyRef={selected.apiKeyRef} />
        : <div className="banner error">vendor "{cfg.vendor}" 不存在;到 Vendors 区添加或改选。</div>}
      <BilingualFields cfg={cfg} voices={props.voices} params={props.params} inherited={inheritedParams(cfg, props.params)} onChange={patch => set(patch)} />
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">model</span><span className="desc">TTS 模型</span></span>
          <select value={cfg.model} onChange={e => set({ model: e.target.value })}>
            {props.models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">instructions</span><span className="desc">情绪/语速/口音(仅 mini-tts;tts-1 忽略)</span></span>
          <input type="text" value={cfg.instructions} onChange={e => set({ instructions: e.target.value })} placeholder="(empty)" />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">format</span><span className="desc">file/stream 落盘格式</span></span>
          <select value={cfg.format} onChange={e => set({ format: e.target.value as OpenaiConfig['format'] })}>
            {['mp3', 'opus', 'aac', 'flac'].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">play_format</span><span className="desc">host_play 播放格式</span></span>
          <select value={cfg.play_format} onChange={e => set({ play_format: e.target.value as OpenaiConfig['play_format'] })}>
            {['mp3', 'opus', 'aac', 'flac'].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">speed</span><span className="desc">[0.25,4.0] 语速</span></span>
          <input type="number" min={0.25} max={4} step={0.05} value={cfg.speed} onChange={e => set({ speed: Number(e.target.value) || 1 })} />
        </label>
      </div>
      <ProfilesEditor profiles={cfg.voice_profiles} voices={props.voices} params={props.params} inherited={inheritedParams(cfg, props.params)} onChange={next => set({ voice_profiles: next })} />
      <SaveBar dirty={props.dirty} onSave={props.onSave} />
    </div>
  )
}

/** MiniMax provider 卡片:vendor 选择 + 选中 vendor 的 key 管理 + 合成参数。 */
function MinimaxCard(props: {
  bootstrap: Bootstrap
  cfg: MinimaxConfig
  vendors: Record<string, VendorRecord>
  voices: readonly Voice[]
  models: readonly string[]
  params: readonly TunableParam[]
  dirty: number
  onChange: (next: MinimaxConfig) => void
  onSave: () => void
}): JSX.Element {
  const { cfg, vendors } = props
  const set = (patch: Partial<MinimaxConfig>): void => props.onChange({ ...cfg, ...patch })
  const vendorIds = vendorIdsOf(vendors, 'minimax')
  const selected = vendors[cfg.vendor]
  return (
    <div className="card provider-card">
      <div className="section-title">minimax (speech-2.8-turbo)</div>
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">vendor</span><span className="desc">endpoint 源(在 Vendors 区管理)</span></span>
          <select value={cfg.vendor} onChange={e => set({ vendor: e.target.value })}>
            {vendorIds.length === 0 && <option value="">(no minimax vendor)</option>}
            {vendorIds.map(id => <option key={id} value={id}>{vendors[id]!.label || id} — {id}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">baseUrl</span><span className="desc">来自选中 vendor(只读)</span></span>
          <input type="text" value={selected?.baseUrl ?? ''} disabled placeholder="(no vendor)" />
        </label>
      </div>
      {selected !== undefined
        ? <CredentialSection bootstrap={props.bootstrap} keyRef={selected.apiKeyRef} />
        : <div className="banner error">vendor "{cfg.vendor}" 不存在;到 Vendors 区添加或改选。</div>}
      <BilingualFields cfg={cfg} voices={props.voices} params={props.params} inherited={inheritedParams(cfg, props.params)} onChange={patch => set(patch)} />
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">model</span><span className="desc">TTS 模型</span></span>
          <select value={cfg.model} onChange={e => set({ model: e.target.value })}>
            {props.models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">emotion</span><span className="desc">情感(留空不发送)</span></span>
          <input type="text" value={cfg.emotion} onChange={e => set({ emotion: e.target.value })} placeholder="(empty)" />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">speed</span><span className="desc">[0.5,2.0] 语速</span></span>
          <input type="number" min={0.5} max={2} step={0.1} value={cfg.speed} onChange={e => set({ speed: Number(e.target.value) || 1 })} />
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">vol</span><span className="desc">(0,10] 音量</span></span>
          <input type="number" min={0.1} max={10} step={0.1} value={cfg.vol} onChange={e => set({ vol: Number(e.target.value) || 1 })} />
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">pitch</span><span className="desc">[-12,12] 音调</span></span>
          <input type="number" min={-12} max={12} step={1} value={cfg.pitch} onChange={e => set({ pitch: Number(e.target.value) || 0 })} />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">format</span><span className="desc">file/stream 落盘格式</span></span>
          <select value={cfg.format} onChange={e => set({ format: e.target.value as MinimaxConfig['format'] })}>
            {['mp3', 'pcm', 'flac', 'wav'].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">play_format</span><span className="desc">host_play 播放格式</span></span>
          <select value={cfg.play_format} onChange={e => set({ play_format: e.target.value as MinimaxConfig['play_format'] })}>
            {['mp3', 'pcm', 'flac', 'wav'].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">sample_rate</span><span className="desc">[8000,48000] Hz</span></span>
          <input type="number" min={8000} max={48000} value={cfg.sample_rate} onChange={e => set({ sample_rate: Number(e.target.value) || 32000 })} />
        </label>
      </div>
      <div className="field-row">
        <label className="field">
          <span className="field-head"><span className="mono key">bitrate</span><span className="desc">[32000,256000] 仅 mp3</span></span>
          <input type="number" min={32000} max={256000} value={cfg.bitrate} onChange={e => set({ bitrate: Number(e.target.value) || 128000 })} />
        </label>
        <label className="field">
          <span className="field-head"><span className="mono key">channel</span><span className="desc">声道数</span></span>
          <select value={cfg.channel} onChange={e => set({ channel: Number(e.target.value) as 1 | 2 })}>
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </label>
      </div>
      <ProfilesEditor profiles={cfg.voice_profiles} voices={props.voices} params={props.params} inherited={inheritedParams(cfg, props.params)} onChange={next => set({ voice_profiles: next })} />
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
  const [voices, setVoices] = useState<Record<string, Voice[]>>({ volcengine: [], 'siliconflow-cn': [], host: [], openai: [], minimax: [] })
  const [models, setModels] = useState<Record<string, string[]>>({ volcengine: [], 'siliconflow-cn': [], host: [], openai: [], minimax: [] })
  const [params, setParams] = useState<Record<string, TunableParam[]>>({ volcengine: [], 'siliconflow-cn': [], host: [], openai: [], minimax: [] })
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (bootstrap === undefined) return
    Promise.all([
      rpc<{ config: Settings }>(bootstrap, 'config-get'),
      rpc<{ status: Status }>(bootstrap, 'status-get'),
      rpc<{ voices: Voice[]; models: string[]; params: TunableParam[] }>(bootstrap, 'voices-list', { provider: 'volcengine' }),
      rpc<{ voices: Voice[]; models: string[]; params: TunableParam[] }>(bootstrap, 'voices-list', { provider: 'siliconflow-cn' }),
      rpc<{ voices: Voice[]; models: string[]; params: TunableParam[] }>(bootstrap, 'voices-list', { provider: 'host' }),
      rpc<{ voices: Voice[]; models: string[]; params: TunableParam[] }>(bootstrap, 'voices-list', { provider: 'openai' }),
      rpc<{ voices: Voice[]; models: string[]; params: TunableParam[] }>(bootstrap, 'voices-list', { provider: 'minimax' }),
    ]).then(([c, s, v1, v2, v3, v4, v5]) => {
      setConfig(c.config)
      setSaved(c.config)
      setStatus(s.status)
      setVoices({ volcengine: v1.voices, 'siliconflow-cn': v2.voices, host: v3.voices, openai: v4.voices, minimax: v5.voices })
      setModels({ volcengine: v1.models, 'siliconflow-cn': v2.models, host: v3.models, openai: v4.models, minimax: v5.models })
      setParams({ volcengine: v1.params, 'siliconflow-cn': v2.params, host: v3.params, openai: v4.params, minimax: v5.params })
    }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [bootstrap])

  const saveRegion = useCallback(async (region: Region): Promise<void> => {
    if (bootstrap === undefined || config === null || saved === null) return
    const toSave: Settings = {
      delivery: region === 'global' ? config.delivery : saved.delivery,
      provider: region === 'global' ? config.provider : saved.provider,
      storage: region === 'global' ? config.storage : saved.storage,
      player: region === 'global' ? config.player : saved.player,
      vendors: region === 'vendors' ? config.vendors : saved.vendors,
      providers: {
        volcengine: region === 'volcengine' ? config.providers.volcengine : saved.providers.volcengine,
        'siliconflow-cn': region === 'siliconflow-cn' ? config.providers['siliconflow-cn'] : saved.providers['siliconflow-cn'],
        host: region === 'host' ? config.providers.host : saved.providers.host,
        openai: region === 'openai' ? config.providers.openai : saved.providers.openai,
        minimax: region === 'minimax' ? config.providers.minimax : saved.providers.minimax,
      },
    }
    try {
      const v = await rpc<{ config: Settings }>(bootstrap, 'config-set', { config: toSave })
      setSaved(v.config)
      setConfig(prev => prev === null ? v.config : {
        delivery: region === 'global' ? v.config.delivery : prev.delivery,
        provider: region === 'global' ? v.config.provider : prev.provider,
        storage: region === 'global' ? v.config.storage : prev.storage,
        player: region === 'global' ? v.config.player : prev.player,
        vendors: region === 'vendors' ? v.config.vendors : prev.vendors,
        providers: {
          volcengine: region === 'volcengine' ? v.config.providers.volcengine : prev.providers.volcengine,
          'siliconflow-cn': region === 'siliconflow-cn' ? v.config.providers['siliconflow-cn'] : prev.providers['siliconflow-cn'],
          host: region === 'host' ? v.config.providers.host : prev.providers.host,
          openai: region === 'openai' ? v.config.providers.openai : prev.providers.openai,
          minimax: region === 'minimax' ? v.config.providers.minimax : prev.providers.minimax,
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
    { delivery: config.delivery, provider: config.provider, storage: config.storage, player: config.player },
    { delivery: saved.delivery, provider: saved.provider, storage: saved.storage, player: saved.player },
  )
  const vendorsDirty = countDiff(config.vendors, saved.vendors)
  const volDirty = countDiff(config.providers.volcengine, saved.providers.volcengine)
  const sfDirty = countDiff(config.providers['siliconflow-cn'], saved.providers['siliconflow-cn'])
  const hostDirty = countDiff(config.providers.host, saved.providers.host)
  const openaiDirty = countDiff(config.providers.openai, saved.providers.openai)
  const minimaxDirty = countDiff(config.providers.minimax, saved.providers.minimax)

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
          <div className="field-row">
            <label className="field">
              <span className="field-head"><span className="mono key">storage.scope</span><span className="desc">音频落盘层级（user 用户默认 / project 仓库本地）</span></span>
              <select value={config.storage.scope} onChange={e => setConfig(prev => prev === null ? prev : { ...prev, storage: { ...prev.storage, scope: e.target.value as 'user' | 'project' } })}>
                <option value="user">user</option>
                <option value="project">project</option>
              </select>
            </label>
            <label className="field">
              <span className="field-head"><span className="mono key">storage.dir</span><span className="desc">自定义绝对路径（空 = 按 scope 解析）</span></span>
              <input value={config.storage.dir} onChange={e => setConfig(prev => prev === null ? prev : { ...prev, storage: { ...prev.storage, dir: e.target.value } })} />
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span className="field-head"><span className="mono key">player.command</span><span className="desc">本机播放器命令路径（空 = 自动探测 ffplay → afplay）</span></span>
              <input value={config.player.command} onChange={e => setConfig(prev => prev === null ? prev : { ...prev, player: { command: e.target.value } })} />
            </label>
          </div>
          <SaveBar dirty={globalDirty} onSave={() => void saveRegion('global')} />
        </div>
        <VolcengineCard bootstrap={bootstrap} cfg={config.providers.volcengine} voices={voices.volcengine} params={params.volcengine} dirty={volDirty}
          onChange={next => setConfig(prev => prev === null ? prev : { ...prev, providers: { ...prev.providers, volcengine: next } })}
          onSave={() => void saveRegion('volcengine')} />
        <SiliconflowCard bootstrap={bootstrap} cfg={config.providers['siliconflow-cn']} voices={voices['siliconflow-cn']} models={models['siliconflow-cn']} params={params['siliconflow-cn']} dirty={sfDirty}
          onChange={next => setConfig(prev => prev === null ? prev : { ...prev, providers: { ...prev.providers, 'siliconflow-cn': next } })}
          onSave={() => void saveRegion('siliconflow-cn')} />
        <HostCard cfg={config.providers.host} voices={voices.host} dirty={hostDirty}
          onChange={next => setConfig(prev => prev === null ? prev : { ...prev, providers: { ...prev.providers, host: next } })}
          onSave={() => void saveRegion('host')} />
        <VendorsCard vendors={config.vendors} dirty={vendorsDirty}
          onChange={next => setConfig(prev => prev === null ? prev : { ...prev, vendors: next })}
          onSave={() => void saveRegion('vendors')} />
        <OpenaiCard bootstrap={bootstrap} cfg={config.providers.openai} vendors={config.vendors} voices={voices.openai} models={models.openai} params={params.openai} dirty={openaiDirty}
          onChange={next => setConfig(prev => prev === null ? prev : { ...prev, providers: { ...prev.providers, openai: next } })}
          onSave={() => void saveRegion('openai')} />
        <MinimaxCard bootstrap={bootstrap} cfg={config.providers.minimax} vendors={config.vendors} voices={voices.minimax} models={models.minimax} params={params.minimax} dirty={minimaxDirty}
          onChange={next => setConfig(prev => prev === null ? prev : { ...prev, providers: { ...prev.providers, minimax: next } })}
          onSave={() => void saveRegion('minimax')} />
        <datalist id="voice-tts-key-names">
          {KNOWN_KEY_NAMES.map(name => <option key={name} value={name} />)}
        </datalist>
      </div>
    </div>
  )
}
