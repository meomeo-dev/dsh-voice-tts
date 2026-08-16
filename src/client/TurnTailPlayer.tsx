/**
 * turn 末尾吸附的播放控制器：▶ 播放（无缓存时弹重生成模态）/ ■ 停止 / 时点·时长进度。
 *
 * 挂载零请求——点击 ▶ 才查 `/voice-tts/audio-status`，避免长会话每个 turn 各发一次
 * 请求的风暴。多 run（双语分片不同音色）顺序播放，时长/时点按累计口径；时长由
 * `<audio>` 元数据给出，host 不解析。设计见 docs/turn-tail-player.md。
 */

import { useRef, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import { audioStatus, audioUrl, regenerate } from './api.ts'
import css from './TurnTailPlayer.module.css'

/** turn-tail 播放控制器的完整 props（owner + session kit + chain matched + locale）。 */
export type TurnTailPlayerProps =
  PropsRuntime<'conversation.chat.turnTail'> & { matched: number } & PropsLocale<typeof NS>

/** 秒 → `m:ss`（非法值归零）。 */
function fmt(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const whole = Math.floor(safe)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * 吸附在 turn 尾部的播放控制器组件。
 * @param props - turn/sessionId（框架 kit）+ locale。
 * @returns 紧凑播放控件 + 重生成模态框。
 */
export function TurnTailPlayer({ turn, sessionId, t }: TurnTailPlayerProps) {
  const turnNum = turn.turn
  const audioRef = useRef<HTMLAudioElement>(null)
  // 事件处理闭包里的「当前段」以 ref 为准，规避 setState 尚未重渲染的竞态。
  const indexRef = useRef(0)
  const [segments, setSegments] = useState<string[]>([])
  const [durations, setDurations] = useState<number[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stop = (): void => {
    const audio = audioRef.current
    if (audio !== null) { audio.pause(); audio.currentTime = 0 }
    indexRef.current = 0
    setPlaying(false)
    setCurrentTime(0)
    setCurrentIndex(0)
  }

  const playSegment = (segs: readonly string[], index: number): void => {
    const audio = audioRef.current
    if (audio === null || segs[index] === undefined) return
    indexRef.current = index
    setCurrentIndex(index)
    setCurrentTime(0)
    audio.src = segs[index]!
    void audio.play()
    setPlaying(true)
  }

  const startFromStatus = (count: number): void => {
    const segs = Array.from({ length: count }, (_, i) => audioUrl(String(sessionId), turnNum, i))
    setSegments(segs)
    setDurations(new Array<number>(count).fill(0))
    setCurrentIndex(0)
    setCurrentTime(0)
    playSegment(segs, 0)
  }

  const onPlayClick = async (): Promise<void> => {
    if (busy || playing) return
    setBusy(true)
    setError(null)
    try {
      const status = await audioStatus(String(sessionId), turnNum)
      if (status.exists) startFromStatus(status.segments)
      else setModalOpen(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onRegenerate = async (): Promise<void> => {
    setModalOpen(false)
    setBusy(true)
    setError(null)
    try {
      const status = await regenerate(String(sessionId), turnNum)
      if (status.exists) startFromStatus(status.segments)
      else setError(t('player.regenerate.failed'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const total = durations.reduce((sum, d) => sum + (Number.isFinite(d) ? d : 0), 0)
  const elapsed = durations.slice(0, currentIndex).reduce((sum, d) => sum + (Number.isFinite(d) ? d : 0), 0) + currentTime
  const progress = total > 0 ? Math.min(1, elapsed / total) : 0

  return (
    <div className={css.root}>
      <button
        type="button"
        className={css.button}
        aria-label={playing ? t('player.stop') : t('player.play')}
        disabled={busy}
        onClick={() => { if (playing) stop(); else void onPlayClick() }}
      >
        {playing ? '■' : (busy ? '…' : '▶')}
      </button>
      {playing && (
        <span className={css.readout}>
          <span className={css.time}>{fmt(elapsed)} / {fmt(total)}</span>
          <span className={css.bar} role="progressbar" aria-valuemin={0} aria-valuemax={1} aria-valuenow={progress}>
            <span className={css.fill} style={{ width: `${progress * 100}%` }} />
          </span>
        </span>
      )}
      {error !== null && (
        <span className={css.error} title={error}>{error}</span>
      )}
      <audio
        ref={audioRef}
        className={css.audio}
        preload="auto"
        onLoadedMetadata={(e) => {
          const duration = e.currentTarget.duration
          setDurations(prev => {
            const next = [...prev]
            next[indexRef.current] = Number.isFinite(duration) ? duration : 0
            return next
          })
        }}
        onTimeUpdate={(e) => { setCurrentTime(e.currentTarget.currentTime) }}
        onEnded={() => {
          if (indexRef.current + 1 < segments.length) playSegment(segments, indexRef.current + 1)
          else stop()
        }}
        onError={() => { stop() }}
      />
      <Modal open={modalOpen} onClose={() => { setModalOpen(false) }} title={t('player.regenerate.title')} className={css.modal}>
        <p className={css.modalText}>{t('player.regenerate.prompt')}</p>
        <div className={css.modalActions}>
          <button type="button" className={css.modalPrimary} disabled={busy} onClick={() => { void onRegenerate() }}>
            {t('player.regenerate.confirm')}
          </button>
          <button type="button" className={css.modalCancel} onClick={() => { setModalOpen(false) }}>
            {t('player.regenerate.cancel')}
          </button>
        </div>
      </Modal>
    </div>
  )
}
