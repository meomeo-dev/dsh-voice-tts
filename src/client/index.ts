/**
 * browser half：把 🔊 TTS 入口注册进会话标题栏的
 * `conversation.session.header.actions` list 槽（与 dsh-voice 的 🎙️ 并排）。
 * host 侧数据经 `/voice-tts/*` 路由往返；「Set voice tts」内嵌独立面板。
 * @module dsh-voice-tts/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { VoiceTtsAction } from './VoiceTtsAction.tsx'
import type { VoiceTtsInjected } from './VoiceTtsAction.tsx'
import { en, NS, zh, type VoiceTtsSlotKey } from './locales.ts'
import { getPanelUrl, getState, stop, toggle } from './api.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'voice-tts-slot': VoiceTtsSlotKey
  }
}

export const inject = ['slots', 'locale']

/**
 * 客户端插件体：注册 locale 字典 + 标题栏 TTS 入口。
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

  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'voice-tts',
      order: 30,
      locale: NS,
      inject: actions,
    }, VoiceTtsAction),
  )
}
