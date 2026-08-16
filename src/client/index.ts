/**
 * browser half：TTS 的三个动作既注入 dsh-voice 声明的 `voice.menu` 宿主槽（与
 * 「设置会话Voice」共用 🎙️ 图标），也在 `voice.menu` 未声明（未安装 dsh-voice）时
 * 回落为标题栏独立的 🔊 入口。host 侧数据经 `/voice-tts/*` 路由往返；「Set voice
 * tts」内嵌独立面板。回落与否由 `voice.menu` 的声明是否存在决定（响应式，随声明增减切换）。
 * @module dsh-voice-tts/client
 */

import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 类型声明合并：拿 dsh-voice 声明的 `voice.menu` SlotMap 键（运行时零依赖）。
import type {} from '@meomeo-dev/dsh-voice/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { VoiceTtsHeaderAction, type VoiceTtsHeaderInjected } from './VoiceTtsHeaderAction.tsx'
import { VoiceTtsMenu, type VoiceTtsInjected } from './VoiceTtsMenu.tsx'
import { TurnTailPlayer } from './TurnTailPlayer.tsx'
import { en, NS, zh, type VoiceTtsSlotKey } from './locales.ts'
import { getPanelUrl, getState, stop, toggle } from './api.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'voice-tts-slot': VoiceTtsSlotKey
  }
}

export const inject = ['slots', 'locale']

/** turn-tail chain 选择器：始终当选，matched = turn 号（纯函数，仅 owner props）。 */
function selectTurn({ turn }: TurnTailOwnerProps): number {
  return turn.turn
}

/**
 * 客户端插件体：注册 locale 字典 + 两个互补入口。
 * - `voice.menu`（有 dsh-voice 时）：与 🎙️ 下拉合并。
 * - `conversation.session.header.actions`（无 dsh-voice 时）：独立 🔊 下拉回落。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-voice-tts: browser dictionaries')

  const actions = (): VoiceTtsInjected => ({
    getState,
    toggle: async () => { await toggle() },
    stop: async () => { await stop() },
    getPanelUrl: async () => (await getPanelUrl()).url,
  })

  // 🔊 回落入口：只有 `voice.menu` 未声明（dsh-voice 未装）时显示。
  const headerActions = (_sessionId: SessionId): VoiceTtsHeaderInjected => ({
    ...actions(),
    hooks: {
      voiceMenuDeclared: {
        getSnapshot: () => ctx.slots.spec('voice.menu') !== undefined,
        subscribe: fn => ctx.slots.subscribe('voice.menu', fn),
      } satisfies HostObservable<boolean>,
    },
  })

  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'voice-tts-fallback',
      order: 30,
      locale: NS,
      inject: headerActions,
    }, VoiceTtsHeaderAction),
  )

  // 合并入口：dsh-voice 存在时注入 voice.menu。
  ctx.slots.inject(
    'voice.menu',
    () => ctx.slots.register({
      name: 'voice.menu',
      id: 'voice-tts',
      locale: NS,
      inject: actions,
    }, VoiceTtsMenu),
  )

  // turn 末尾吸附的播放控制器（chain slot，每个 turn-tail 节点各渲染一个）。
  ctx.slots.inject(
    'conversation.chat.turnTail',
    () => ctx.slots.register({
      name: 'conversation.chat.turnTail',
      locale: NS,
      select: selectTurn,
      priority: 0,
    }, TurnTailPlayer),
  )
}
