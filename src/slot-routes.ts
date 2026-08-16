/**
 * dsh-voice-tts Web UI 入口(slot)的 host HTTP 路由(loopback-only)。
 *
 * browser half 无法直达 host service,核心 API 网关是封闭契约,故本插件挂自己的
 * `/voice-tts/*` 路由,供 browser half 同源 fetch。路由只读/写 delivery 设置、
 * 停后台播放、返回面板 URL;循环回环地址(`127.0.0.1`)才提供,非 loopback 时
 * fail-loud,防止网络暴露。
 * @module dsh-voice-tts/slot-routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { DeliveryMode } from './types.js'

/** 路由的注入依赖(由 index.ts 闭包提供)。 */
export interface SlotRoutesDeps {
  /** 当前 delivery + 是否正在后台播放。 */
  state(): { delivery: DeliveryMode; playing: boolean }
  /** 切换 on/off(记住上次非 off 值),返回切换后的 delivery。 */
  toggle(): Promise<DeliveryMode>
  /** 停掉后台播放。 */
  stopPlay(): void
  /** 面板 URL(无面板时为 null)。 */
  panelUrl(): string | null
}

/** 请求体字节上限。 */
const MAX_BODY_BYTES = 64 * 1024

/** 消息文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** HTTP 失败(业务失败统一 400)。 */
class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'RouteError'
  }
}

/** 读一个 JSON 请求体(强制 application/json 触发 preflight + 体积上限)。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') throw new RouteError(415, 'content type must be application/json')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new RouteError(413, 'request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new RouteError(400, 'body is not JSON')
  }
}

/** 写一个 JSON 响应。 */
function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** 包一层 read-validate-answer。 */
async function serve(res: ServerResponse, run: () => Promise<unknown>): Promise<void> {
  try {
    writeJson(res, 200, await run())
  } catch (error) {
    const status = error instanceof RouteError ? error.status : 400
    writeJson(res, status, { error: { message: messageOf(error) } })
  }
}

/**
 * 挂 `/voice-tts/state|toggle|stop|panel-url` 路由。
 * @param ctx - 插件上下文(webServer 已确认存在)。
 * @param deps - 状态读写与播放控制。
 */
export function registerSlotRoutes(ctx: Context, deps: SlotRoutesDeps): void {
  if (ctx.webServer.host !== '127.0.0.1') {
    throw new Error('dsh-voice-tts: /voice-tts/* is loopback-only; refuse to serve on a non-loopback host')
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-tts/state',
    handler: async (req, res) => {
      await serve(res, async () => {
        await readJsonBody(req)
        const { delivery, playing } = deps.state()
        return { delivery, on: delivery !== 'off', playing }
      })
    },
  }), 'dsh-voice-tts: /voice-tts/state')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-tts/toggle',
    handler: async (req, res) => {
      await serve(res, async () => {
        await readJsonBody(req)
        const delivery = await deps.toggle()
        return { delivery, on: delivery !== 'off' }
      })
    },
  }), 'dsh-voice-tts: /voice-tts/toggle')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-tts/stop',
    handler: async (req, res) => {
      await serve(res, async () => {
        await readJsonBody(req)
        deps.stopPlay()
        return { playing: false }
      })
    },
  }), 'dsh-voice-tts: /voice-tts/stop')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/voice-tts/panel-url',
    handler: async (req, res) => {
      await serve(res, async () => {
        await readJsonBody(req)
        return { url: deps.panelUrl() }
      })
    },
  }), 'dsh-voice-tts: /voice-tts/panel-url')
}
