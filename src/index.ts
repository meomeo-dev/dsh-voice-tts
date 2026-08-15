/**
 * dsh-voice-tts 插件入口:capability seam 的编排层。
 * 注册 `ctx.tts` Service Definition,挂载 volcengine Provider,并在 settings 存在时
 * 注册 `voice-tts` 设置命名空间与 `/dsh-voice-tts` 命令(Consumer)。
 * 纯逻辑(命令解析、请求构造、响应解析)在 `command.ts` / `volcengine.ts`,本文件只做接缝编排。
 * @module dsh-voice-tts
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { TtsService } from './service.js'
import { VolcengineTtsProvider } from './provider-volcengine.js'
import { DEFAULT_VOICE_TYPE } from './volcengine.js'
import type { VoiceTtsSettings } from './types.js'
import { concatAudio, planBilingualSpeech } from './bilingual.js'
import {
  filterVoices,
  listVoicesText,
  parseTtsCommand,
  renderConfigTemplate,
  renderStatus,
  USAGE,
} from './command.js'

export const name = 'dsh-voice-tts'
export const inject = ['commands']

/** 用户可写设置命名空间。 */
const NAMESPACE = settingsNamespace('voice-tts')

/** 该命名空间的 schema,缺省回退到 volcengine 默认配置。 */
const SCHEMA: z<VoiceTtsSettings> = z.object({
  autoplay: z.boolean().default(false),
  provider: z.string().default('volcengine'),
  providers: z.object({
    volcengine: z.object({
      voice_type: z.string().default(DEFAULT_VOICE_TYPE),
      resource_id: z.union(['seed-tts-2.0', 'seed-icl-2.0'] as const).default('seed-tts-2.0'),
      model: z.string().default(''),
      format: z.union(['mp3', 'pcm', 'ogg_opus', 'wav'] as const).default('mp3'),
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
    }),
  }),
})

/** 安全地转成可读字符串。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
      const volc = settings.providers.volcengine
      const plan = planBilingualSpeech(command.text, volc)
      if (plan.runs.length === 0) {
        return {
          kind: 'error',
          text: `no speechable sentences after bilingual=${volc.bilingual} filter (total ${plan.total} sentences)`,
        }
      }
      try {
        const parts: Uint8Array[] = []
        for (const run of plan.runs) {
          const result = await tts.synthesize(settings.provider, {
            text: run.text,
            config: { ...volc, voice_type: run.voice },
          })
          parts.push(result.audio)
        }
        const audio = concatAudio(parts)
        const cwd = invocation.agent.session.header.cwd ?? process.cwd()
        const outPath = resolve(cwd, `dsh-voice-tts-output.${volc.format}`)
        writeFileSync(outPath, audio)
        const langSummary = `zh=${plan.byLang.zh} en=${plan.byLang.en} mixed=${plan.byLang.mixed}`
        return {
          kind: 'success',
          text: `synthesized ${plan.spoken}/${plan.total} sentences (${langSummary}) in ${plan.runs.length} run(s), ${audio.byteLength} bytes -> ${outPath}`,
        }
      } catch (error) {
        return { kind: 'error', text: `synthesis failed: ${describeError(error)}` }
      }
    }
  }
}

/**
 * 插件入口:注册 `ctx.tts`(Service Definition)+ volcengine Provider(始终);
 * 在 settings 存在时注册 `voice-tts` 命名空间与 `/dsh-voice-tts` 命令(Consumer)。
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx: Context): void {
  // Service Definition —— 构造即注册为 ctx.tts,随插件 fiber 销毁。
  const tts = new TtsService(ctx)

  // Provider —— 首版仅 volcengine。
  ctx.effect(() => tts.registerProvider(new VolcengineTtsProvider()), 'volcengine provider')

  // Consumer —— settings 可选;存在时挂命令。
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(NAMESPACE, SCHEMA)
    ctx.commands.register({
      name: 'dsh-voice-tts',
      description: 'text-to-speech synthesis and config (volcengine seed-tts-2.0)',
      input: { hint: '[status|list-voices|config|speak]' },
      handler: invocation => executeTtsCommand(tts, scope, invocation),
    })
  })
}
