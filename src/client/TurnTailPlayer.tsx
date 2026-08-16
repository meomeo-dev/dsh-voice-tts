/**
 * turn 末尾吸附的播放控制器:三态渲染(空闲 / 浏览器播放 / host 播放),支持
 * 播放/暂停/停止 + 时点·时长进度。
 *
 * 挂载即读 `/voice-tts/playback`;若 host_play 正在播本 turn,则渲染 host 控制
 * (暂停/恢复/停止 + 近似进度,每秒轮询),页面刷新后仍能看到并停止 host_play。
 * 否则点 ▶ 走浏览器 `<audio>` 播放(全精度暂停/进度),并向 host `claim` 宣称
 * 「我在播本 turn」。设计见 docs/audio-storage-and-playback.md §4。
 */

import { useEffect, useRef, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import {
  audioStatus, audioUrl, claimPlayback, getPlayback, pausePlayback, regenerate,
  releasePlayback, resumePlayback, stopPlayback,
} from './api.ts'
import css from './TurnTailPlayer.module.css'

/** turn-tail 播放控制器的完整 props（owner + session kit + chain matched + locale）。 */
export type TurnTailPlayerProps =
  PropsRuntime<'conversation.chat.turnTail'> & { matched: number } & PropsLocale<typeof NS>

/** 浏览器 `<audio>` 播放的子状态。 */
type UiStatus = 'idle' | 'playing' | 'paused'

/** host_play 在本 turn 上的播放状态（来自轮询）。 */
interface HostState {
  status: 'playing' | 'paused'
  positionMs: number
  durationMs: number | null
  segmentIndex: number | null
  segmentCount: number | null
}

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
  const sid = String(sessionId)
  const audioRef = useRef<HTMLAudioElement>(null)
  const indexRef = useRef(0)

  // 浏览器播放状态。
  const [segments, setSegments] = useState<string[]>([])
  const [durations, setDurations] = useState<number[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [uiStatus, setUiStatus] = useState<UiStatus>('idle')
  // host_play 在本 turn 的状态。
  const [host, setHost] = useState<HostState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  // 挂载即读 host 播放状态,host 播本 turn 时每秒轮询刷新进度。
  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      getPlayback().then(p => {
        if (cancelled) return
        if (p.mode === 'host' && p.turn === turnNum && (p.status === 'playing' || p.status === 'paused')) {
          setHost({
            status: p.status,
            positionMs: p.positionMs,
            durationMs: p.durationMs,
            segmentIndex: p.segmentIndex,
            segmentCount: p.segmentCount,
          })
        } else {
          setHost(null)
        }
      }).catch(() => {
        if (!cancelled) setHost(null)
      })
    }
    refresh()
    const timer = setInterval(refresh, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [turnNum])

  // 卸载时释放浏览器播放 claim（host 播放不归本组件持有，无需释放）。
  useEffect(() => () => {
    void releasePlayback().catch(() => {})
  }, [])

  const stopUi = (): void => {
    const audio = audioRef.current
    if (audio !== null) { audio.pause(); audio.currentTime = 0 }
    indexRef.current = 0
    setUiStatus('idle')
    setCurrentTime(0)
    setCurrentIndex(0)
    void releasePlayback().catch(() => {})
  }

  const playSegment = (segs: readonly string[], index: number): void => {
    const audio = audioRef.current
    if (audio === null || segs[index] === undefined) return
    indexRef.current = index
    setCurrentIndex(index)
    setCurrentTime(0)
    audio.src = segs[index]!
    void audio.play()
    setUiStatus('playing')
  }

  const startFromStatus = (count: number): void => {
    const segs = Array.from({ length: count }, (_, i) => audioUrl(sid, turnNum, i))
    setSegments(segs)
    setDurations(new Array<number>(count).fill(0))
    setCurrentIndex(0)
    setCurrentTime(0)
    void claimPlayback(sid, turnNum).catch(() => {})
    playSegment(segs, 0)
  }

  const startUi = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const status = await audioStatus(sid, turnNum)
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
      const status = await regenerate(sid, turnNum)
      if (status.exists) startFromStatus(status.segments)
      else setError(t('player.regenerate.failed'))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onPrimary = (): void => {
    if (host !== null) {
      if (host.status === 'playing') void pausePlayback().then(setHostFrom).catch(() => {})
      else void resumePlayback().then(setHostFrom).catch(() => {})
      return
    }
    if (uiStatus === 'playing') {
      audioRef.current?.pause()
      setUiStatus('paused')
    } else if (uiStatus === 'paused') {
      void audioRef.current?.play()
      setUiStatus('playing')
    } else {
      void startUi()
    }
  }

  const setHostFrom = (p: { status: string | null; positionMs: number; durationMs: number | null; segmentIndex: number | null; segmentCount: number | null }): void => {
    if (p.status === 'playing' || p.status === 'paused') {
      setHost({ status: p.status, positionMs: p.positionMs, durationMs: p.durationMs, segmentIndex: p.segmentIndex, segmentCount: p.segmentCount })
    } else {
      setHost(null)
    }
  }

  const onStop = (): void => {
    if (host !== null) void stopPlayback().then(setHostFrom).catch(() => {})
    else stopUi()
  }

  const active = host !== null || uiStatus !== 'idle'
  const primaryLabel = (): string => {
    if (host !== null) return host.status === 'playing' ? t('player.pause') : t('player.resume')
    if (uiStatus === 'playing') return t('player.pause')
    if (uiStatus === 'paused') return t('player.resume')
    return t('player.play')
  }

  // 进度显示:host 用轮询值;浏览器用 `<audio>` 累计。
  const readout = (): string | null => {
    if (host !== null) {
      const pos = fmt(host.positionMs / 1000)
      const dur = host.durationMs === null ? null : fmt(host.durationMs / 1000)
      const seg = host.segmentCount !== null && host.segmentCount > 1 ? ` · ${host.segmentIndex! + 1}/${host.segmentCount}` : ''
      return dur === null ? `${pos}${seg}` : `${pos} / ${dur}${seg}`
    }
    if (uiStatus !== 'idle') {
      const total = durations.reduce((sum, d) => sum + (Number.isFinite(d) ? d : 0), 0)
      const elapsed = durations.slice(0, currentIndex).reduce((sum, d) => sum + (Number.isFinite(d) ? d : 0), 0) + currentTime
      return `${fmt(elapsed)} / ${fmt(total)}`
    }
    return null
  }

  const text = readout()

  return (
    <div className={css.root}>
      <button
        type="button"
        className={css.button}
        aria-label={primaryLabel()}
        disabled={busy}
        onClick={onPrimary}
      >
        {host !== null ? (host.status === 'playing' ? '⏸' : '▶') : uiStatus === 'playing' ? '⏸' : uiStatus === 'paused' ? '▶' : busy ? '…' : '▶'}
      </button>
      {active && (
        <button type="button" className={css.button} aria-label={t('player.stop')} onClick={onStop}>
          ■
        </button>
      )}
      {text !== null && (
        <span className={css.readout}>
          <span className={css.time}>{text}</span>
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
          else stopUi()
        }}
        onError={() => { stopUi() }}
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
