/** 会话标题栏的 🔊 入口按钮：点开下拉菜单，含三个选项。 */

import { useEffect, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SlotState } from './api.ts'
import { NS } from './locales.ts'
import { VoiceTtsDialog } from './VoiceTtsDialog.tsx'
import css from './VoiceTtsAction.module.css'

/** 供父组件（header action）注入的业务动作。 */
export interface VoiceTtsInjected {
  getState: () => Promise<SlotState>
  toggle: () => Promise<void>
  stop: () => Promise<void>
  getPanelUrl: () => Promise<string | null>
}

/** header action 组件的完整 props。 */
export type VoiceTtsActionProps =
  PropsRuntime<'conversation.session.header.actions'> & VoiceTtsInjected & PropsLocale<typeof NS>

/**
 * 会话标题栏的 TTS 入口：一个 🔊 按钮 + 下拉菜单（Set / Turn on-off / Stop）。
 * @param props - 会话标准 props + 业务动作 + locale。
 * @returns 触发按钮与（打开时的）下拉菜单 + 模态框。
 */
export function VoiceTtsAction({ getState, toggle, stop, getPanelUrl, t }: VoiceTtsActionProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [state, setState] = useState<SlotState | null>(null)
  const [panelUrl, setPanelUrl] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // 打开菜单时拉取状态与面板 URL。
  useEffect(() => {
    if (!menuOpen) return
    let cancelled = false
    getState().then(next => { if (!cancelled) setState(next) }).catch(() => {})
    getPanelUrl().then(url => { if (!cancelled) setPanelUrl(url) }).catch(() => {})
    return () => { cancelled = true }
  }, [menuOpen, getState, getPanelUrl])

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

  const onToggle = (): void => {
    toggle()
      .then(() => getState())
      .then(next => setState(next))
      .catch(() => {})
  }

  const onStop = (): void => {
    stop()
      .then(() => getState())
      .then(next => setState(next))
      .catch(() => {})
  }

  const openDialog = (): void => {
    setMenuOpen(false)
    setDialogOpen(true)
  }

  const on = state?.on ?? false
  const playing = state?.playing ?? false

  return (
    <div className={css.root} ref={rootRef}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={t('trigger.aria')}
        onClick={() => { setMenuOpen(next => !next) }}
      >
        🔊
      </button>
      {menuOpen && (
        <div className={css.menu} role="menu">
          <button type="button" role="menuitem" className={css.menuItem} onClick={openDialog}>
            <span className={css.itemLabel}>{t('menu.setTts')}</span>
          </button>
          <button type="button" role="menuitem" className={css.menuItem} onClick={onToggle}>
            <span className={css.itemLabel}>{on ? t('menu.toggle.on') : t('menu.toggle.off')}</span>
            <span className={css.itemSub}>{on ? t('menu.toggle.sub.on') : t('menu.toggle.sub.off')}</span>
          </button>
          <button type="button" role="menuitem" className={css.menuItem} onClick={onStop}>
            <span className={css.itemLabel}>{t('menu.stop')}</span>
            <span className={css.itemSub}>{playing ? t('menu.stop.sub.playing') : t('menu.stop.sub.idle')}</span>
          </button>
        </div>
      )}
      <VoiceTtsDialog open={dialogOpen} onClose={() => { setDialogOpen(false) }} panelUrl={panelUrl} t={t} />
    </div>
  )
}
