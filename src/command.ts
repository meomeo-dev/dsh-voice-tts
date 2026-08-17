/**
 * `/dsh-voice-tts` 命令的参数解析与展示(纯函数,不 import cordis)。
 * rawInput 是字面值(见 design.md §5),`config --json` 直接取 `--json` 之后的原文。
 * @module dsh-voice-tts/command
 */

import type { BilingualVoiceConfig, DeliveryMode, HostConfig, TtsVoice, VoiceTtsSettings } from './types.js'
import type { ApiKeyRefSettings } from './types.js'
import { DEFAULT_VOICE_TYPE, VOLCENGINE_CONFIG_TEMPLATE } from './volcengine.js'
import { SILICONFLOW_CONFIG_TEMPLATE } from './siliconflow.js'
import { HOST_CONFIG_TEMPLATE } from './host.js'
import { OPENAI_CONFIG_TEMPLATE } from './openai.js'
import { MINIMAX_CONFIG_TEMPLATE } from './minimax.js'

/** 命令用法回显文案。 */
export const USAGE = [
  'Usage: /dsh-voice-tts [status|help]',
  '  status                            # 当前 provider / delivery / 各 provider 配置概览',
  '  use <provider>                    # 切换当前 provider(如 volcengine / siliconflow-cn / openai / minimax / host)',
  '  list-voices [provider] [query]    # 列出可用音色(可按 voice_type/名称/场景/语种过滤)',
  '  config --template [provider]      # 输出某 provider 的完整配置模板(JSON)',
  '  config --json <json>              # 用 JSON 覆盖「当前 provider」的配置(部分字段即可)',
  '  speak [--delivery <mode>] <text>  # 合成文本,按 delivery(默认读 settings.delivery)交付',
  '  ui                                # 打印 Web 配置面板 URL(web 模式专用)',
].join('\n')

const DELIVERY_MODES: readonly DeliveryMode[] = ['off', 'file', 'host_play', 'stream']

/** `/dsh-voice-tts` 的解析结果。 */
export type TtsCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'use'; readonly provider: string }
  | { readonly kind: 'list-voices'; readonly provider: string; readonly query: string }
  | { readonly kind: 'config-template'; readonly provider: string }
  | { readonly kind: 'config-json'; readonly json: string }
  | { readonly kind: 'speak'; readonly text: string; readonly delivery?: DeliveryMode }
  | { readonly kind: 'ui' }
  | { readonly kind: 'help' }

/**
 * 解析命令参数。`config --json` 后的文本**原样保留**(含空格),交给 `JSON.parse`;
 * `speak [--delivery <mode>] <text>` 支持可选交付模式覆盖。
 * @param rawInput - 命令名之后的原始文本(含前导空白)。
 * @returns 解析结果。
 */
export function parseTtsCommand(rawInput: string): TtsCommand {
  const input = rawInput.trim()
  if (input.length === 0 || input === 'status') return { kind: 'status' }
  if (input === 'help') return { kind: 'help' }

  const space = input.search(/\s/u)
  const head = space === -1 ? input : input.slice(0, space)
  const rest = space === -1 ? '' : input.slice(space + 1)

  switch (head) {
    case 'use': {
      const provider = rest.trim()
      return provider.length > 0 ? { kind: 'use', provider } : { kind: 'help' }
    }
    case 'list-voices': {
      const parts = rest.split(/\s+/u).filter(part => part.length > 0)
      return { kind: 'list-voices', provider: parts[0] ?? 'volcengine', query: parts.slice(1).join(' ') }
    }
    case 'config': {
      const args = rest.trim()
      if (args.startsWith('--template')) {
        const provider = args.slice('--template'.length).trim()
        return { kind: 'config-template', provider: provider.length > 0 ? provider : 'volcengine' }
      }
      if (args.startsWith('--json')) {
        // 原样保留 JSON(可能含空格),不做空白切分。
        return { kind: 'config-json', json: args.slice('--json'.length).trim() }
      }
      return { kind: 'help' }
    }
    case 'speak': {
      const match = /^--delivery\s+(\S+)\s+(.+)$/u.exec(rest)
      if (match !== null) {
        const mode = match[1] as DeliveryMode
        return { kind: 'speak', text: match[2]!, ...DELIVERY_MODES.includes(mode) ? { delivery: mode } : {} }
      }
      return { kind: 'speak', text: rest }
    }
    case 'ui':
      return { kind: 'ui' }
    default:
      return { kind: 'help' }
  }
}

/** 按子串过滤音色(voice_type / 名称 / 场景 / 语种,不区分大小写)。 */
export function filterVoices(voices: readonly TtsVoice[], query: string): readonly TtsVoice[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return voices
  return voices.filter(voice =>
    voice.voice_type.toLowerCase().includes(q)
    || voice.name.toLowerCase().includes(q)
    || voice.scene.toLowerCase().includes(q)
    || voice.lang.toLowerCase().includes(q),
  )
}

/**
 * 渲染音色列表为文本表。列对齐,首行表头。
 * @param voices - 待展示音色。
 * @param provider - 归属 provider(仅用于标题)。
 * @returns 多行列表文本。
 */
export function listVoicesText(voices: readonly TtsVoice[], provider: string): string {
  if (voices.length === 0) return `No voices for provider "${provider}".`
  const rows = voices.map(voice => [
    voice.voice_type,
    voice.name,
    voice.scene,
    voice.lang.replace(/\n/g, ' '),
    voice.ability,
    voice.tag ?? '',
  ] as const)
  const widths = [0, 1, 2, 3, 4, 5].map(col => Math.max(
    ...rows.map(row => row[col]!.length),
  ))
  const header = ['voice_type', 'name', 'scene', 'lang', 'ability', 'tag']
  const lines = [
    header.map((cell, col) => cell.padEnd(widths[col]!)).join('  ').trimEnd(),
    ...rows.map(row => row.map((cell, col) => cell.padEnd(widths[col]!)).join('  ').trimEnd()),
  ]
  return `${provider} voices (${voices.length}):\n${lines.join('\n')}`
}

/** 按 provider id 渲染 `config --template` JSON 模板。 */
export function renderConfigTemplate(providerId: string): string {
  if (providerId === 'siliconflow-cn') return JSON.stringify(SILICONFLOW_CONFIG_TEMPLATE, null, 2)
  if (providerId === 'host') return JSON.stringify(HOST_CONFIG_TEMPLATE, null, 2)
  if (providerId === 'openai') return JSON.stringify(OPENAI_CONFIG_TEMPLATE, null, 2)
  if (providerId === 'minimax') return JSON.stringify(MINIMAX_CONFIG_TEMPLATE, null, 2)
  return JSON.stringify(VOLCENGINE_CONFIG_TEMPLATE, null, 2)
}

/**
 * 渲染 `status` 概览:当前 provider、delivery、已注册 provider,以及每个 provider
 * 的凭证引用名(KEY NAME,不回显值)与双语音色概览。
 * @param settings - 已解析设置。
 * @param providerIds - 已注册 provider id 列表。
 * @returns 多行概览文本。
 */
export function renderStatus(settings: VoiceTtsSettings, providerIds: readonly string[]): string {
  const lines = [
    `provider:  ${settings.provider}`,
    `delivery:  ${settings.delivery}`,
    `providers: ${providerIds.join(', ')}`,
  ]
  for (const [id, cfg] of Object.entries(settings.providers)) {
    const c = cfg as BilingualVoiceConfig & ApiKeyRefSettings
    const zh = c.voices.zh?.voice_type || c.voice_type
    const en = c.voices.en?.voice_type || c.voice_type
    const mixed = c.voices.mixed?.voice_type || c.voices.zh?.voice_type || c.voice_type
    lines.push(`${id} config:`)
    if (id === 'host') {
      const h = cfg as HostConfig
      lines.push(`  command:    ${h.command}`)
      lines.push(`  voice_type: ${h.voice_type || '(system default)'}`)
      lines.push(`  rate:       ${h.rate}`)
    } else if (id === 'openai' || id === 'minimax') {
      const o = cfg as BilingualVoiceConfig & { vendor: string }
      const vendor = settings.vendors[o.vendor]
      lines.push(`  vendor:     ${o.vendor}${vendor === undefined ? ' (unknown!)' : ` (${vendor.label})`}`)
      lines.push(`  apiKeyRef:  ${vendor?.apiKeyRef ?? '(unknown)'}`)
      lines.push(`  voice_type: ${c.voice_type}`)
    } else {
      lines.push(`  apiKeyRef:  ${c.apiKeyRef}`)
      lines.push(`  voice_type: ${c.voice_type}`)
    }
    lines.push(`  bilingual:  ${c.bilingual}`)
    lines.push(`  voices:     zh=${zh}  en=${en}  mixed=${mixed}`)
  }
  return lines.join('\n')
}

/** 默认音色 id(供 status 展示)。 */
export { DEFAULT_VOICE_TYPE }

/** `/dsh-voice-tts-key` 命令的解析结果(provider 可选,缺省用当前 provider)。 */
export type KeyCommand =
  | { readonly kind: 'status'; readonly provider?: string }
  | { readonly kind: 'set'; readonly provider?: string; readonly value: string }
  | { readonly kind: 'unset'; readonly provider?: string }

/**
 * 解析 `/dsh-voice-tts-key` 命令:`set [provider] <value>` 存、`unset [provider]` 删、
 * `status [provider]` 查看状态。provider 缺省由调用方用当前 provider 补齐。
 * 该命令 `recordInput: false`,value 不进 session log。
 * @param rawInput - 命令名之后的原始文本(含前导空白)。
 * @param providerIds - 已注册 provider id 列表(用于区分 `set <provider> <value>` 与 `set <value>`)。
 * @returns 解析结果;非法输入回退 status。
 */
export function parseKeyCommand(rawInput: string, providerIds: readonly string[] = []): KeyCommand {
  const parts = rawInput.trim().split(/\s+/u).filter(part => part.length > 0)
  const head = parts[0] ?? ''
  const rest = parts.slice(1)
  if (head === '' || head === 'status') {
    return { kind: 'status', ...(rest.length > 0 ? { provider: rest[0] } : {}) }
  }
  if (head === 'unset') {
    return { kind: 'unset', ...(rest.length > 0 ? { provider: rest[0] } : {}) }
  }
  if (head === 'set') {
    if (rest.length === 0) return { kind: 'status' }
    if (providerIds.includes(rest[0]!)) {
      return { kind: 'set', provider: rest[0], value: rest.slice(1).join(' ') }
    }
    return { kind: 'set', value: rest.join(' ') }
  }
  return { kind: 'status' }
}
