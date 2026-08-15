/**
 * 面板的 host RPC 客户端:信封 {type:"client-request",rpcId,method,payload},
 * payload 恒携带 acToken。只做线协议编解码与错误折叠,不解析业务数据。
 */

/** HTML 壳注入的引导数据(见 host 侧 renderPanelShell)。 */
export interface Bootstrap {
  readonly token: string
  readonly channel: string
}

/** 从 #dsh-voice-tts-bootstrap 读引导数据;缺失/非法返回 undefined(页面显示错误)。 */
export function readBootstrap(): Bootstrap | undefined {
  const el = document.getElementById('dsh-voice-tts-bootstrap')
  if (el === null || el.textContent === null) return undefined
  try {
    const value = JSON.parse(el.textContent) as unknown
    if (typeof value !== 'object' || value === null) return undefined
    const { token, channel } = value as Record<string, unknown>
    if (typeof token !== 'string' || typeof channel !== 'string') return undefined
    return { token, channel }
  } catch {
    return undefined
  }
}

/** 各语言类别音色覆盖(镜像 host 侧 VoiceTtsVoices)。 */
export interface Voices {
  readonly zh?: string
  readonly en?: string
  readonly mixed?: string
}

/** provider 无关的双语 + 音色映射字段。 */
export interface BilingualFields {
  voice_type: string
  bilingual: 'both' | 'english_only' | 'chinese_only'
  voices: Voices
  voice_profiles: Record<string, Voices>
}

/** volcengine provider 配置(镜像 host 侧 VolcengineProviderSettings)。 */
export interface VolcengineConfig extends BilingualFields {
  apiKeyRef: string
  resource_id: 'seed-tts-2.0' | 'seed-icl-2.0'
  model: string
  format: 'mp3' | 'pcm' | 'ogg_opus' | 'wav'
  play_format: 'mp3' | 'pcm' | 'ogg_opus' | 'wav'
  sample_rate: number
  speech_rate: number
  loudness_rate: number
  pitch: number
}

/** siliconflow provider 配置(镜像 host 侧 SiliconflowProviderSettings)。 */
export interface SiliconflowConfig extends BilingualFields {
  apiKeyRef: string
  model: string
  format: 'mp3' | 'opus' | 'wav' | 'pcm'
  play_format: 'mp3' | 'opus' | 'wav' | 'pcm'
  sample_rate: number
  speed: number
  gain: number
}

/** voice-tts 设置(镜像 host 侧 VoiceTtsSettings)。 */
export interface Settings {
  delivery: 'off' | 'file' | 'host_play' | 'stream'
  provider: string
  providers: {
    volcengine: VolcengineConfig
    'siliconflow-cn': SiliconflowConfig
  }
}

/** 状态预览(镜像 host 侧 PanelStatus)。 */
export interface Status {
  readonly voiceId: string | null
  readonly matchedProfile: boolean
  readonly voices: { readonly zh: string; readonly en: string; readonly mixed: string }
}

/** 一条音色(镜像 host 侧 TtsVoice 的展示子集)。 */
export interface Voice {
  readonly voice_type: string
  readonly name: string
  readonly scene: string
  readonly lang: string
  readonly ability: string
  /** 归属表:`standard` / `multilingual`。 */
  readonly group?: string
  /** 主要语种:`zh` / `en` / 其他 ISO 代码 / `multi`(多语种),供 zh/en 槽位软提示。 */
  readonly primaryLang?: string
}

/** API key 只读状态(镜像 host 侧 PanelKeyStatus)。 */
export interface KeyStatus {
  readonly configured: boolean
  readonly source: string | null
  readonly writable: boolean
}

let rpcCounter = 0

/**
 * 调一次面板 RPC。
 * @param bootstrap - 引导数据(token / channel)。
 * @param endpoint - channel 相对端点。
 * @param payload - 端点载荷(自动附带 acToken)。
 * @returns 成功分支的 value。
 * @throws 当 HTTP 失败或 host 返回 {ok:false}(错误文本来自 host)。
 */
export async function rpc<T>(
  bootstrap: Bootstrap,
  endpoint: string,
  payload: Record<string, unknown> = {},
): Promise<T> {
  const rpcId = `panel-${++rpcCounter}`
  const response = await fetch(`${bootstrap.channel}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: { ...payload, acToken: bootstrap.token },
    }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json() as {
    readonly result: { readonly ok: boolean; readonly value?: T; readonly error?: { readonly message: string } }
  }
  if (!body.result.ok) throw new Error(body.result.error?.message ?? 'unknown host error')
  return body.result.value as T
}
