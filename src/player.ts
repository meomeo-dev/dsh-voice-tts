/**
 * 本机播放器后端(host_play 交付):可暂停/可 seek 的进程封装。
 *
 * `afplay` 无 pause/seek 原语,故默认改用 ffplay 的 `-ss` 重启式 seek:
 *   - 播放到位置 P:`ffplay -nodisp -autoexit -loglevel quiet -ss <P/1000> <file>`
 *   - 暂停 = kill 子进程 + 记位;恢复 = 以记位 `-ss` 重启;seek = 记位 + 重启。
 * 无 ffplay 时回退 afplay(仅 start/stop,pause/resume/seek 抛 `unsupported`)。
 * 只负责「在 host 进程所在机器发声」,状态编排见 {@link ./playback.js}。
 * @module dsh-voice-tts/player
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

/** 一个可播放的文件(路径 + 格式)。 */
export interface PlayableFile {
  readonly path: string
  readonly format: string
}

/** 播放器后端能力:start/pause/resume/seek/stop + 结束回调。 */
export interface AudioPlayer {
  /** 从 `startMs` 开始播放(0 = 从头)。重复 start 前先 stop。 */
  start(file: PlayableFile, startMs: number): void
  /** 暂停(记位并停进程)。 */
  pause(): void
  /** 从暂停位恢复。 */
  resume(): void
  /** 跳到 `ms` 并(若在播)续播。 */
  seek(ms: number): void
  /** 停止并归零。 */
  stop(): void
  /** 当前播放位置(毫秒)。 */
  position(): number
  /** 是否有进程在播。 */
  running(): boolean
  /** 播放自然结束回调(每条一次)。 */
  onEnded: (() => void) | null
  /** 播放错误回调(spawn 失败/非零退出)。 */
  onError: ((error: Error) => void) | null
}

/** ffplay 候选路径(按探测顺序)。 */
const FFPLAY_CANDIDATES = ['/opt/homebrew/bin/ffplay', '/usr/local/bin/ffplay', 'ffplay']

/** 探测 ffplay 命令路径;`command` 非空时直接用(不探测存在性)。 */
export function detectPlayerCommand(command = ''): string {
  if (command !== '') return command
  for (const candidate of FFPLAY_CANDIDATES) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate
    } else {
      return candidate // 纯命令名,交给 spawn 的 PATH 解析
    }
  }
  return '/usr/bin/afplay'
}

/**
 * ffplay 后端:`-ss` 重启式 seek,支持暂停/恢复/定位。
 * 位置 = offsetMs(已消费的绝对位置)+ 若在播 (clock - lastResumeClock)。
 */
export class FfplayPlayer implements AudioPlayer {
  private child: ChildProcess | undefined
  private file: PlayableFile | undefined
  private offsetMs = 0
  private playing = false
  private lastResumeClock = 0

  constructor(
    private readonly command: string = detectPlayerCommand(),
    private readonly clock: () => number = () => Date.now(),
    private readonly spawnImpl: typeof spawn = spawn,
  ) {}

  onEnded: (() => void) | null = null
  onError: ((error: Error) => void) | null = null

  start(file: PlayableFile, startMs: number): void {
    this.file = file
    this.offsetMs = Math.max(0, startMs)
    this.playFrom(this.offsetMs)
  }

  pause(): void {
    if (!this.playing) return
    this.offsetMs = this.position()
    this.kill()
    this.playing = false
  }

  resume(): void {
    if (this.playing || this.file === undefined) return
    this.playFrom(this.offsetMs)
  }

  seek(ms: number): void {
    this.offsetMs = Math.max(0, ms)
    if (this.playing) this.playFrom(this.offsetMs)
  }

  stop(): void {
    this.kill()
    this.playing = false
    this.offsetMs = 0
    this.file = undefined
  }

  position(): number {
    if (this.file === undefined) return 0
    return this.playing ? this.offsetMs + Math.max(0, this.clock() - this.lastResumeClock) : this.offsetMs
  }

  running(): boolean {
    return this.playing
  }

  private playFrom(startMs: number): void {
    this.kill()
    const file = this.file
    if (file === undefined) return
    const args = ['-nodisp', '-autoexit', '-loglevel', 'quiet']
    if (startMs > 0) args.push('-ss', String(startMs / 1000))
    args.push(file.path)
    const child = this.spawnImpl(this.command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    this.child = child
    this.playing = true
    this.lastResumeClock = this.clock()
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      this.playing = false
      this.onError?.(error)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      this.playing = false
      if (code === 0 || signal !== null) this.onEnded?.()
      else if (code !== null && stderr.trim().length > 0) this.onError?.(new Error(`ffplay exited code=${String(code)} stderr=${stderr.trim()}`))
      else this.onEnded?.()
    })
  }

  private kill(): void {
    const child = this.child
    this.child = undefined
    if (child !== undefined) child.kill()
  }
}

/**
 * afplay 后端(回退):仅 start/stop;pause/resume/seek 不支持(抛错)。
 * 位置 = 墙钟近似(从 start 起)。
 */
export class AfplayPlayer implements AudioPlayer {
  private child: ChildProcess | undefined
  private startedAt = 0
  private runningFlag = false

  constructor(
    private readonly command = '/usr/bin/afplay',
    private readonly clock: () => number = () => Date.now(),
    private readonly spawnImpl: typeof spawn = spawn,
  ) {}

  onEnded: (() => void) | null = null
  onError: ((error: Error) => void) | null = null

  start(file: PlayableFile, _startMs: number): void {
    this.startedAt = this.clock()
    const child = this.spawnImpl(this.command, [file.path], { stdio: ['ignore', 'ignore', 'pipe'] })
    this.child = child
    this.runningFlag = true
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', error => {
      this.runningFlag = false
      this.onError?.(error)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = undefined
      this.runningFlag = false
      if (code === 0 || signal !== null) this.onEnded?.()
      else this.onError?.(new Error(`afplay exited code=${String(code)} stderr=${stderr.trim()}`))
    })
  }

  pause(): void {
    throw new Error('afplay does not support pause/seek')
  }

  resume(): void {
    throw new Error('afplay does not support pause/seek')
  }

  seek(_ms: number): void {
    throw new Error('afplay does not support pause/seek')
  }

  stop(): void {
    this.child?.kill()
    this.child = undefined
    this.runningFlag = false
  }

  position(): number {
    return this.runningFlag ? Math.max(0, this.clock() - this.startedAt) : 0
  }

  running(): boolean {
    return this.runningFlag
  }
}
