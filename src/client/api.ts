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

/** 某 turn 缓存音频的状态（镜像 host 侧 `TurnAudioStatus`）。 */
export interface TurnAudioStatus {
  exists: boolean
  segments: number
  format: string | null
}

/** 查某 turn 是否有缓存音频。 */
export function audioStatus(sessionId: string, turn: number): Promise<TurnAudioStatus> {
  return routeFetch<TurnAudioStatus>('/voice-tts/audio-status', { sessionId, turn })
}

/** 重新生成某 turn 的最终回复语音。 */
export function regenerate(sessionId: string, turn: number): Promise<TurnAudioStatus> {
  return routeFetch<TurnAudioStatus>('/voice-tts/regenerate', { sessionId, turn })
}

/** 某 turn 某段缓存音频的 URL（`<audio src>` 走 GET）。 */
export function audioUrl(sessionId: string, turn: number, index: number): string {
  return `/voice-tts/audio?sessionId=${encodeURIComponent(sessionId)}&turn=${encodeURIComponent(String(turn))}&index=${encodeURIComponent(String(index))}`
}

/** 播放状态快照（镜像 host 侧 `PlaybackState`）。 */
export interface PlaybackState {
  active: boolean
  mode: 'host' | 'ui' | null
  sessionId: string | null
  turn: number | null
  segmentIndex: number | null
  segmentCount: number | null
  status: 'playing' | 'paused' | null
  positionMs: number
  durationMs: number | null
}

/** 读当前播放状态。 */
export function getPlayback(): Promise<PlaybackState> {
  return routeFetch<PlaybackState>('/voice-tts/playback', {})
}

/** 停止 host 播放。 */
export function stopPlayback(): Promise<PlaybackState> {
  return routeFetch<PlaybackState>('/voice-tts/playback/stop', {})
}

/** 从缓存重播某 turn(host 播放,ffplay;播放 AIFF/PCM 等浏览器不可播格式)。 */
export function playPlayback(sessionId: string, turn: number): Promise<PlaybackState> {
  return routeFetch<PlaybackState>('/voice-tts/playback/play', { sessionId, turn })
}

/** 暂停 host 播放。 */
export function pausePlayback(): Promise<PlaybackState> {
  return routeFetch<PlaybackState>('/voice-tts/playback/pause', {})
}

/** 恢复 host 播放。 */
export function resumePlayback(): Promise<PlaybackState> {
  return routeFetch<PlaybackState>('/voice-tts/playback/resume', {})
}

/** 定位 host 播放。 */
export function seekPlayback(ms: number): Promise<PlaybackState> {
  return routeFetch<PlaybackState>('/voice-tts/playback/seek', { ms })
}

/** 浏览器 `<audio>` 宣称开始播某 turn。 */
export function claimPlayback(sessionId: string, turn: number): Promise<PlaybackState> {
  return routeFetch<PlaybackState>('/voice-tts/playback/claim', { sessionId, turn })
}

/** 浏览器 `<audio>` 释放。 */
export function releasePlayback(): Promise<PlaybackState> {
  return routeFetch<PlaybackState>('/voice-tts/playback/release', {})
}
