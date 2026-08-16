import { describe, expect, it } from 'vitest'
import { PlaybackController } from '../src/playback.js'
import type { AudioPlayer, PlayableFile } from '../src/player.js'

/** 假后端:记录生命周期,手动触发结束/位置。 */
class FakePlayer implements AudioPlayer {
  started: Array<{ file: PlayableFile; startMs: number }> = []
  paused = false
  resumed = false
  seeks: number[] = []
  stopped = false
  pos = 0
  private runningFlag = false

  onEnded: (() => void) | null = null
  onError: ((error: Error) => void) | null = null

  start(file: PlayableFile, startMs: number): void {
    this.started.push({ file, startMs })
    this.runningFlag = true
  }

  pause(): void { this.paused = true; this.runningFlag = false }
  resume(): void { this.resumed = true; this.runningFlag = true }
  seek(ms: number): void { this.seeks.push(ms) }
  stop(): void { this.stopped = true; this.runningFlag = false }
  position(): number { return this.pos }
  running(): boolean { return this.runningFlag }
  end(): void { this.onEnded?.() }
}

function controller(): { c: PlaybackController; players: FakePlayer[] } {
  const players: FakePlayer[] = []
  const c = new PlaybackController(() => {
    const p = new FakePlayer()
    players.push(p)
    return p
  })
  return { c, players }
}

const SEGS: PlayableFile[] = [{ path: '/a.aiff', format: 'aiff' }, { path: '/b.aiff', format: 'aiff' }]

describe('PlaybackController', () => {
  it('starts idle', () => {
    const { c } = controller()
    expect(c.snapshot().active).toBe(false)
    expect(c.isPlaying()).toBe(false)
  })

  it('hostPlay starts segment 0 and reports state', () => {
    const { c, players } = controller()
    c.hostPlay('s1', 3, SEGS, [1000, 2000])
    const s = c.snapshot()
    expect(s).toMatchObject({ active: true, mode: 'host', sessionId: 's1', turn: 3, segmentIndex: 0, segmentCount: 2, status: 'playing', durationMs: 1000 })
    expect(players[0]!.started).toEqual([{ file: SEGS[0], startMs: 0 }])
  })

  it('advances to the next segment on ended, then resets', () => {
    const { c, players } = controller()
    c.hostPlay('s1', 3, SEGS, [1000, 2000])
    players[0]!.end()
    expect(c.snapshot().segmentIndex).toBe(1)
    expect(players[1]!.started[0]!.file).toEqual(SEGS[1])
    players[1]!.end()
    expect(c.snapshot().active).toBe(false)
  })

  it('pause/resume/seek/stop forward to the host backend', () => {
    const { c, players } = controller()
    c.hostPlay('s1', 1, SEGS, [1000, 2000])
    c.pause()
    expect(players[0]!.paused).toBe(true)
    expect(c.snapshot().status).toBe('paused')
    c.resume()
    expect(players[0]!.resumed).toBe(true)
    expect(c.snapshot().status).toBe('playing')
    c.seek(500)
    expect(players[0]!.seeks).toEqual([500])
    c.stop()
    expect(players[0]!.stopped).toBe(true)
    expect(c.snapshot().active).toBe(false)
  })

  it('position and duration come from the current segment', () => {
    const { c, players } = controller()
    c.hostPlay('s1', 1, SEGS, [1000, 2000])
    players[0]!.pos = 750
    expect(c.snapshot().positionMs).toBe(750)
    expect(c.snapshot().durationMs).toBe(1000)
  })

  it('claimUi sets mode=ui and covers host playback', () => {
    const { c, players } = controller()
    c.hostPlay('s1', 1, SEGS, [1000, 2000])
    c.claimUi('s2', 9)
    expect(players[0]!.stopped).toBe(true)
    expect(c.snapshot()).toMatchObject({ active: true, mode: 'ui', sessionId: 's2', turn: 9 })
    c.releaseUi()
    expect(c.snapshot().active).toBe(false)
  })

  it('releaseUi is a no-op when host is active', () => {
    const { c } = controller()
    c.hostPlay('s1', 1, SEGS, [1000, 2000])
    c.releaseUi()
    expect(c.snapshot().mode).toBe('host')
  })

  it('empty hostPlay does not activate', () => {
    const { c } = controller()
    c.hostPlay('s1', 1, [], [])
    expect(c.snapshot().active).toBe(false)
  })
})
