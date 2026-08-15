/**
 * `/dsh-voice-tts` 命令的参数解析与展示(纯函数,不 import cordis)。
 * rawInput 是字面值(见 design.md §5),`config --json` 直接取 `--json` 之后的原文。
 * @module dsh-voice-tts/command
 */

import type { DeliveryMode, TtsVoice, VoiceTtsSettings } from './types.js'
import { DEFAULT_VOICE_TYPE, VOLCENGINE_CONFIG_TEMPLATE } from './volcengine.js'

/** 命令用法回显文案。 */
export const USAGE = [
  'Usage: /dsh-voice-tts [status|help]',
  '  status                            # 当前 provider / delivery / 配置概览',
  '  list-voices [provider] [query]    # 列出可用音色(可按 voice_type/名称/场景/语种过滤)',
  '  config --template [provider]      # 输出某 provider 的完整配置模板(JSON)',
  '  config --json <json>              # 用 JSON 覆盖 provider 配置(部分字段即可)',
  '  speak [--delivery <mode>] <text>  # 合成文本,按 delivery(默认读 settings.delivery)交付',
].join('\n')

const DELIVERY_MODES: readonly DeliveryMode[] = ['off', 'file', 'host_play', 'stream']

/** `/dsh-voice-tts` 的解析结果。 */
export type TtsCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'list-voices'; readonly provider: string; readonly query: string }
  | { readonly kind: 'config-template'; readonly provider: string }
  | { readonly kind: 'config-json'; readonly json: string }
  | { readonly kind: 'speak'; readonly text: string; readonly delivery?: DeliveryMode }
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

/** 渲染 volcengine 的 `config --template` JSON 模板。 */
export function renderConfigTemplate(): string {
  return JSON.stringify(VOLCENGINE_CONFIG_TEMPLATE, null, 2)
}

/**
 * 渲染 `status` 概览:当前 provider、delivery、已注册 provider 与 volcengine 配置。
 * @param settings - 已解析设置。
 * @param providerIds - 已注册 provider id 列表。
 * @returns 多行概览文本。
 */
export function renderStatus(settings: VoiceTtsSettings, providerIds: readonly string[]): string {
  const v = settings.providers.volcengine
  return [
    `provider:  ${settings.provider}`,
    `delivery:  ${settings.delivery}`,
    `providers: ${providerIds.join(', ')}`,
    `volcengine config:`,
    `  voice_type:   ${v.voice_type}`,
    `  resource_id:  ${v.resource_id}`,
    `  format:       ${v.format}  play_format: ${v.play_format} @ ${v.sample_rate} Hz`,
    `  speech_rate:  ${v.speech_rate}  loudness_rate: ${v.loudness_rate}  pitch: ${v.pitch}`,
    `  bilingual:    ${v.bilingual}`,
    `  voices:       zh=${v.voices.zh ?? v.voice_type}  en=${v.voices.en ?? v.voice_type}  mixed=${v.voices.mixed ?? v.voices.zh ?? v.voice_type}`,
  ].join('\n')
}

/** 默认音色 id(供 status 展示)。 */
export { DEFAULT_VOICE_TYPE }

/** `/dsh-voice-tts-key` 命令的解析结果。 */
export type KeyCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'set'; readonly value: string }
  | { readonly kind: 'unset' }

/**
 * 解析 `/dsh-voice-tts-key` 命令:set <value> 存、unset 删、其余查看状态。
 * 该命令 `recordInput: false`,value 不进 session log。
 * @param rawInput - 命令名之后的原始文本(含前导空白)。
 * @returns 解析结果;非法输入回退 status。
 */
export function parseKeyCommand(rawInput: string): KeyCommand {
  const input = rawInput.trim()
  if (input.length === 0 || input === 'status') return { kind: 'status' }
  if (input === 'unset') return { kind: 'unset' }
  if (input.startsWith('set ')) {
    const value = input.slice('set '.length).trim()
    if (value.length > 0) return { kind: 'set', value }
  }
  return { kind: 'status' }
}
