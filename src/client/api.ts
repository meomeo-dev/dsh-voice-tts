/**
 * browser half 的 host RPC 客户端：POST 到插件自有 `/voice-tts/*` 路由并解码 JSON。
 * 只做线协议编解码与错误折叠，不解析业务数据。
 */

/** turn-final 交付方式（镜像 host 侧 DeliveryMode）。 */
export type DeliveryMode = 'off' | 'file' | 'host_play' | 'stream'

/** `/voice-tts/state` 返回的 slot 状态。 */
export interface SlotState {
  delivery: DeliveryMode
  /** delivery 非 off 即「开启」。 */
  on: boolean
  /** host 是否正在后台播放。 */
  playing: boolean
}

/** 切换 on/off 的返回。 */
export interface ToggleResult {
  delivery: DeliveryMode
  on: boolean
}

/**
 * POST 一个 JSON 请求到插件自有路由并解码 JSON 响应体。
 * @param path - 路由路径名（同源相对路径）。
 * @param body - 请求载荷。
 * @returns 解码后的值。
 * @throws 当 HTTP 失败或 host 返回 `{ error }`。
 */
export async function routeFetch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
    throw new Error(payload?.error?.message ?? `请求失败 (${response.status})`)
  }
  return await response.json() as T
}

/** 读当前 delivery + 播放状态。 */
export function getState(): Promise<SlotState> {
  return routeFetch<SlotState>('/voice-tts/state', {})
}

/** 切换 on/off，返回切换后的 delivery。 */
export function toggle(): Promise<ToggleResult> {
  return routeFetch<ToggleResult>('/voice-tts/toggle', {})
}

/** 停掉后台播放。 */
export function stop(): Promise<{ playing: boolean }> {
  return routeFetch<{ playing: boolean }>('/voice-tts/stop', {})
}

/** 读面板 URL（无面板时为 null）。 */
export function getPanelUrl(): Promise<{ url: string | null }> {
  return routeFetch<{ url: string | null }>('/voice-tts/panel-url', {})
}
