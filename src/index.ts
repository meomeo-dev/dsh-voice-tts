/**
 * dsh-voice-tts 插件入口:capability seam 的编排层。
 * 注册 `ctx.tts` Service Definition,挂载 volcengine Provider;在 settings 存在时
 * 注册 `voice-tts` 设置命名空间与 `/dsh-voice-tts` 命令(Consumer);
 * 并监听 `session/event` 的 `turn/end`,在 autoplay=true 时合成每轮最终回复。
 * 纯逻辑(命令解析、请求构造、响应解析、双语规划、turn 文本提取)在
 * `command.ts` / `volcengine.ts` / `bilingual.ts` / `turn-final.ts`,本文件只做接缝编排。
 * @module dsh-voice-tts
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TtsService } from './service.js'
import { VolcengineTtsProvider } from './provider-volcengine.js'
import { DEFAULT_VOICE_TYPE, VOLCENGINE_API_KEY_REF } from './volcengine.js'
import type { VoiceTtsSettings } from './types.js'
import { concatAudio, planBilingualSpeech } from './bilingual.js'
import { finalAssistantText } from './turn-final.js'
import type { TurnEventLike } from './turn-final.js'
import { playFile } from './player.js'
import {
  filterVoices,
  listVoicesText,
  parseKeyCommand,
  parseTtsCommand,
  renderConfigTemplate,
  renderStatus,
  USAGE,
} from './command.js'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  assetContentType,
  ASSET_PREFIX,
  describeStatus,
  findPanelDist,
  generatePanelToken,
  handlePanelRpc,
  PANEL_CHANNEL,
  PANEL_PAGE,
  panelUrl,
  queryToken,
  readPanelAsset,
  renderPanelShell,
  resolvePanelAsset,
  safeTokenEqual,
  type PanelDeps,
} from './ui.js'

export const name = 'dsh-voice-tts'
export const inject = ['commands']

/** 用户可写设置命名空间。 */
const NAMESPACE = settingsNamespace('voice-tts')

/** 该命名空间的 schema,缺省回退到 volcengine 默认配置。 */
const SCHEMA: z<VoiceTtsSettings> = z.object({
  delivery: z.union(['off', 'file', 'host_play', 'stream'] as const).default('off'),
  provider: z.string().default('volcengine'),
  providers: z.object({
    volcengine: z.object({
      voice_type: z.string().default(DEFAULT_VOICE_TYPE),
      resource_id: z.union(['seed-tts-2.0', 'seed-icl-2.0'] as const).default('seed-tts-2.0'),
      model: z.string().default(''),
      format: z.union(['mp3', 'pcm', 'ogg_opus', 'wav'] as const).default('mp3'),
      play_format: z.union(['mp3', 'pcm', 'ogg_opus', 'wav'] as const).default('wav'),
      sample_rate: z.number().step(1).min(8000).max(48000).default(24000),
      speech_rate: z.number().step(1).min(-50).max(100).default(0),
      loudness_rate: z.number().step(1).min(-50).max(100).default(0),
      pitch: z.number().step(1).min(-12).max(12).default(0),
      bilingual: z.union(['both', 'english_only', 'chinese_only'] as const).default('both'),
      voices: z.object({
        zh: z.string().default(''),
        en: z.string().default(''),
        mixed: z.string().default(''),
      }),
      voice_profiles: z.dict(z.object({
        zh: z.string().default(''),
        en: z.string().default(''),
        mixed: z.string().default(''),
      })).default({}),
    }),
  }),
})

/** settings 未挂载 / 未写入时的兜底设置(与 schema 默认一致)。 */
const DEFAULT_SETTINGS: VoiceTtsSettings = {
  delivery: 'off',
  provider: 'volcengine',
  providers: {
    volcengine: {
      voice_type: DEFAULT_VOICE_TYPE,
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
    },
  },
}

/** 安全地转成可读字符串。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 当前已注册的 voice-tts 设置作用域(settings 挂载后赋值;面板 RPC 经它读写)。 */
let activeScope: SettingsScope<VoiceTtsSettings> | undefined

/** 面板访问 token 与监听端口(registerPanel 启动时赋值;`ui` 命令用它打印 URL)。 */
let panelToken: string | undefined
let panelPort: number | undefined

/** 解析 JSON;失败抛可读错误。 */
function parseJsonOrThrow(json: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error(`invalid JSON: ${json}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('config JSON must be an object')
  }
  return parsed as Record<string, unknown>
}

/**
 * 按当前配置把文本合成为音频字节(双语规划 + 分片合成 + 拼接)。
 * @param tts - TTS 注册表。
 * @param settings - 已解析设置。
 * @param text - 待合成文本。
 * @param format - 合成格式,默认 `volcengine.format`(host_play 用 `play_format`)。
 * @param voiceId - 当前 dsh-voice 的 voice id(命中 voice_profiles 时覆盖音色)。
 * @returns 拼接后的音频字节。
 */
async function synthesizeSpeech(
  tts: TtsService,
  settings: VoiceTtsSettings,
  text: string,
  format = settings.providers.volcengine.format,
  voiceId?: string,
): Promise<Uint8Array> {
  const volc = settings.providers.volcengine
  const plan = planBilingualSpeech(text, volc, voiceId)
  if (plan.runs.length === 0) {
    throw new Error(`no speechable sentences after bilingual=${volc.bilingual} filter`)
  }
  const parts: Uint8Array[] = []
  for (const run of plan.runs) {
    const result = await tts.synthesize(settings.provider, {
      text: run.text,
      config: { ...volc, voice_type: run.voice, format },
    })
    parts.push(result.audio)
  }
  return concatAudio(parts)
}

/**
 * 流式合成文本为音频字节(双语规划 + 逐分片收集 + 拼接)。
 * `stream` 交付用它:走 provider 的流式接口,前端消费端未来接入时直接改用
 * `tts.stream()` 逐分片推,当前退化为落盘完整音频。
 * @param tts - TTS 注册表。
 * @param settings - 已解析设置。
 * @param text - 待合成文本。
 * @param voiceId - 当前 dsh-voice 的 voice id(命中 voice_profiles 时覆盖音色)。
 * @returns 拼接后的音频字节。
 */
async function streamSpeech(tts: TtsService, settings: VoiceTtsSettings, text: string, voiceId?: string): Promise<Uint8Array> {
  const volc = settings.providers.volcengine
  const plan = planBilingualSpeech(text, volc, voiceId)
  if (plan.runs.length === 0) {
    throw new Error(`no speechable sentences after bilingual=${volc.bilingual} filter`)
  }
  const parts: Uint8Array[] = []
  for (const run of plan.runs) {
    for await (const chunk of tts.stream(settings.provider, {
      text: run.text,
      config: { ...volc, voice_type: run.voice },
    })) {
      parts.push(chunk.audio)
    }
  }
  return concatAudio(parts)
}

/** 一次交付的结果:音频字节、落盘路径、是否触发本机播放、所用格式。 */
interface DeliveryOutcome {
  readonly audio: Uint8Array
  readonly path: string
  readonly played: boolean
  readonly format: string
}

/**
 * 按 delivery 模式交付一次合成:off 拒绝;file 落盘;host_play 落盘 + 本机播放;
 * stream 流式合成落盘(前端消费未来接)。
 * @param tts - TTS 注册表。
 * @param settings - 已解析设置。
 * @param cwd - 落盘目录。
 * @param baseName - 文件名(不含扩展名)。
 * @param text - 待合成文本。
 * @param delivery - 交付模式。
 * @returns 交付结果。
 */
async function deliverSpeech(
  tts: TtsService,
  settings: VoiceTtsSettings,
  cwd: string,
  baseName: string,
  text: string,
  delivery: VoiceTtsSettings['delivery'],
  voiceId: string | undefined,
  warn: (line: string) => void = () => {},
): Promise<DeliveryOutcome> {
  const volc = settings.providers.volcengine
  if (delivery === 'off') {
    throw new Error('delivery is off')
  }
  if (delivery === 'stream') {
    const audio = await streamSpeech(tts, settings, text, voiceId)
    const path = resolve(cwd, `${baseName}.${volc.format}`)
    writeFileSync(path, audio)
    return { audio, path, played: false, format: volc.format }
  }
  if (delivery === 'host_play') {
    const audio = await synthesizeSpeech(tts, settings, text, volc.play_format, voiceId)
    const path = resolve(cwd, `${baseName}.${volc.play_format}`)
    writeFileSync(path, audio)
    const child = playFile({ path, format: volc.play_format }, error => {
      warn(`host_play failed: ${error.message}`)
    })
    return { audio, path, played: child !== undefined, format: volc.play_format }
  }
  const audio = await synthesizeSpeech(tts, settings, text, volc.format, voiceId)
  const path = resolve(cwd, `${baseName}.${volc.format}`)
  writeFileSync(path, audio)
  return { audio, path, played: false, format: volc.format }
}

/**
 * 执行 `/dsh-voice-tts` 命令:状态、列音色、配置模板、写配置、合成。
 * @param tts - TTS 注册表。
 * @param scope - 已注册的 voice-tts 设置作用域。
 * @param invocation - 命令调用(含 rawInput、agent、signal)。
 * @returns 归一化的命令结果。
 */
async function executeTtsCommand(
  tts: TtsService,
  scope: SettingsScope<VoiceTtsSettings>,
  invocation: CommandInvocation,
  resolveVoiceId: () => string | undefined,
): Promise<CommandResult> {
  const command = parseTtsCommand(invocation.rawInput)

  switch (command.kind) {
    case 'help':
      return { kind: 'success', text: USAGE }
    case 'status':
      return { kind: 'success', text: renderStatus(scope.get(), tts.listProviders()) }
    case 'list-voices':
      return {
        kind: 'success',
        text: listVoicesText(filterVoices(tts.listVoices(command.provider), command.query), command.provider),
      }
    case 'config-template':
      if (command.provider !== 'volcengine') {
        return { kind: 'error', text: `unknown provider "${command.provider}". Available: ${tts.listProviders().join(', ')}` }
      }
      return { kind: 'success', text: renderConfigTemplate() }
    case 'config-json': {
      const parsed = parseJsonOrThrow(command.json)
      try {
        await scope.update({ providers: { volcengine: parsed } })
      } catch (error) {
        return { kind: 'error', text: `config rejected: ${describeError(error)}` }
      }
      return { kind: 'success', text: renderStatus(scope.get(), tts.listProviders()) }
    }
    case 'speak': {
      if (command.text.length === 0) return { kind: 'error', text: 'usage: /dsh-voice-tts speak <text>' }
      const settings = scope.get()
      const delivery = command.delivery ?? settings.delivery
      try {
        const cwd = invocation.agent.session.header.cwd ?? process.cwd()
        const outcome = await deliverSpeech(tts, settings, cwd, 'dsh-voice-tts-output', command.text, delivery, resolveVoiceId())
        const played = outcome.played ? ' (played)' : ''
        return { kind: 'success', text: `synthesized ${outcome.audio.byteLength} bytes (${outcome.format})${played} -> ${outcome.path}` }
      } catch (error) {
        return { kind: 'error', text: `synthesis failed: ${describeError(error)}` }
      }
    }
    case 'ui': {
      if (panelToken === undefined || panelPort === undefined) {
        return { kind: 'error', text: 'voice-tts panel is not available: this session has no webServer/connection (web mode only).' }
      }
      return { kind: 'success', text: `voice-tts panel (展开后复制 URL): ${panelUrl(panelPort, panelToken)}` }
    }
  }
}

/**
 * 注册 voice-tts Web 配置面板(path B 独立页,见 ui.ts 模块文档):
 *   - GET `/voice-tts`(配置页,须 `?ac_token=`);
 *   - GET `/voice-tts-assets/*`(前缀,白名单后缀 + 路径防穿越 + token);
 *   - POST `/voice-tts-api/*` RPC channel(authority: 'loopback',信任栅栏 + 载荷 token)。
 * 仅当 webServer 与 connection 服务同时存在(web 模式)且 panel 构建产物在位时注册;
 * headless 环境无这两个服务,面板不存在,`/dsh-voice-tts ui` 报不可用。
 * @param ctx - 插件上下文。
 * @param tts - TTS 注册表(音色表来源)。
 * @param resolveVoiceId - 软读当前 dsh-voice id。
 */
function registerPanel(ctx: Context, tts: TtsService, resolveVoiceId: () => string | undefined): void {
  const web = ctx.get('webServer')
  if (web === undefined) return
  const panelDir = findPanelDist()
  if (panelDir === undefined) {
    ctx.logger.warn('dsh-voice-tts: panel dist not found (run `pnpm panel:build`); web panel disabled')
    return
  }
  const token = generatePanelToken()
  panelToken = token
  panelPort = web.port

  const servePage: WebRoute['handler'] = (req, res) => {
    if (!safeTokenEqual(queryToken(req.url) ?? '', token)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    const html = renderPanelShell({ token, channel: PANEL_CHANNEL })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  }

  ctx.effect(() => web.register({ kind: 'exact', path: PANEL_PAGE, handler: servePage }), 'dsh-voice-tts: /voice-tts page')
  ctx.effect(() => web.register({
    kind: 'prefix',
    path: ASSET_PREFIX.slice(0, -1),
    handler: (req, res) => {
      const rawUrl = req.url ?? '/'
      let pathname: string
      try {
        pathname = new URL(rawUrl, 'http://x').pathname
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      if (!safeTokenEqual(queryToken(rawUrl) ?? '', token)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      const file = resolvePanelAsset(panelDir, pathname)
      const content = file === undefined ? undefined : readPanelAsset(panelDir, pathname)
      if (file === undefined || content === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': assetContentType(file), 'cache-control': 'no-cache' })
      res.end(content)
    },
  }), 'dsh-voice-tts: /voice-tts-assets route')

  // connection 由 client-connection 插件 fiber 提供:loader 并发启动 plugin,
  // apply 时该 fiber 未必已 ACTIVE,故用声明式注入而非 ctx.get(与 api-proxy 同款)。
  ctx.inject(['connection'], (cctx) => {
    const deps: PanelDeps = {
      getConfig() {
        return activeScope?.get() ?? DEFAULT_SETTINGS
      },
      async setConfig(config) {
        const scope = activeScope
        if (scope === undefined) throw new Error('settings service is not available')
        await scope.replace(config)
        return scope.get()
      },
      status() {
        return describeStatus(activeScope?.get() ?? DEFAULT_SETTINGS, resolveVoiceId())
      },
      listVoices() {
        return tts.listVoices('volcengine')
      },
      async keyStatus() {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) return { configured: false, source: null, writable: false }
        const info = await credentials.describe(credentialRef(VOLCENGINE_API_KEY_REF))
        return { configured: info.configured, source: info.source ?? null, writable: info.writable }
      },
      async setKey(value) {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) throw new Error('credentials service is not available')
        await credentials.set(credentialRef(VOLCENGINE_API_KEY_REF), value)
      },
      async unsetKey() {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) throw new Error('credentials service is not available')
        await credentials.unset(credentialRef(VOLCENGINE_API_KEY_REF))
      },
    }
    const disposeChannel = cctx.connection.rpc.handle(
      PANEL_CHANNEL,
      (endpoint, payload, _signal) => handlePanelRpc(endpoint, payload, token, deps),
      { authority: 'loopback' },
    )
    cctx.effect(() => disposeChannel, 'dsh-voice-tts: /voice-tts-api channel')
    // 面板 URL 是就绪信号,打印到 stdout(与 `dsh web:` 行一致),便于 CLI/服务日志可见。
    console.log(`dsh-voice-tts panel: ${panelUrl(web.port, token)}`)
  })
}

/**
 * 插件入口:注册 `ctx.tts`(Service Definition)+ volcengine Provider(始终);
 * 在 settings 存在时注册 `voice-tts` 命名空间与 `/dsh-voice-tts` 命令(Consumer);
 * 监听 `turn/end` 在 autoplay=true 时合成每轮最终回复(写音频文件)。
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx: Context): void {
  // Service Definition —— 构造即注册为 ctx.tts,随插件 fiber 销毁。
  const tts = new TtsService(ctx)

  // 凭证解析:走 dsh 的 credentials seam(对齐 llm-deepseek 的 per-operation resolve),
  // 不直接读 process.env。无 credentials seam 时回退环境变量(credentials-local
  // 本身就把 process env / .env 作为一层,此处 fallback 仅覆盖 seam 未挂载的嵌入场景)。
  const resolveApiKey = async (): Promise<string> => {
    const ref = credentialRef(VOLCENGINE_API_KEY_REF)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return hit.value
    }
    const ambient = process.env[VOLCENGINE_API_KEY_REF]
    if (ambient !== undefined && ambient.length > 0) return ambient
    throw new Error(`missing API key: store ${VOLCENGINE_API_KEY_REF} through the credentials service (dsh credentials) or export it in the environment`)
  }

  // Provider —— 首版仅 volcengine。
  ctx.effect(() => tts.registerProvider(new VolcengineTtsProvider(resolveApiKey)), 'volcengine provider')

  // 软读 dsh-voice 的当前 voice id(`voice.tone`),用于 per-voice 音色映射。
  // 无 dsh-voice(settings 不存在或 voice 命名空间未注册)时返回 undefined,映射自动跳过。
  const resolveVoiceId = (): string | undefined => {
    const settings = ctx.get('settings')
    if (settings === undefined) return undefined
    const voice = settings.get(settingsNamespace('voice')) as { tone?: string } | undefined
    return voice?.tone
  }

  // 当前生效设置(settings 挂载前为默认,挂载后随 watch 更新)。
  let activeSettings: VoiceTtsSettings = DEFAULT_SETTINGS

  // turn-final 交付:delivery=off 不处理;否则每轮结束把最终回复按 delivery 交付。
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const settings = activeSettings
    if (settings.delivery === 'off') return
    const text = finalAssistantText(session.events as readonly TurnEventLike[], event.data.turn)
    if (text === undefined) return
    const cwd = session.header.cwd ?? process.cwd()
    void deliverSpeech(tts, settings, cwd, `dsh-voice-tts-turn-${event.data.turn}`, text, settings.delivery, resolveVoiceId(), line => ctx.logger.warn('dsh-voice-tts: %s', line))
      .then(outcome => {
        const played = outcome.played ? ' (played)' : ''
        ctx.logger.info('dsh-voice-tts: turn %d delivered %d bytes (%s)%s -> %s', event.data.turn, outcome.audio.byteLength, outcome.format, played, outcome.path)
      })
      .catch(error => {
        ctx.logger.warn('dsh-voice-tts: turn-final delivery failed: %s', describeError(error))
      })
  })

  // Consumer —— settings 可选;存在时接管 activeSettings 并挂命令。
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(NAMESPACE, SCHEMA)
    activeScope = scope
    activeSettings = scope.get()
    scope.watch(next => {
      activeSettings = next
    })
    ctx.commands.register({
      name: 'dsh-voice-tts',
      description: 'text-to-speech synthesis and config (volcengine seed-tts-2.0)',
      input: { hint: '[status|list-voices|config|speak|ui]' },
      handler: invocation => executeTtsCommand(tts, scope, invocation, resolveVoiceId),
    })
  })

  // 凭证命令:独立命令 + recordInput:false,让 API key 不进 session log。
  // set 走 ctx.credentials.set(写入 .credentials.yaml),status 只报 configured/source 不回显值。
  ctx.commands.register({
    name: 'dsh-voice-tts-key',
    description: 'set/unset the volcengine TTS API key (recorded privately)',
    input: { hint: '[set <value>|unset|status]' },
    recordInput: false,
    handler: async invocation => {
      const command = parseKeyCommand(invocation.rawInput)
      const ref = credentialRef(VOLCENGINE_API_KEY_REF)
      const credentials = ctx.get('credentials')
      if (credentials === undefined) {
        return { kind: 'error', text: 'credentials service is not available' }
      }
      if (command.kind === 'set') {
        try {
          await credentials.set(ref, command.value)
          return { kind: 'success', text: 'API key stored.' }
        } catch (error) {
          return { kind: 'error', text: `failed to store API key: ${describeError(error)}` }
        }
      }
      if (command.kind === 'unset') {
        try {
          await credentials.unset(ref)
          return { kind: 'success', text: 'API key removed.' }
        } catch (error) {
          return { kind: 'error', text: `failed to remove API key: ${describeError(error)}` }
        }
      }
      const info = await credentials.describe(ref)
      const source = info.source !== undefined ? `, source: ${info.source}` : ''
      return { kind: 'success', text: `configured: ${String(info.configured)}${source}, writable: ${String(info.writable)}` }
    },
  })

  // Web 配置面板:webServer + connection 同时存在时注册(web 模式);否则静默跳过。
  registerPanel(ctx, tts, resolveVoiceId)
}
