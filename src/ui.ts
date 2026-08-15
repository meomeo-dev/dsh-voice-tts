/**
 * dsh-voice-tts Web 配置面板(path B 独立页)的纯逻辑:token、页面路由、RPC 通道。
 *
 * 面板 = host 侧一个 GET 路由(`/voice-tts`,须 `?ac_token=`)+ 一个静态资源前缀
 * (`/voice-tts-assets/`)+ 一个 RPC channel(`/voice-tts-api`,经 connection.handle
 * 注册,authority: 'loopback',每个请求自动过 dsh 信任栅栏)。本模块不 import cordis:
 * token 生成/比较、URL 构造、HTML 壳渲染、资源路径防穿越、RPC 载荷校验与分发都是
 * 纯函数;路由与 channel 的注册编排在 index.ts。
 *
 * 安全模型(三层,对齐 dsh-memory):
 *   1. token 门:`ac_token` 每次进程启动重新生成,GET 页面 / 静态资源 / RPC
 *      载荷三层都校验(常量时间比较)。
 *   2. 信任栅栏:RPC channel 由 dsh 的 connection.rpc.handle 注册,浏览器请求过
 *      同源检查,非浏览器客户端必须来自 loopback。
 *   3. XSS:CSP `default-src 'none'` + React textContent 渲染,key 值永不回显、
 *      永不进 innerHTML 路径。
 *
 * @module dsh-voice-tts/ui
 */

import { existsSync, readFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { resolvedVoice } from './bilingual.js'
import type { BilingualVoiceConfig, TtsVoice, VoiceTtsSettings } from './types.js'

// ---- token ----

/** 面板 token 的随机字节数(32 字节 → 64 hex 字符)。 */
const TOKEN_BYTES = 32

/** 生成一次进程生命周期的面板访问 token(crypto 随机)。 */
export function generatePanelToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/** 常量时间比较两个 token(先比长度,避免时序侧信道泄露前缀)。 */
export function safeTokenEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** 从请求 URL 提取 `ac_token` 查询参数;缺失或 URL 非法时返回 undefined。 */
export function queryToken(rawUrl: string | undefined): string | undefined {
  try {
    const value = new URL(rawUrl ?? '/', 'http://x').searchParams.get('ac_token')
    return value ?? undefined
  } catch {
    return undefined
  }
}

// ---- 页面与 URL ----

/** 面板页面路径(单页,无尾斜杠)。 */
export const PANEL_PAGE = '/voice-tts'

/** 面板 RPC channel 名(与 index.ts 的 connection.rpc.handle 注册一致)。 */
export const PANEL_CHANNEL = '/voice-tts-api'

/** 面板静态资源的路径前缀。 */
export const ASSET_PREFIX = '/voice-tts-assets/'

/** 构造带 `ac_token` 的面板 URL(仅 loopback 地址)。 */
export function panelUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}${PANEL_PAGE}?ac_token=${token}`
}

// ---- 静态资源 ----

/** 允许直发的资源后缀白名单。 */
const ASSET_EXTENSIONS = new Set(['.js', '.css', '.map', '.svg', '.png', '.woff2'])

/** 把 `/voice-tts-assets/<file>` 解析为 panel 目录内的绝对文件路径。 */
export function resolvePanelAsset(panelDir: string, pathname: string): string | undefined {
  if (!pathname.startsWith(ASSET_PREFIX)) return undefined
  const rest = pathname.slice(ASSET_PREFIX.length)
  if (rest.length === 0 || rest.includes('/') || rest.includes('\\') || rest.includes('..')) return undefined
  if (!ASSET_EXTENSIONS.has(extname(rest).toLowerCase())) return undefined
  const file = resolve(panelDir, rest)
  return file.startsWith(resolve(panelDir) + sep) ? file : undefined
}

/** 资源后缀 → HTTP content-type。 */
export function assetContentType(file: string): string {
  switch (extname(file).toLowerCase()) {
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.map': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.woff2': return 'font/woff2'
    default: return 'application/octet-stream'
  }
}

/** 读一个 panel 目录内的静态资源(经 {@link resolvePanelAsset} 防穿越)。 */
export function readPanelAsset(panelDir: string, pathname: string): Buffer | undefined {
  const file = resolvePanelAsset(panelDir, pathname)
  if (file === undefined) return undefined
  try {
    return readFileSync(file)
  } catch {
    return undefined
  }
}

// ---- HTML 壳 ----

/** 面板引导数据(注入 HTML 的 JSON bootstrap)。 */
export interface PanelBootstrap {
  /** 面板访问 token(React 应用用它调 RPC)。 */
  readonly token: string
  /** RPC channel 前缀(与 connection.rpc.handle 注册一致)。 */
  readonly channel: string
}

/** 序列化 bootstrap JSON;转义 `<` 防止内容破坏 script 边界。 */
function bootstrapJson(bootstrap: PanelBootstrap): string {
  return JSON.stringify(bootstrap).replace(/</g, '\\u003c')
}

/**
 * 渲染面板 HTML 壳:自包含,零外部 CDN。CSP 收紧到
 * `default-src 'none'` + 本源的 script/style/img/font/connect;
 * React 应用由 `/voice-tts-assets/panel.js` 挂载到 `#root`。
 */
export function renderPanelShell(bootstrap: PanelBootstrap): string {
  const tokenQuery = `?ac_token=${encodeURIComponent(bootstrap.token)}`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'">
<title>dsh-voice-tts panel</title>
<link rel="stylesheet" href="${ASSET_PREFIX}style.css${tokenQuery}">
</head>
<body>
<div id="root"></div>
<script id="dsh-voice-tts-bootstrap" type="application/json">${bootstrapJson(bootstrap)}</script>
<script type="module" src="${ASSET_PREFIX}panel.js${tokenQuery}"></script>
</body>
</html>`
}

/**
 * panel 构建产物的候选目录(编译后 lib 运行与源码运行的相对位置不同):
 * lib 运行 = <pkg>/lib/ui.js → 上溯 2 级到包根;源码运行 = <pkg>/src/ui.ts →
 * 上溯 1 级到包根。产物恒在包根 panel/dist(与 npm files 一致)。
 */
const PANEL_DIST_CANDIDATES = [
  new URL('../../panel/dist/', import.meta.url),
  new URL('../panel/dist/', import.meta.url),
]

/** 定位 panel 构建产物目录:首个含 `panel.js` 的候选。 */
export function findPanelDist(): string | undefined {
  for (const candidate of PANEL_DIST_CANDIDATES) {
    const dir = fileURLToPath(candidate)
    if (existsSync(resolve(dir, 'panel.js'))) return dir
  }
  return undefined
}

// ---- 状态预览 ----

/** 状态预览条:当前 dsh-voice id + 生效音色解析。 */
export interface PanelStatus {
  /** 当前 dsh-voice 的 voice id(无 dsh-voice 时为 null)。 */
  readonly voiceId: string | null
  /** 是否命中 voice_profiles 里的某个 profile(否则回退缺省 voices)。 */
  readonly matchedProfile: boolean
  /** 各语言类别最终音色(profile → voices → voice_type 三级回退后的结果)。 */
  readonly voices: { readonly zh: string; readonly en: string; readonly mixed: string }
}

/** 计算状态预览:复用合成管线同源的 `resolvedVoice`,避免两处漂移。 */
export function describeStatus(config: BilingualVoiceConfig, voiceId: string | undefined): PanelStatus {
  const matched = voiceId !== undefined && config.voice_profiles[voiceId] !== undefined
  return {
    voiceId: voiceId ?? null,
    matchedProfile: matched,
    voices: {
      zh: resolvedVoice('zh', config, voiceId),
      en: resolvedVoice('en', config, voiceId),
      mixed: resolvedVoice('mixed', config, voiceId),
    },
  }
}

// ---- RPC ----

/** API key 的只读状态(不回显值)。 */
export interface PanelKeyStatus {
  readonly configured: boolean
  readonly source: string | null
  readonly writable: boolean
}

/** 面板 RPC channel 的注入依赖(纯接口,由 index.ts 闭包提供)。 */
export interface PanelDeps {
  /** 当前解析后的 voice-tts 设置。 */
  getConfig(): VoiceTtsSettings
  /** 全量写回设置(经 settings scope 校验),返回写入后的解析值。 */
  setConfig(config: Record<string, unknown>): Promise<VoiceTtsSettings>
  /** 状态预览(当前 provider + 生效音色)。 */
  status(): PanelStatus
  /** 某 provider 的音色表。 */
  listVoices(providerId: string): readonly TtsVoice[]
  /** 某凭证引用(KEY NAME)的只读状态。 */
  keyStatus(ref: string): Promise<PanelKeyStatus>
  /** 写某凭证引用(KEY NAME)的值(走 credentials seam)。 */
  setKey(ref: string, value: string): Promise<void>
  /** 删某凭证引用(KEY NAME)。 */
  unsetKey(ref: string): Promise<void>
}

/** 只带 token 的请求载荷(config-get / status-get)。 */
interface TokenPayload {
  acToken: string
}

/** 带 provider 的请求载荷(voices-list)。 */
interface ProviderPayload {
  acToken: string
  provider: string
}

/** 带凭证引用名(KEY NAME)的请求载荷(key-status / key-unset)。 */
interface RefPayload {
  acToken: string
  ref: string
}

/** `config-set` 请求载荷:token + 完整配置对象。 */
interface ConfigSetPayload {
  acToken: string
  config: Record<string, unknown>
}

/** `key-set` 请求载荷:token + 凭证引用名 + 待写入的值。 */
interface KeySetPayload {
  acToken: string
  ref: string
  value: string
}

const TOKEN_PAYLOAD: z<TokenPayload> = z.object({
  acToken: z.string().min(1).required(),
})

const PROVIDER_PAYLOAD: z<ProviderPayload> = z.object({
  acToken: z.string().min(1).required(),
  provider: z.string().min(1).required(),
})

const REF_PAYLOAD: z<RefPayload> = z.object({
  acToken: z.string().min(1).required(),
  ref: z.string().min(1).required(),
})

const CONFIG_SET_PAYLOAD: z<ConfigSetPayload> = z.object({
  acToken: z.string().min(1).required(),
  config: z.object({}).required(),
})

const KEY_SET_PAYLOAD: z<KeySetPayload> = z.object({
  acToken: z.string().min(1).required(),
  ref: z.string().min(1).required(),
  value: z.string().min(1).required(),
})

/** 载荷解析结果。 */
type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/** 用 schemastery 校验线协议载荷(不通过返回错误文本)。 */
function parsePayload<T>(schema: z<T>, payload: unknown): Parsed<T> {
  try {
    return { ok: true, value: schema(payload as T | null | undefined) }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 载荷携带的 acToken 是否与服务端持有的一致(常量时间比较)。 */
function authorized(payload: unknown, token: string): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const acToken = (payload as Record<string, unknown>).acToken
  return typeof acToken === 'string' && safeTokenEqual(acToken, token)
}

/** 构造 RPC 失败结果(只用 bad-request / internal 两个码)。 */
function panelError<T>(code: 'bad-request' | 'internal', message: string): RpcResult<T> {
  return code === 'internal'
    ? { ok: false, error: { code: 'internal', message, details: {} } }
    : { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

/**
 * 面板 RPC 分发:token 门 → 载荷校验 → 注入依赖调用。
 *
 * 端点:config-get(读配置)/ config-set(全量写配置)/ status-get(状态预览)/
 * voices-list(音色表)/ key-status(读 key 状态)/ key-set / key-unset。
 * 未知端点与非法载荷一律 bad-request;依赖抛错折叠为 internal。
 */
export async function handlePanelRpc(
  endpoint: string,
  payload: unknown,
  token: string,
  deps: PanelDeps,
): Promise<RpcResult<unknown>> {
  try {
    switch (endpoint) {
      case 'config-get': {
        if (!authorized(payload, token)) return panelError('bad-request', 'missing or invalid acToken')
        const parsed = parsePayload(TOKEN_PAYLOAD, payload)
        if (!parsed.ok) return panelError('bad-request', parsed.message)
        return { ok: true, value: { config: deps.getConfig() } }
      }
      case 'config-set': {
        if (!authorized(payload, token)) return panelError('bad-request', 'missing or invalid acToken')
        const parsed = parsePayload(CONFIG_SET_PAYLOAD, payload)
        if (!parsed.ok) return panelError('bad-request', parsed.message)
        const config = await deps.setConfig(parsed.value.config)
        return { ok: true, value: { config } }
      }
      case 'status-get': {
        if (!authorized(payload, token)) return panelError('bad-request', 'missing or invalid acToken')
        const parsed = parsePayload(TOKEN_PAYLOAD, payload)
        if (!parsed.ok) return panelError('bad-request', parsed.message)
        return { ok: true, value: { status: deps.status() } }
      }
      case 'voices-list': {
        if (!authorized(payload, token)) return panelError('bad-request', 'missing or invalid acToken')
        const parsed = parsePayload(PROVIDER_PAYLOAD, payload)
        if (!parsed.ok) return panelError('bad-request', parsed.message)
        return { ok: true, value: { voices: deps.listVoices(parsed.value.provider) } }
      }
      case 'key-status': {
        if (!authorized(payload, token)) return panelError('bad-request', 'missing or invalid acToken')
        const parsed = parsePayload(REF_PAYLOAD, payload)
        if (!parsed.ok) return panelError('bad-request', parsed.message)
        return { ok: true, value: { key: await deps.keyStatus(parsed.value.ref) } }
      }
      case 'key-set': {
        if (!authorized(payload, token)) return panelError('bad-request', 'missing or invalid acToken')
        const parsed = parsePayload(KEY_SET_PAYLOAD, payload)
        if (!parsed.ok) return panelError('bad-request', parsed.message)
        await deps.setKey(parsed.value.ref, parsed.value.value)
        return { ok: true, value: {} }
      }
      case 'key-unset': {
        if (!authorized(payload, token)) return panelError('bad-request', 'missing or invalid acToken')
        const parsed = parsePayload(REF_PAYLOAD, payload)
        if (!parsed.ok) return panelError('bad-request', parsed.message)
        await deps.unsetKey(parsed.value.ref)
        return { ok: true, value: {} }
      }
      default:
        return panelError('bad-request', `unknown endpoint ${JSON.stringify(endpoint)}`)
    }
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} } }
  }
}
