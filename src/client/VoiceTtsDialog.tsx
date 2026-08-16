/** 「Set voice tts」模态框：内嵌 `/voice-tts` 独立面板（iframe 复用，配置范围一致）。 */

import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import css from './VoiceTtsDialog.module.css'

/** 模态框 props。 */
export interface VoiceTtsDialogProps {
  open: boolean
  onClose: () => void
  /** 面板 URL（含 ac_token）；无面板时为 null。 */
  panelUrl: string | null
  t: TranslateNS<typeof NS>
}

/**
 * 内嵌面板的模态框。
 * @param props - open/onClose + 面板 URL + locale。
 * @returns 关闭时为 null，否则 overlay 树。
 */
export function VoiceTtsDialog({ open, onClose, panelUrl, t }: VoiceTtsDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={t('dialog.title')} className={css.modal}>
      {panelUrl === null
        ? <p className={css.unavailable}>{t('dialog.unavailable')}</p>
        : <iframe src={panelUrl} className={css.frame} title={t('dialog.title')} />}
    </Modal>
  )
}
