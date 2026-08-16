import { describe, expect, it, vi } from 'vitest'
import { AfplayPlayer, detectPlayerCommand, FfplayPlayer } from '../src/player.js'
import type { AudioPlayer, PlayableFile } from '../src/player.js'

/** 可手动触发 exit/error 的假子进程。 */
class FakeChild {
  stderr = { on: vi.fn() }
  kill = vi.fn()
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {}

  on(event: string, cb: (...args: unknown[]) => void): void {
    (this.handlers[event] ??= []).push(cb)
  }

  exit(code: number, signal: string | null): void {
    for (const cb of this.handlers['exit'] ?? []) cb(code, signal)
  }

  fail(err: Error): void {
    for (const cb of this.handlers['error'] ?? []) cb(err)
  }
}

function fakeSpawn(): { calls: Array<{ bin: string; args: string[] }>; children: FakeChild[]; spawnImpl: typeof import('node:child_process').spawn } {
  const calls: Array<{ bin: string; args: string[] }> = []
  const children: FakeChild[] = []
  const spawnImpl = vi.fn((bin: string, args: string[]) => {
    calls.push({ bin, args })
    const child = new FakeChild()
    children.push(child)
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { calls, children, spawnImpl }
}

const FILE: PlayableFile = { path: '/a.aiff', format: 'aiff' }

describe('detectPlayerCommand', () => {
  it('uses explicit command verbatim', () => {
    expect(detectPlayerCommand('/custom/ffplay')).toBe('/custom/ffplay')
  })
})

describe('FfplayPlayer', () => {
  it('spawns with -nodisp/-autoexit and -ss only when startMs>0', () => {
    const { calls, spawnImpl } = fakeSpawn()
    const p = new FfplayPlayer('/ffplay', () => 0, spawnImpl)
    p.start(FILE, 0)
    expect(calls[0]!.args).toEqual(['-nodisp', '-autoexit', '-loglevel', 'quiet', '/a.aiff'])

    p.start(FILE, 1500)
    expect(calls[1]!.args).toEqual(['-nodisp', '-autoexit', '-loglevel', 'quiet', '-ss', '1.5', '/a.aiff'])
  })

  it('pause records position and kills; resume restarts with -ss', () => {
    let t = 0
    const { calls, children, spawnImpl } = fakeSpawn()
    const p = new FfplayPlayer('/ffplay', () => t, spawnImpl)
    p.start(FILE, 0)
    t = 1000
    p.pause()
    expect(p.position()).toBe(1000)
    expect(p.running()).toBe(false)
    expect(children[0]!.kill).toHaveBeenCalled()

    p.resume()
    expect(calls[1]!.args).toContain('-ss')
    expect(calls[1]!.args.at(-2)).toBe('1')
    expect(p.running()).toBe(true)
  })

  it('seek restarts at the given position while playing', () => {
    const { calls, spawnImpl } = fakeSpawn()
    const p = new FfplayPlayer('/ffplay', () => 0, spawnImpl)
    p.start(FILE, 0)
    p.seek(500)
    expect(p.position()).toBe(500)
    expect(calls[1]!.args).toContain('-ss')
    expect(calls[1]!.args.at(-2)).toBe('0.5')
  })

  it('stop kills and resets position', () => {
    const { children, spawnImpl } = fakeSpawn()
    const p = new FfplayPlayer('/ffplay', () => 0, spawnImpl)
    p.start(FILE, 0)
    p.stop()
    expect(children[0]!.kill).toHaveBeenCalled()
    expect(p.running()).toBe(false)
    expect(p.position()).toBe(0)
  })

  it('fires onEnded on clean exit', () => {
    const { children, spawnImpl } = fakeSpawn()
    const p = new FfplayPlayer('/ffplay', () => 0, spawnImpl)
    const ended = vi.fn()
    p.onEnded = ended
    p.start(FILE, 0)
    children[0]!.exit(0, null)
    expect(ended).toHaveBeenCalled()
  })

  it('fires onError on spawn error', () => {
    const { children, spawnImpl } = fakeSpawn()
    const p = new FfplayPlayer('/ffplay', () => 0, spawnImpl)
    const err = vi.fn()
    p.onError = err
    p.start(FILE, 0)
    children[0]!.fail(new Error('ENOENT'))
    expect(err).toHaveBeenCalled()
  })
})

describe('AfplayPlayer', () => {
  it('spawns afplay with the path and no seek args', () => {
    const { calls, spawnImpl } = fakeSpawn()
    const p = new AfplayPlayer('/usr/bin/afplay', () => 0, spawnImpl)
    p.start(FILE, 0)
    expect(calls[0]).toEqual({ bin: '/usr/bin/afplay', args: ['/a.aiff'] })
  })

  it('pause/resume/seek throw unsupported', () => {
    const { spawnImpl } = fakeSpawn()
    const p: AudioPlayer = new AfplayPlayer('/usr/bin/afplay', () => 0, spawnImpl)
    p.start(FILE, 0)
    expect(() => { p.pause() }).toThrow(/pause\/seek/)
    expect(() => { p.resume() }).toThrow(/pause\/seek/)
    expect(() => { p.seek(10) }).toThrow(/pause\/seek/)
  })

  it('position is wall-clock since start; stop resets', () => {
    let t = 0
    const { children, spawnImpl } = fakeSpawn()
    const p = new AfplayPlayer('/usr/bin/afplay', () => t, spawnImpl)
    p.start(FILE, 0)
    t = 2500
    expect(p.position()).toBe(2500)
    p.stop()
    expect(children[0]!.kill).toHaveBeenCalled()
    expect(p.position()).toBe(0)
  })
})
