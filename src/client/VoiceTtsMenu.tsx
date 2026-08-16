/** TTS 的三个菜单项（Set voice tts / Turn on-off / Stop host play）+ 内嵌面板模态框。 */

import { useEffect, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SlotState } from './api.ts'
import { NS } from './locales.ts'
import { VoiceTtsDialog } from './VoiceTtsDialog.tsx'
import css from './VoiceTtsMenu.module.css'

/** 供父组件（voice.menu / 🔊 回落入口）注入的业务动作。 */
export interface VoiceTtsInjected {
  getState: () => Promise<SlotState>
  toggle: () => Promise<void>
  stop: () => Promise<void>
  getPanelUrl: () => Promise<string | null>
}

/** 菜单项组的完整 props（不带 SlotMap runtime，父组件决定其宿主槽）。 */
export type VoiceTtsMenuProps = VoiceTtsInjected & PropsLocale<typeof NS>

/**
 * TTS 的三个菜单项，挂在宿主槽（有 dsh-voice 时是 voice.menu，否则是 🔊 回落入口）里。
 * @param props - 业务动作 + locale。
 * @returns 三个菜单项按钮 + 「Set voice tts」模态框。
 */
export function VoiceTtsMenu({ getState, toggle, stop, getPanelUrl, t }: VoiceTtsMenuProps) {
  const [state, setState] = useState<SlotState | null>(null)
  const [panelUrl, setPanelUrl] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    getState().then(next => { if (!cancelled) setState(next) }).catch(() => {})
    getPanelUrl().then(url => { if (!cancelled) setPanelUrl(url) }).catch(() => {})
    return () => { cancelled = true }
  }, [getState, getPanelUrl])

  const onToggle = (): void => {
    toggle().then(() => getState()).then(next => setState(next)).catch(() => {})
  }

  const onStop = (): void => {
    stop().then(() => getState()).then(next => setState(next)).catch(() => {})
  }

  const on = state?.on ?? false
  const playing = state?.playing ?? false

  return (
    <>
      <button type="button" role="menuitem" className={css.item} onClick={() => { setDialogOpen(true) }}>
        <span className={css.itemLabel}>{t('menu.setTts')}</span>
      </button>
      <button type="button" role="menuitem" className={css.item} onClick={onToggle}>
        <span className={css.itemLabel}>{on ? t('menu.toggle.on') : t('menu.toggle.off')}</span>
        <span className={css.itemSub}>{on ? t('menu.toggle.sub.on') : t('menu.toggle.sub.off')}</span>
      </button>
      <button type="button" role="menuitem" className={css.item} onClick={onStop}>
        <span className={css.itemLabel}>{t('menu.stop')}</span>
        <span className={css.itemSub}>{playing ? t('menu.stop.sub.playing') : t('menu.stop.sub.idle')}</span>
      </button>
      <VoiceTtsDialog open={dialogOpen} onClose={() => { setDialogOpen(false) }} panelUrl={panelUrl} t={t} />
    </>
  )
}
