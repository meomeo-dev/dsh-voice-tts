/**
 * host TTS 纯逻辑(不 import cordis):本地命令行合成(macOS `say`)。
 * 权威行为见 macOS `say(1)` man page:文本从 stdin 读、`-o` 写音频文件、
 * `-v` 选音色、`-r` 设语速、`-v '?'` 列出本机音色。输出恒为 AIFF(默认格式,
 * `afplay` 原生播放)。设计见 docs/host-provider-say.md。
 * @module dsh-voice-tts/host
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConfigTemplate, TtsResult, TtsVoice } from './types.js'

/** 默认本地 TTS 命令路径(macOS `say`)。 */
export const DEFAULT_HOST_COMMAND = '/usr/bin/say'

/** 默认语速(words per minute)。 */
export const DEFAULT_HOST_RATE = 175

/** `say` 输出音频格式(AIFF,默认且无需额外格式旗标)。 */
export const HOST_OUTPUT_FORMAT = 'aiff'

/** 推荐音色的展示名前缀(只影响展示,不污染 `voice_type`)。 */
export const RECOMMENDED_PREFIX = '(推荐) '

/** 推荐音色:新一代大陆简体中文神经音色,名以该后缀结尾。 */
const RECOMMENDED_ZH_SUFFIX = '(Chinese (China mainland))'

/** 判定一个 `say` 音色名是否为推荐音色(新一代大陆简体中文)。 */
export function isRecommendedSayVoice(name: string): boolean {
  return name.endsWith(RECOMMENDED_ZH_SUFFIX)
}

/** host provider 的完整配置模板(对齐 docs/host-provider-say.md)。 */
export const HOST_CONFIG_TEMPLATE: ConfigTemplate = {
  provider: 'host',
  config: {
    command: {
      type: 'string', required: true, default: DEFAULT_HOST_COMMAND,
      description: '本地 TTS 命令绝对路径,如 /usr/bin/say',
    },
    voice_type: {
      type: 'string', required: false, default: '',
      description: 'say 音色名(空 = 系统默认),本机列表见 `say -v "?"`',
    },
    rate: {
      type: 'number', required: false, default: DEFAULT_HOST_RATE,
      description: '语速 words per minute(`say -r`)',
    },
    bilingual: {
      type: 'string', required: false, default: 'both', enum: ['both', 'english_only', 'chinese_only'],
      description: 'bilingual 播报模式:both 全读 / english_only 只读纯英文 / chinese_only 只读纯中文;中英混写句仅 both 播报',
    },
    segment_strategy: {
      type: 'string', required: false, default: 'sentence', enum: ['off', 'sentence', 'script-run', 'custom-separator'],
      description: '文本切分策略:off 整段单一音色 / sentence 句子级(现状) / script-run 连续区段夹杂抑制 / custom-separator 自定义分段符切窗口',
    },
    segment_threshold: {
      type: 'number', required: false, default: 5,
      description: '夹杂区段长度阈值:区段脚本字符数 ≤ 该值且被异语言区段夹持则跳过(仅 both 生效)',
    },
    segment_separators: {
      type: 'string', required: false, default: '',
      description: 'custom-separator 的自定义分段符(任一命中即切窗口;空串 = 无命中,退化为句子级)',
    },
    voices: {
      type: 'object', required: false, default: null,
      description: '各语言类别槽位 { zh, en, mixed },每槽 { voice_type };缺省回退 voice_type',
    },
    voice_profiles: {
      type: 'object', required: false, default: null,
      description: 'per-voice 音色映射 { <voice id>: { zh, en, mixed } },槽位形状同 voices;命中当前 dsh-voice 的 voice id 时取代 voices',
    },
  },
  credentials: { apiKeyRef: '' },
}

/** 已解析的 host 合成参数(provider 合成时所需的最小字段)。 */
export interface ResolvedHostConfig {
  /** 本地 TTS 命令绝对路径。 */
  command: string
  /** say 音色名;空 = 系统默认。 */
  voice_type: string
  /** 语速(words per minute)。 */
  rate: number
}

/** 把宽松的请求配置归一为已解析的 host 参数(缺失字段回退默认)。 */
export function resolveHostConfig(config: Record<string, unknown>): ResolvedHostConfig {
  return {
    command: typeof config.command === 'string' && config.command !== '' ? config.command : DEFAULT_HOST_COMMAND,
    voice_type: typeof config.voice_type === 'string' ? config.voice_type : '',
    rate: typeof config.rate === 'number' && Number.isFinite(config.rate) ? config.rate : DEFAULT_HOST_RATE,
  }
}

/**
 * 构造一次 `say` 合成调用的参数(`-v`/`-r`/`-o`,文本走 stdin)。
 * @param config - 已解析参数。
 * @param outFile - 音频输出文件路径。
 * @returns spawn 参数列表。
 */
export function buildSayArgs(config: ResolvedHostConfig, outFile: string): string[] {
  const args: string[] = []
  if (config.voice_type !== '') args.push('-v', config.voice_type)
  args.push('-r', String(config.rate))
  args.push('-o', outFile)
  return args
}

/**
 * 跑一次 `say`:把文本写进 stdin、`-o` 写音频文件,等退出码 0 且 stderr 为空。
 * @param spawnImpl - spawn 实现(单测可注入)。
 * @param command - 本地 TTS 命令路径。
 * @param args - 命令参数。
 * @param text - 待合成文本。
 * @returns 合成完成(或失败)的 Promise。
 */
function runSay(
  spawnImpl: typeof spawn,
  command: string,
  args: readonly string[],
  text: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, [...args], { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0 && stderr.trim().length === 0) resolve()
      else reject(new Error(`say exited code=${String(code)} signal=${String(signal)} stderr=${stderr.trim()}`))
    })
    // `say` 若提前退出,stdin 写入会触发 EPIPE;吞掉避免未捕获错误,退出码才是判据。
    child.stdin.on('error', () => {})
    child.stdin.end(text)
  })
}

/**
 * 用 `say` 合成一段文本为 AIFF 字节:临时目录产出、读回、清理。
 * @param config - 已解析参数。
 * @param text - 待合成文本。
 * @param spawnImpl - spawn 实现(单测可注入)。
 * @returns 合成结果。
 */
export async function synthesizeSay(
  config: ResolvedHostConfig,
  text: string,
  spawnImpl: typeof spawn = spawn,
): Promise<TtsResult> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-voice-tts-say-'))
  const out = join(dir, `out.${HOST_OUTPUT_FORMAT}`)
  try {
    await runSay(spawnImpl, config.command, buildSayArgs(config, out), text)
    const audio = new Uint8Array(readFileSync(out))
    return { audio, format: HOST_OUTPUT_FORMAT, textWords: 0 }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 解析 `say -v '?'` 的输出为音色表。行格式:
 * `<name 右填充> <locale>  # <comment>`,name 可含空格(如 `Bad News`)。
 * 推荐音色(新一代大陆简体中文,名以 `(Chinese (China mainland))` 结尾)的展示名
 * 加 `(推荐) ` 前缀;`voice_type` 保持原始名,`-v` 参数仍直接可用。
 * @param text - `say -v '?'` 的 stdout。
 * @returns 归一化后的音色列表。
 */
export function parseSayVoices(text: string): TtsVoice[] {
  const voices: TtsVoice[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(.*?)\s+([a-z]{2}_[A-Z]{2})(?:\s+#\s*(.*))?$/.exec(line)
    if (match === null) continue
    const name = match[1]?.trim()
    const locale = match[2]!
    if (name === undefined || name.length === 0) continue
    voices.push({
      voice_type: name,
      name: isRecommendedSayVoice(name) ? `${RECOMMENDED_PREFIX}${name}` : name,
      scene: '本地语音',
      lang: locale,
      ability: match[3] ?? '',
      group: 'standard',
    })
  }
  return voices
}

/**
 * 同步列出本机 `say` 音色(`say -v '?'`)。命令缺失或非 macOS 时回退空表,不抛错。
 * @param spawnSyncImpl - spawnSync 实现(单测可注入)。
 * @returns 音色列表。
 */
export function listSayVoices(spawnSyncImpl: typeof spawnSync = spawnSync): TtsVoice[] {
  try {
    const result = spawnSyncImpl(DEFAULT_HOST_COMMAND, ['-v', '?'], { encoding: 'utf8' })
    if (result.status !== 0 || typeof result.stdout !== 'string') return []
    return parseSayVoices(result.stdout)
  } catch {
    return []
  }
}
