/**
 * 本机后台播放(host_play 交付):跨平台探测系统播放器,非阻塞 spawn。
 * 只负责「在 host 进程所在的机器上发声」,与浏览器/前端无关。
 * @module dsh-voice-tts/player
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/** 一个可播放的文件(路径 + 扩展名)。 */
export interface PlayableFile {
  readonly path: string
  readonly format: string
}

/**
 * 按平台探测系统播放器的命令行。返回 `{ bin, args }`,其中 `args` 用 `{path}` 占位。
 * - macOS:`afplay <path>`
 * - Linux:`aplay <path>`(ALSA,wav)
 * - Windows:`powershell -NoProfile -Command (New-Object Media.SoundPlayer '<path>').PlaySync()`
 * @returns 播放器命令;无匹配平台返回 undefined。
 */
export function resolvePlayer(platform: NodeJS.Platform = process.platform): { bin: string; args: (path: string) => string[] } | undefined {
  switch (platform) {
    case 'darwin':
      return { bin: 'afplay', args: path => [path] }
    case 'linux':
      return { bin: 'aplay', args: path => [path] }
    case 'win32':
      return {
        bin: 'powershell',
        args: path => ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${path}').PlaySync()`],
      }
    default:
      return undefined
  }
}

/**
 * 非阻塞播放一个音频文件。返回子进程句柄;找不到平台播放器时返回 undefined。
 * 播放失败不抛出(后台播放不应影响会话),错误与退出码交给可选的 `onError` 回调。
 * @param file - 待播放文件。
 * @param onError - 可选错误回调,收到 spawn 失败、非零退出码或 stderr 内容。
 * @returns 子进程句柄;无匹配播放器则 undefined。
 */
export function playFile(
  file: PlayableFile,
  onError?: (error: Error) => void,
): ChildProcess | undefined {
  const player = resolvePlayer()
  if (player === undefined) {
    onError?.(new Error(`no system player for platform "${process.platform}"`))
    return undefined
  }
  // 捕获 stderr 与退出码:无声失败(spawn 失败、播放器报错)必须可见,不能静默吞掉。
  const child = spawn(player.bin, player.args(file.path), { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })
  child.on('error', error => {
    onError?.(error)
  })
  child.on('exit', (code, signal) => {
    if (code !== 0 || stderr.trim().length > 0) {
      onError?.(new Error(`player ${player.bin} exited code=${String(code)} signal=${String(signal)} stderr=${stderr.trim()}`))
    }
  })
  return child
}

/**
 * 播放一个音频文件并在**播放结束后**才 resolve(退出码 0 且无 stderr)。
 * 无匹配平台播放器、spawn 失败、非零退出码或 stderr 均 reject。
 * 供串行队列(见 {@link PlayerQueue})等待一条播完再播下一条。
 * @param file - 待播放文件。
 * @param platform - 平台覆盖(单测用),默认当前平台。
 * @param spawnImpl - spawn 实现覆盖(单测用)。
 * @returns 播放完成(或失败)的 Promise。
 */
export function playFileToCompletion(
  file: PlayableFile,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: typeof spawn = spawn,
): Promise<void> {
  const player = resolvePlayer(platform)
  if (player === undefined) {
    return Promise.reject(new Error(`no system player for platform "${platform}"`))
  }
  return new Promise((resolve, reject) => {
    const child = spawnImpl(player.bin, player.args(file.path), { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0 && stderr.trim().length === 0) {
        resolve()
      } else {
        reject(new Error(`player ${player.bin} exited code=${String(code)} signal=${String(signal)} stderr=${stderr.trim()}`))
      }
    })
  })
}

/**
 * 串行播放队列:一次只播一个音频文件,前一条播完(或失败)才播下一条。
 * 解决多个会话 / 多个 turn 并发触发 host_play 时系统播放器被抢占、音频重叠的问题。
 */
export class PlayerQueue {
  /** 队尾 Promise:新播放项链在它之后,保证 FIFO 串行。 */
  private tail: Promise<void> = Promise.resolve()

  /** 正在播放的子进程;无播放时为 undefined。 */
  private current: ChildProcess | undefined

  /** 停止纪元:每次 stop() 自增,使队列里未开始的项作废。 */
  private epoch = 0

  /**
   * 入队播放一个文件。立即返回本条播放的 Promise(resolve/reject 在该条播完时),
   * 实际发声时刻取决于队列里前面的项。在 {@link stop} 之后入队的项仍会排队,
   * 但之前已入队而未开始的项会因 epoch 变化被作废。
   * @param file - 待播放文件。
   * @param platform - 平台覆盖(单测用)。
   * @param spawnImpl - spawn 实现覆盖(单测用)。
   * @returns 本条播放完成(或失败)的 Promise。
   */
  enqueue(
    file: PlayableFile,
    platform: NodeJS.Platform = process.platform,
    spawnImpl: typeof spawn = spawn,
  ): Promise<void> {
    const queuedEpoch = this.epoch
    // 捕获本轮 spawn 出的子进程,供 stop() 精确 kill;子进程退出时清除引用。
    const captured = ((command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      const child = spawnImpl(command, args, options)
      this.current = child
      child.once('exit', () => {
        if (this.current === child) this.current = undefined
      })
      return child
    }) as typeof spawn
    const run = this.tail.then(() => {
      if (queuedEpoch !== this.epoch) return
      return playFileToCompletion(file, platform, captured)
    })
    // 用 catch 保活队尾:某条失败(含被 stop 打断)不影响后续条目的调度。
    this.tail = run.catch(() => {})
    return run
  }

  /**
   * 停止当前播放并作废队列里未开始的项:杀当前子进程,epoch 自增。
   * 已 kill 的子进程触发 exit(非零/信号),其 enqueue promise reject,
   * 由调用方(deliverSpeech)的 catch 兜底。
   */
  stop(): void {
    this.epoch += 1
    this.current?.kill()
    this.current = undefined
  }

  /** 当前是否有正在播放的子进程。 */
  isPlaying(): boolean {
    return this.current !== undefined
  }
}
