/**
 * 单一播放权威:host_play 与浏览器 `<audio>` 播放的统一状态机(纯逻辑,不 import cordis)。
 *
 * host 侧唯一真相源——「当前谁在播、播到哪、什么模式、能否停」。host_play 经
 * {@link hostPlay} 顺序播一段 turn 的多个分段(每个分段一个 {@link AudioPlayer} 后端),
 * 暂停/恢复/seek/停止都经它;浏览器 `<audio>` 经 {@link claimUi}/{@link releaseUi}
 * 宣称「我在播某 turn」(互斥:开始其一即停掉另一)。页面刷新后 `snapshot()` 仍能读
 * 到 host_play 状态并停止它。设计见 docs/audio-storage-and-playback.md §4。
 * @module dsh-voice-tts/playback
 */

import type { AudioPlayer, PlayableFile } from './player.js'

/** 播放模式:host = host_play 子进程;ui = 浏览器 `<audio>`。 */
export type PlaybackMode = 'host' | 'ui'

/** 播放子状态。 */
export type PlaybackStatus = 'playing' | 'paused'

/** 播放状态快照(经路由暴露给 browser half)。 */
export interface PlaybackState {
  /** 是否有正在进行的播放。 */
  readonly active: boolean
  /** 播放模式;空闲时为 null。 */
  readonly mode: PlaybackMode | null
  readonly sessionId: string | null
  readonly turn: number | null
  /** 当前段序号(多段时);非 host 或空闲时为 null。 */
  readonly segmentIndex: number | null
  /** 段总数;非 host 或空闲时为 null。 */
  readonly segmentCount: number | null
  /** 播放/暂停。 */
  readonly status: PlaybackStatus | null
  /** 已播位置(毫秒,当前段)。 */
  readonly positionMs: number
  /** 当前段时长(毫秒);不可解析时为 null。 */
  readonly durationMs: number | null
}

/** 空闲状态。 */
const IDLE: PlaybackState = {
  active: false, mode: null, sessionId: null, turn: null,
  segmentIndex: null, segmentCount: null, status: null, positionMs: 0, durationMs: null,
}

/**
 * 单一播放权威。构造注入 `AudioPlayer` 后端工厂(每次起新段都 new 一个,避免复用
 * 已退出子进程),单测可注入假后端。
 */
export class PlaybackController {
  private player: AudioPlayer | null = null
  private segments: readonly PlayableFile[] = []
  private durations: readonly (number | null)[] = []
  private segmentIndex = -1
  private sessionId: string | null = null
  private turn: number | null = null
  private mode: PlaybackMode | null = null
  private status: PlaybackStatus | null = null

  constructor(private readonly makePlayer: () => AudioPlayer) {}

  /** 是否有正在进行(或暂停)的播放。 */
  isActive(): boolean {
    return this.mode !== null
  }

  /** 是否正在播放(非暂停)。 */
  isPlaying(): boolean {
    return this.mode !== null && this.status === 'playing'
  }

  /**
   * host 播放一个 turn 的多个分段(顺序播,一段自然结束后下一段)。
   * 覆盖(并停掉)任何之前的 host/ui 播放。
   * @param sessionId - 会话 id。
   * @param turn - turn 号。
   * @param segments - 逐段文件。
   * @param durations - 逐段时长(毫秒,null = 未知)。
   */
  hostPlay(sessionId: string, turn: number, segments: readonly PlayableFile[], durations: readonly (number | null)[] = segments.map(() => null)): void {
    this.reset()
    if (segments.length === 0) return
    this.mode = 'host'
    this.sessionId = sessionId
    this.turn = turn
    this.segments = segments
    this.durations = durations
    this.segmentIndex = 0
    this.status = 'playing'
    this.playSegment(0)
  }

  /** 暂停当前 host 播放(浏览器 `<audio>` 的暂停不归它管)。 */
  pause(): void {
    if (this.mode !== 'host' || this.player === null) return
    this.player.pause()
    this.status = 'paused'
  }

  /** 恢复暂停的 host 播放。 */
  resume(): void {
    if (this.mode !== 'host' || this.player === null) return
    this.player.resume()
    this.status = 'playing'
  }

  /** 定位当前 host 播放到 `ms`。 */
  seek(ms: number): void {
    if (this.mode !== 'host' || this.player === null) return
    this.player.seek(ms)
  }

  /** 停止任何播放并清态。 */
  stop(): void {
    this.reset()
  }

  /** 浏览器 `<audio>` 宣称「我在播某 turn」(覆盖并停掉 host 播放)。 */
  claimUi(sessionId: string, turn: number): void {
    this.reset()
    this.mode = 'ui'
    this.sessionId = sessionId
    this.turn = turn
    this.status = 'playing'
  }

  /** 浏览器 `<audio>` 结束/释放(仅当当前是 ui 模式)。 */
  releaseUi(): void {
    if (this.mode === 'ui') this.reset()
  }

  /** 当前播放状态快照。 */
  snapshot(): PlaybackState {
    if (this.mode === null) return { ...IDLE }
    const durationMs = this.mode === 'host' ? (this.durations[this.segmentIndex] ?? null) : null
    const positionMs = this.mode === 'host' && this.player !== null ? this.player.position() : 0
    return {
      active: true,
      mode: this.mode,
      sessionId: this.sessionId,
      turn: this.turn,
      segmentIndex: this.mode === 'host' && this.segmentIndex >= 0 ? this.segmentIndex : null,
      segmentCount: this.mode === 'host' ? this.segments.length : null,
      status: this.status,
      positionMs,
      durationMs,
    }
  }

  /** 播放某一段(起新后端,接结束回调)。 */
  private playSegment(index: number): void {
    const segment = this.segments[index]
    if (segment === undefined) {
      this.reset()
      return
    }
    this.segmentIndex = index
    const player = this.makePlayer()
    this.player = player
    player.onEnded = () => {
      this.next()
    }
    player.onError = () => {
      this.next()
    }
    player.start(segment, 0)
  }

  /** 当前段结束 → 下一段或结束。 */
  private next(): void {
    if (this.mode !== 'host') return
    const nextIndex = this.segmentIndex + 1
    if (nextIndex >= this.segments.length) {
      this.reset()
      return
    }
    this.playSegment(nextIndex)
  }

  /** 停掉后端子进程并清全部状态。 */
  private reset(): void {
    this.player?.stop()
    this.player = null
    this.segments = []
    this.durations = []
    this.segmentIndex = -1
    this.sessionId = null
    this.turn = null
    this.mode = null
    this.status = null
  }
}
