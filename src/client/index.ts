/**
 * browser half：把 TTS 的三个动作注入 dsh-voice 声明的 `voice.menu` 宿主槽，
 * 与 dsh-voice 自己的「设置会话Voice」共用同一个 🎙️ 图标。host 侧数据经
 * `/voice-tts/*` 路由往返；「Set voice tts」内嵌独立面板。
 * @module dsh-voice-tts/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// 类型声明合并：拿 dsh-voice 声明的 `voice.menu` SlotMap 键（运行时零依赖）。
import type {} from '@meomeo-dev/dsh-voice/client'
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
 * 客户端插件体：注册 locale 字典 + 注入 voice.menu 菜单项。
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
    'voice.menu',
    () => ctx.slots.register({
      name: 'voice.menu',
      id: 'voice-tts',
      locale: NS,
      inject: actions,
    }, VoiceTtsAction),
  )
}
