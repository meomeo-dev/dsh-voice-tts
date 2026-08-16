/**
 * 🔊 回落入口：当 dsh-voice 未安装（`voice.menu` 宿主槽未声明）时，独立注册进
 * 会话标题栏，自带下拉渲染 TTS 菜单项；当 dsh-voice 已安装（`voice.menu` 已声明）
 * 时返回 null，交由 voice.menu 合并入口渲染，避免重复图标。
 */

import { useEffect, useRef, useState } from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import { VoiceTtsMenu, type VoiceTtsInjected } from './VoiceTtsMenu.tsx'
import css from './VoiceTtsHeaderAction.module.css'

/** 回落入口的注入面：业务动作 + 一个 voice.menu 声明是否存在的响应式快照。 */
export interface VoiceTtsHeaderInjected extends VoiceTtsInjected {
  hooks: { voiceMenuDeclared: HostObservable<boolean> }
}

/** header action 组件的完整 props（hooks 隔间已绑定为 useVoiceMenuDeclared）。 */
export type VoiceTtsHeaderActionProps =
  PropsRuntime<'conversation.session.header.actions'> &
  InjectFace<VoiceTtsHeaderInjected> &
  PropsLocale<typeof NS>

/**
 * 🔊 标题栏入口：无 dsh-voice 时显示，点开下拉渲染 TTS 菜单项。
 * @param props - 会话标准 props + 业务动作 + useVoiceMenuDeclared + locale。
 * @returns 触发按钮与（打开时的）下拉菜单；有 dsh-voice 时为 null。
 */
export function VoiceTtsHeaderAction({ useVoiceMenuDeclared, ...menu }: VoiceTtsHeaderActionProps) {
  const hosted = useVoiceMenuDeclared(declared => declared)
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [menuOpen])

  if (hosted) return null

  return (
    <div className={css.root} ref={rootRef}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={menu.t('trigger.aria')}
        onClick={() => { setMenuOpen(next => !next) }}
      >
        🔊
      </button>
      {menuOpen && (
        <div className={css.menu} role="menu">
          <VoiceTtsMenu {...menu} />
        </div>
      )}
    </div>
  )
}
