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
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { TtsService } from './service.js'
import { VolcengineTtsProvider } from './provider-volcengine.js'
import { SiliconflowTtsProvider } from './provider-siliconflow.js'
import { HostTtsProvider } from './provider-host.js'
import { DEFAULT_VOICE_TYPE, DEFAULT_VOLCENGINE_API_KEY_REF, VOLCENGINE_RESOURCE_IDS, VOLCENGINE_TUNABLE_PARAMS } from './volcengine.js'
import { DEFAULT_SILICONFLOW_API_KEY_REF, DEFAULT_SILICONFLOW_MODEL, DEFAULT_SILICONFLOW_VOICE, SILICONFLOW_MODELS, SILICONFLOW_TUNABLE_PARAMS } from './siliconflow.js'
import { DEFAULT_HOST_COMMAND, DEFAULT_HOST_RATE, HOST_OUTPUT_FORMAT } from './host.js'
import type { BilingualVoiceConfig, TunableParam, VoiceSlot, VoiceTtsSettings } from './types.js'
import { planBilingualSpeech } from './bilingual.js'
import { finalAssistantText } from './turn-final.js'
import type { TurnEventLike } from './turn-final.js'
import { PlayerQueue } from './player.js'
import { sanitizeForSpeech } from './sanitize.js'
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
import { registerSlotRoutes, type TurnAudioStatus } from './slot-routes.js'
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
  primaryLangOf,
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

/** 某 provider 的槽位 schema:{ voice_type, ...可调参数(全部可选) }。可调参数来自注册表。 */
function voiceSlotSchema(params: readonly TunableParam[]): z<VoiceSlot> {
  const fields: Record<string, unknown> = { voice_type: z.string().default('') }
  for (const param of params) {
    fields[param.key] = z.number().step(param.step).min(param.min).max(param.max)
  }
  return z.object(fields) as unknown as z<VoiceSlot>
}

/** 某 provider 的各语言类别槽位 schema(zh/en/mixed 三个槽位)。 */
function voicesSchema(params: readonly TunableParam[]) {
  return z.object({
    zh: voiceSlotSchema(params),
    en: voiceSlotSchema(params),
    mixed: voiceSlotSchema(params),
  })
}

/** 某 provider 的 per-voice 音色映射 schema(每个 voice id 映射整套 zh/en/mixed 槽位)。 */
function voiceProfilesSchema(params: readonly TunableParam[]) {
  return z.dict(voicesSchema(params)).default({})
}

const BILINGUAL_SCHEMA = z.union(['both', 'english_only', 'chinese_only'] as const).default('both')

/** 该命名空间的 schema:多 provider,每个 provider 有自己的 apiKeyRef + 合成参数。 */
const SCHEMA: z<VoiceTtsSettings> = z.object({
  delivery: z.union(['off', 'file', 'host_play', 'stream'] as const).default('off'),
  provider: z.string().default('volcengine'),
  providers: z.object({
    volcengine: z.object({
      apiKeyRef: z.string().default(DEFAULT_VOLCENGINE_API_KEY_REF),
      voice_type: z.string().default(DEFAULT_VOICE_TYPE),
      resource_id: z.union(['seed-tts-2.0', 'seed-icl-2.0'] as const).default('seed-tts-2.0'),
      model: z.string().default(''),
      format: z.union(['mp3', 'pcm', 'ogg_opus', 'wav'] as const).default('mp3'),
      play_format: z.union(['mp3', 'pcm', 'ogg_opus', 'wav'] as const).default('wav'),
      sample_rate: z.number().step(1).min(8000).max(48000).default(24000),
      speech_rate: z.number().step(1).min(-50).max(100).default(0),
      loudness_rate: z.number().step(1).min(-50).max(100).default(0),
      pitch: z.number().step(1).min(-12).max(12).default(0),
      bilingual: BILINGUAL_SCHEMA,
      voices: voicesSchema(VOLCENGINE_TUNABLE_PARAMS),
      voice_profiles: voiceProfilesSchema(VOLCENGINE_TUNABLE_PARAMS),
    }),
    'siliconflow-cn': z.object({
      apiKeyRef: z.string().default(DEFAULT_SILICONFLOW_API_KEY_REF),
      voice_type: z.string().default(DEFAULT_SILICONFLOW_VOICE),
      model: z.string().default(DEFAULT_SILICONFLOW_MODEL),
      format: z.union(['mp3', 'opus', 'wav', 'pcm'] as const).default('mp3'),
      play_format: z.union(['mp3', 'opus', 'wav', 'pcm'] as const).default('wav'),
      sample_rate: z.number().step(1).min(8000).max(48000).default(32000),
      speed: z.number().step(0.01).min(0.25).max(4).default(1),
      gain: z.number().step(0.1).min(-10).max(10).default(0),
      bilingual: BILINGUAL_SCHEMA,
      voices: voicesSchema(SILICONFLOW_TUNABLE_PARAMS),
      voice_profiles: voiceProfilesSchema(SILICONFLOW_TUNABLE_PARAMS),
    }),
    host: z.object({
      command: z.string().default(DEFAULT_HOST_COMMAND),
      voice_type: z.string().default(''),
      rate: z.number().step(1).min(1).max(600).default(DEFAULT_HOST_RATE),
      bilingual: BILINGUAL_SCHEMA,
      voices: voicesSchema([]),
      voice_profiles: voiceProfilesSchema([]),
    }),
  }),
})

/** settings 未挂载 / 未写入时的兜底设置(与 schema 默认一致)。 */
const DEFAULT_SETTINGS: VoiceTtsSettings = {
  delivery: 'off',
  provider: 'volcengine',
  providers: {
    volcengine: {
      apiKeyRef: DEFAULT_VOLCENGINE_API_KEY_REF,
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
    'siliconflow-cn': {
      apiKeyRef: DEFAULT_SILICONFLOW_API_KEY_REF,
      voice_type: DEFAULT_SILICONFLOW_VOICE,
      model: DEFAULT_SILICONFLOW_MODEL,
      format: 'mp3',
      play_format: 'wav',
      sample_rate: 32000,
      speed: 1,
      gain: 0,
      bilingual: 'both',
      voices: {},
      voice_profiles: {},
    },
    host: {
      command: DEFAULT_HOST_COMMAND,
      voice_type: '',
      rate: DEFAULT_HOST_RATE,
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

/** 上次非 off 的 delivery(「Turn on/off」从 off 切回时恢复它)。 */
let lastOnDelivery: VoiceTtsSettings['delivery'] = 'host_play'

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
 * 当前 provider 的交付视角:双语规划只依赖 provider 无关的共享字段,
 * 落盘/播放格式按 provider 各自取。未知 provider 抛错(settings 里 `provider`
 * 是自由字符串,用户可能误填)。
 */
interface DeliveryView extends BilingualVoiceConfig {
  readonly format: string
  readonly play_format: string
}

/** 解析当前 provider 的共享交付视角。 */
function deliveryView(settings: VoiceTtsSettings): DeliveryView {
  const provider = settings.provider
  if (provider === 'volcengine') {
    const v = settings.providers.volcengine
    return { bilingual: v.bilingual, voice_type: v.voice_type, voices: v.voices, voice_profiles: v.voice_profiles, format: v.format, play_format: v.play_format }
  }
  if (provider === 'siliconflow-cn') {
    const s = settings.providers['siliconflow-cn']
    return { bilingual: s.bilingual, voice_type: s.voice_type, voices: s.voices, voice_profiles: s.voice_profiles, format: s.format, play_format: s.play_format }
  }
  if (provider === 'host') {
    const h = settings.providers.host
    return { bilingual: h.bilingual, voice_type: h.voice_type, voices: h.voices, voice_profiles: h.voice_profiles, format: HOST_OUTPUT_FORMAT, play_format: HOST_OUTPUT_FORMAT }
  }
  throw new Error(`unknown TTS provider "${provider}"`)
}

/**
 * 组装一次合成请求的 provider 配置:当前 provider 的完整设置 + 覆盖后的音色、格式
 * 与槽位可调参数(槽位未配置的参数不展开,缺省回退 provider 顶层字段)。
 * @param settings - 已解析设置。
 * @param voice - 本分片的音色 id。
 * @param format - 合成格式。
 * @param params - 本分片的槽位可调参数覆盖(键随 provider)。
 * @returns 传给 `tts.synthesize` 的 `config`。
 */
function synthConfig(settings: VoiceTtsSettings, voice: string, format: string, params: Record<string, number> = {}): Record<string, unknown> {
  const provider = settings.provider
  if (provider === 'volcengine') {
    return { ...settings.providers.volcengine, voice_type: voice, format, ...params }
  }
  if (provider === 'siliconflow-cn') {
    return { ...settings.providers['siliconflow-cn'], voice_type: voice, format, ...params }
  }
  if (provider === 'host') {
    return { ...settings.providers.host, voice_type: voice, format, ...params }
  }
  throw new Error(`unknown TTS provider "${provider}"`)
}

/**
 * 按当前配置逐 run 合成文本为音频字节数组(双语规划 + 分片合成,不拼接)。
 * 每个 run 可能对应不同音色/参数,因此**不能**字节拼接成单段——WAV/AIFF 等
 * 带 `RIFF`/`FORM` 长度头的容器格式,拼接后播放器只读到第一段。
 * @param tts - TTS 注册表。
 * @param settings - 已解析设置。
 * @param text - 待合成文本。
 * @param format - 合成格式(host_play 用 play_format)。
 * @param voiceId - 当前 dsh-voice 的 voice id(命中 voice_profiles 时覆盖音色)。
 * @returns 逐 run 的音频字节数组(与 `planBilingualSpeech` 的 runs 一一对应)。
 */
async function synthesizeRuns(
  tts: TtsService,
  settings: VoiceTtsSettings,
  text: string,
  format: string,
  voiceId?: string,
): Promise<Uint8Array[]> {
  const view = deliveryView(settings)
  const plan = planBilingualSpeech(text, view, voiceId)
  if (plan.runs.length === 0) {
    throw new Error(`no speechable sentences after bilingual=${view.bilingual} filter`)
  }
  const audios: Uint8Array[] = []
  for (const run of plan.runs) {
    const result = await tts.synthesize(settings.provider, {
      text: run.text,
      config: synthConfig(settings, run.voice, format, run.params),
    })
    audios.push(result.audio)
  }
  return audios
}

/**
 * 逐 run 流式合成为音频字节数组(不拼接)。`stream` 交付用它:走 provider 的
 * 流式接口,前端消费端未来接入时直接改用 `tts.stream()` 逐分片推,当前退化为
 * 每个 run 一段完整音频。
 * @param tts - TTS 注册表。
 * @param settings - 已解析设置。
 * @param text - 待合成文本。
 * @param format - 合成格式。
 * @param voiceId - 当前 dsh-voice 的 voice id。
 * @returns 逐 run 的音频字节数组。
 */
async function streamRuns(
  tts: TtsService,
  settings: VoiceTtsSettings,
  text: string,
  format: string,
  voiceId?: string,
): Promise<Uint8Array[]> {
  const view = deliveryView(settings)
  const plan = planBilingualSpeech(text, view, voiceId)
  if (plan.runs.length === 0) {
    throw new Error(`no speechable sentences after bilingual=${view.bilingual} filter`)
  }
  const audios: Uint8Array[] = []
  for (const run of plan.runs) {
    const parts: Uint8Array[] = []
    for await (const chunk of tts.stream(settings.provider, {
      text: run.text,
      config: synthConfig(settings, run.voice, format, run.params),
    })) {
      parts.push(chunk.audio)
    }
    audios.push(concatRunChunks(parts))
  }
  return audios
}

/** 把同一 run 的流式分片拼成一段完整音频(同 run 内是同一格式、同一音色,可安全拼接)。 */
function concatRunChunks(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/** 一次交付的结果:总字节数、落盘路径列表、是否触发本机播放、所用格式。 */
interface DeliveryOutcome {
  readonly totalBytes: number
  readonly paths: readonly string[]
  readonly played: boolean
  readonly format: string
}

/**
 * 按 delivery 模式交付一次合成:off 拒绝;file 落盘;host_play 落盘 + 本机播放;
 * stream 流式合成落盘(前端消费未来接)。
 * 多 run(不同音色/参数)时逐段独立成文件(单 run 保持原名,多 run 带 `-<i>` 序号),
 * host_play 逐段串行入队播放——绝不把不同音色的容器格式音频字节拼接。
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
  playerQueue: PlayerQueue,
  warn: (line: string) => void = () => {},
): Promise<DeliveryOutcome> {
  const view = deliveryView(settings)
  if (delivery === 'off') {
    throw new Error('delivery is off')
  }
  const format = delivery === 'host_play' ? view.play_format : view.format
  const audios = delivery === 'stream'
    ? await streamRuns(tts, settings, text, format, voiceId)
    : await synthesizeRuns(tts, settings, text, format, voiceId)

  const paths: string[] = []
  let totalBytes = 0
  for (let i = 0; i < audios.length; i++) {
    const suffix = audios.length === 1 ? '' : `-${i}`
    const path = resolve(cwd, `${baseName}${suffix}.${format}`)
    writeFileSync(path, audios[i]!)
    paths.push(path)
    totalBytes += audios[i]!.byteLength
  }

  let played = false
  if (delivery === 'host_play') {
    played = true
    // 串行播放队列:一次只播一个,避免多会话/多 turn 并发抢占系统播放器。
    for (const path of paths) {
      void playerQueue.enqueue({ path, format }).catch(error => {
        warn(`host_play failed: ${error.message}`)
      })
    }
  }
  return { totalBytes, paths, played, format }
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
  resolveVoiceId: (sessionId?: string, cwd?: string) => string | undefined,
  playerQueue: PlayerQueue,
): Promise<CommandResult> {
  const command = parseTtsCommand(invocation.rawInput)

  switch (command.kind) {
    case 'help':
      return { kind: 'success', text: USAGE }
    case 'status':
      return { kind: 'success', text: renderStatus(scope.get(), tts.listProviders()) }
    case 'use': {
      if (!tts.listProviders().includes(command.provider)) {
        return { kind: 'error', text: `unknown provider "${command.provider}". Available: ${tts.listProviders().join(', ')}` }
      }
      await scope.update({ provider: command.provider })
      return { kind: 'success', text: renderStatus(scope.get(), tts.listProviders()) }
    }
    case 'list-voices':
      return {
        kind: 'success',
        text: listVoicesText(filterVoices(tts.listVoices(command.provider), command.query), command.provider),
      }
    case 'config-template':
      if (!tts.listProviders().includes(command.provider)) {
        return { kind: 'error', text: `unknown provider "${command.provider}". Available: ${tts.listProviders().join(', ')}` }
      }
      return { kind: 'success', text: renderConfigTemplate(command.provider) }
    case 'config-json': {
      const parsed = parseJsonOrThrow(command.json)
      const provider = scope.get().provider
      try {
        await scope.update({ providers: { [provider]: parsed } })
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
        const outcome = await deliverSpeech(tts, settings, cwd, 'dsh-voice-tts-output', command.text, delivery, resolveVoiceId(invocation.agent.id, invocation.agent.session.header.cwd), playerQueue)
        const played = outcome.played ? ' (played)' : ''
        return { kind: 'success', text: `synthesized ${outcome.totalBytes} bytes (${outcome.format})${played} -> ${outcome.paths.join(', ')}` }
      } catch (error) {
        return { kind: 'error', text: `synthesis failed: ${describeError(error)}` }
      }
    }
    case 'ui': {
      if (panelToken === undefined || panelPort === undefined) {
        return { kind: 'error', text: 'voice-tts panel is not available: this session has no webServer/connection (web mode only).' }
      }
      // 命令卡片只在结果含换行时可展开/复制(GenericCommandCard 的 expandable 判定);
      // 卡片是纯文本渲染,故用裸 URL 而非 markdown 链接语法。
      return {
        kind: 'success',
        text: [
          'voice-tts 配置面板 (展开后复制 URL):',
          `  配置面板: ${panelUrl(panelPort, panelToken)}`,
        ].join('\n'),
      }
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
function registerPanel(ctx: Context, tts: TtsService, resolveVoiceId: (sessionId?: string, cwd?: string) => string | undefined): void {
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
        return describeStatus(deliveryView(activeScope?.get() ?? DEFAULT_SETTINGS), resolveVoiceId())
      },
      listVoices(providerId) {
        return tts.listVoices(providerId).map(voice => ({ ...voice, primaryLang: primaryLangOf(voice.voice_type) }))
      },
      listModels(providerId) {
        if (providerId === 'volcengine') return VOLCENGINE_RESOURCE_IDS
        if (providerId === 'siliconflow-cn') return SILICONFLOW_MODELS
        return []
      },
      listParams(providerId) {
        if (providerId === 'volcengine') return VOLCENGINE_TUNABLE_PARAMS
        if (providerId === 'siliconflow-cn') return SILICONFLOW_TUNABLE_PARAMS
        return []
      },
      async keyStatus(ref) {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) return { configured: false, source: null, writable: false }
        const info = await credentials.describe(credentialRef(ref))
        return { configured: info.configured, source: info.source ?? null, writable: info.writable }
      },
      async setKey(ref, value) {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) throw new Error('credentials service is not available')
        await credentials.set(credentialRef(ref), value)
      },
      async unsetKey(ref) {
        const credentials = ctx.get('credentials')
        if (credentials === undefined) throw new Error('credentials service is not available')
        await credentials.unset(credentialRef(ref))
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

  // 当前生效设置(settings 挂载前为默认,挂载后随 watch 更新)。
  let activeSettings: VoiceTtsSettings = DEFAULT_SETTINGS

  // 软读 dsh-voice 的「当前会话生效 voice id」(会话 → 工作区 → 用户 → legacy),
  // 用于 per-voice 音色映射。优先走 dsh-voice 暴露的 `ctx.voice` 选择解析服务
  // (单一真相源,不重复折叠);无该服务(未装 dsh-voice)时回退 legacy `voice.tone`。
  const resolveVoiceId = (sessionId?: string, cwd?: string): string | undefined => {
    const voice = ctx.get('voice') as { resolveEffective?: (sessionId?: string, cwd?: string) => string } | undefined
    if (voice?.resolveEffective !== undefined) {
      const id = voice.resolveEffective(sessionId, cwd)
      return id === 'off' ? undefined : id
    }
    const settings = ctx.get('settings')
    if (settings === undefined) return undefined
    const tone = (settings.get(settingsNamespace('voice')) as { tone?: string } | undefined)?.tone
    return tone === undefined || tone === '' || tone === 'off' ? undefined : tone
  }

  // 取某 provider 的凭证引用名(KEY NAME)。未知 provider 抛错。
  const apiKeyRefOf = (providerId: string): string => {
    if (providerId === 'volcengine') return activeSettings.providers.volcengine.apiKeyRef
    if (providerId === 'siliconflow-cn') return activeSettings.providers['siliconflow-cn'].apiKeyRef
    if (providerId === 'host') throw new Error('the host provider has no API key (local command-line synthesis)')
    throw new Error(`unknown TTS provider "${providerId}"`)
  }

  // 凭证解析:走 dsh 的 credentials seam(对齐 llm-deepseek 的 per-operation resolve),
  // 按 provider 各自的 apiKeyRef 解析,不直接读 process.env。无 credentials seam 时
  // 回退环境变量(credentials-local 本身就把 process env / .env 作为一层)。
  const resolveApiKey = async (providerId: string): Promise<string> => {
    const ref = credentialRef(apiKeyRefOf(providerId))
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return hit.value
    }
    const ambient = process.env[ref as string]
    if (ambient !== undefined && ambient.length > 0) return ambient
    throw new Error(`missing API key for ${providerId}: store ${ref} through the credentials service (dsh credentials) or export it in the environment`)
  }

  // Providers —— 每个 provider 一个实现,key 按各自 apiKeyRef 解析。
  ctx.effect(() => tts.registerProvider(new VolcengineTtsProvider(() => resolveApiKey('volcengine'))), 'volcengine provider')
  ctx.effect(() => tts.registerProvider(new SiliconflowTtsProvider(() => resolveApiKey('siliconflow-cn'))), 'siliconflow-cn provider')
  ctx.effect(() => tts.registerProvider(new HostTtsProvider()), 'host provider')

  // 串行播放队列:所有 host_play 经它排队,一次只播一个。
  const playerQueue = new PlayerQueue()

  // 内存音频注册表:`sessionId:turn` → 逐 run 落盘路径 + 格式。turn/end 交付成功后登记,
  // 供 `/voice-tts/audio-status|audio` 定位浏览器回放文件;进程重启后清空(见设计文档)。
  interface TurnAudioEntry {
    readonly paths: readonly string[]
    readonly format: string
  }
  const audioByTurn = new Map<string, TurnAudioEntry>()
  const audioKey = (sessionId: string, turn: number): string => `${sessionId}:${turn}`

  const audioStatus = (sessionId: string, turn: number): TurnAudioStatus => {
    const entry = audioByTurn.get(audioKey(sessionId, turn))
    return entry === undefined
      ? { exists: false, segments: 0, format: null }
      : { exists: true, segments: entry.paths.length, format: entry.format }
  }

  const audioFile = (sessionId: string, turn: number, index: number): { path: string; format: string } | undefined => {
    const entry = audioByTurn.get(audioKey(sessionId, turn))
    if (entry === undefined || index < 0 || index >= entry.paths.length) return undefined
    return { path: entry.paths[index]!, format: entry.format }
  }

  // 重新生成某 turn 的最终回复语音:从 live session 日志提取文本 → 复用 deliverSpeech →
  // 登记注册表。delivery=off 时强制 file(用户显式点了「重新生成」,必须产出可播放文件)。
  const regenerateTurn = async (sessionId: string, turn: number): Promise<TurnAudioStatus> => {
    ctx.logger.info('dsh-voice-tts: regenerate turn=%d session=%s', turn, sessionId)
    // `ctx.get('sessions')` 是 strict 全局 store 读;`ctx.sessions` property 代理是
    // topology-sensitive 的(需在 inject 里声明),见 packages/CLAUDE.md optional-services 约定。
    const sessions = ctx.get('sessions')
    if (sessions === undefined) throw new Error('sessions service is not available')
    const session = sessions.get(SessionId(sessionId))
    if (session === undefined) {
      const live = sessions.list().map(s => String(s.id)).join(', ')
      ctx.logger.warn('dsh-voice-tts: regenerate failed — session %s not live (live: %s)', sessionId, live || '<none>')
      throw new Error(`session ${sessionId} is not live`)
    }
    const raw = finalAssistantText(session.events as readonly TurnEventLike[], turn)
    if (raw === undefined) throw new Error(`turn ${turn} has no final assistant message`)
    const text = sanitizeForSpeech(raw)
    if (text.length === 0) throw new Error(`turn ${turn} has no speechable text`)
    const settings = activeSettings
    const delivery: VoiceTtsSettings['delivery'] = settings.delivery === 'off' ? 'file' : settings.delivery
    const cwd = session.header.cwd ?? process.cwd()
    const baseName = `dsh-voice-tts-${sessionId}-turn-${turn}`
    ctx.logger.info('dsh-voice-tts: regenerate synthesizing (delivery=%s, provider=%s)', delivery, settings.provider)
    const outcome = await deliverSpeech(tts, settings, cwd, baseName, text, delivery, resolveVoiceId(session.id, session.header.cwd), playerQueue, line => ctx.logger.warn('dsh-voice-tts: %s', line))
    audioByTurn.set(audioKey(sessionId, turn), { paths: outcome.paths, format: outcome.format })
    ctx.logger.info('dsh-voice-tts: regenerate done -> %s', outcome.paths.join(', '))
    return { exists: true, segments: outcome.paths.length, format: outcome.format }
  }

  // turn-final 交付:delivery=off 不处理;否则每轮结束把最终回复按 delivery 交付。
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const settings = activeSettings
    if (settings.delivery === 'off') return
    const raw = finalAssistantText(session.events as readonly TurnEventLike[], event.data.turn)
    if (raw === undefined) return
    // markdown/HTML/代码块先净化为可朗读文本:代码块不读,整段代码/JSON/SQL/YAML 不读。
    const text = sanitizeForSpeech(raw)
    if (text.length === 0) return
    const cwd = session.header.cwd ?? process.cwd()
    // 文件名带 session id + turn,避免多会话同 cwd 下同名覆盖、互相抢占。
    const baseName = `dsh-voice-tts-${String(session.id)}-turn-${event.data.turn}`
    void deliverSpeech(tts, settings, cwd, baseName, text, settings.delivery, resolveVoiceId(session.id, session.header.cwd), playerQueue, line => ctx.logger.warn('dsh-voice-tts: %s', line))
      .then(outcome => {
        audioByTurn.set(audioKey(String(session.id), event.data.turn), { paths: outcome.paths, format: outcome.format })
        const played = outcome.played ? ' (played)' : ''
        ctx.logger.info('dsh-voice-tts: turn %d delivered %d bytes (%s)%s -> %s', event.data.turn, outcome.totalBytes, outcome.format, played, outcome.paths.join(', '))
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
    if (activeSettings.delivery !== 'off') lastOnDelivery = activeSettings.delivery
    scope.watch(next => {
      activeSettings = next
      if (next.delivery !== 'off') lastOnDelivery = next.delivery
    })
    ctx.commands.register({
      name: 'dsh-voice-tts',
      description: 'text-to-speech synthesis and config (volcengine seed-tts-2.0)',
      input: { hint: '[status|list-voices|config|speak|ui]' },
      handler: invocation => executeTtsCommand(tts, scope, invocation, resolveVoiceId, playerQueue),
    })
  })

  // 凭证命令:独立命令 + recordInput:false,让 API key 不进 session log。
  // set 走 ctx.credentials.set(写入 .credentials.yaml),按 provider 各自的 apiKeyRef;
  // status 只报 configured/source 不回显值。
  ctx.commands.register({
    name: 'dsh-voice-tts-key',
    description: 'set/unset a TTS provider API key (recorded privately)',
    input: { hint: '[set [provider] <value>|unset [provider]|status [provider]]' },
    recordInput: false,
    handler: async invocation => {
      const command = parseKeyCommand(invocation.rawInput, tts.listProviders())
      const providerId = command.provider ?? activeSettings.provider
      const credentials = ctx.get('credentials')
      if (credentials === undefined) {
        return { kind: 'error', text: 'credentials service is not available' }
      }
      let ref: ReturnType<typeof credentialRef>
      try {
        ref = credentialRef(apiKeyRefOf(providerId))
      } catch (error) {
        return { kind: 'error', text: describeError(error) }
      }
      if (command.kind === 'set') {
        if (command.value.length === 0) {
          return { kind: 'error', text: 'usage: /dsh-voice-tts-key set [provider] <value>' }
        }
        try {
          await credentials.set(ref, command.value)
          return { kind: 'success', text: `API key stored for ${providerId} (${ref}).` }
        } catch (error) {
          return { kind: 'error', text: `failed to store API key: ${describeError(error)}` }
        }
      }
      if (command.kind === 'unset') {
        try {
          await credentials.unset(ref)
          return { kind: 'success', text: `API key removed for ${providerId} (${ref}).` }
        } catch (error) {
          return { kind: 'error', text: `failed to remove API key: ${describeError(error)}` }
        }
      }
      const info = await credentials.describe(ref)
      const source = info.source !== undefined ? `, source: ${info.source}` : ''
      return { kind: 'success', text: `[${providerId}] ${ref}: configured=${String(info.configured)}${source}, writable=${String(info.writable)}` }
    },
  })

  // Web 配置面板:webServer + connection 同时存在时注册(web 模式);否则静默跳过。
  registerPanel(ctx, tts, resolveVoiceId)

  // 切换 on/off:off → 恢复 lastOnDelivery;非 off → 记住当前值并写 off。
  const toggleDelivery = async (): Promise<VoiceTtsSettings['delivery']> => {
    const scope = activeScope
    if (scope === undefined) throw new Error('settings service is not available')
    const next = scope.get().delivery === 'off' ? lastOnDelivery : 'off'
    await scope.update({ delivery: next })
    return next
  }

  // Web UI slot 路由(webServer 存在时挂;headless 下静默不挂)。
  ctx.inject(['webServer'], (wctx) => {
    registerSlotRoutes(wctx, {
      state: () => ({ delivery: activeSettings.delivery, playing: playerQueue.isPlaying() }),
      toggle: toggleDelivery,
      stopPlay: () => { playerQueue.stop() },
      panelUrl: () => (panelToken !== undefined && panelPort !== undefined ? panelUrl(panelPort, panelToken) : null),
      audioStatus,
      audioFile,
      regenerate: regenerateTurn,
    })
  })
}
