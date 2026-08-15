import { describe, expect, it, vi } from 'vitest'
import { PlayerQueue, playFileToCompletion, resolvePlayer } from '../src/player.js'

describe('resolvePlayer', () => {
  it('maps darwin to afplay', () => {
    const player = resolvePlayer('darwin')
    expect(player?.bin).toBe('afplay')
    expect(player?.args('/tmp/a.wav')).toEqual(['/tmp/a.wav'])
  })

  it('maps linux to aplay', () => {
    const player = resolvePlayer('linux')
    expect(player?.bin).toBe('aplay')
    expect(player?.args('/tmp/a.wav')).toEqual(['/tmp/a.wav'])
  })

  it('maps win32 to powershell SoundPlayer', () => {
    const player = resolvePlayer('win32')
    expect(player?.bin).toBe('powershell')
    expect(player?.args('/tmp/a.wav').join(' ')).toContain("Media.SoundPlayer '/tmp/a.wav'")
  })

  it('returns undefined for unknown platforms', () => {
    expect(resolvePlayer('freebsd')).toBeUndefined()
  })
})

/** 可手动触发 exit/error 的假子进程。 */
class FakeChild {
  stderr = { on: vi.fn() }
  private handlers: Record<string, (arg?: unknown) => void> = {}

  on(event: string, cb: (arg?: unknown) => void): void {
    this.handlers[event] = cb
  }

  exit(code: number): void {
    this.handlers['exit']?.(code)
  }

  fail(err: Error): void {
    this.handlers['error']?.(err)
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

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('playFileToCompletion', () => {
  it('resolves on clean exit', async () => {
    const { children, spawnImpl } = fakeSpawn()
    const p = playFileToCompletion({ path: '/a.wav', format: 'wav' }, 'darwin', spawnImpl)
    children[0]!.exit(0)
    await expect(p).resolves.toBeUndefined()
  })

  it('rejects on non-zero exit', async () => {
    const { children, spawnImpl } = fakeSpawn()
    const p = playFileToCompletion({ path: '/a.wav', format: 'wav' }, 'darwin', spawnImpl)
    children[0]!.exit(1)
    await expect(p).rejects.toThrow(/code=1/)
  })
})

describe('PlayerQueue', () => {
  it('serializes playback in FIFO order (no overlap)', async () => {
    const { calls, children, spawnImpl } = fakeSpawn()
    const q = new PlayerQueue()
    const p1 = q.enqueue({ path: '/a.wav', format: 'wav' }, 'darwin', spawnImpl)
    const p2 = q.enqueue({ path: '/b.wav', format: 'wav' }, 'darwin', spawnImpl)
    await flush()
    expect(calls.length).toBe(1)
    expect(calls[0]!.args[0]).toBe('/a.wav')

    children[0]!.exit(0)
    await flush()
    expect(calls.length).toBe(2)
    expect(calls[1]!.args[0]).toBe('/b.wav')

    children[1]!.exit(0)
    await expect(p1).resolves.toBeUndefined()
    await expect(p2).resolves.toBeUndefined()
  })

  it('keeps the queue alive after a failed item', async () => {
    const { calls, children, spawnImpl } = fakeSpawn()
    const q = new PlayerQueue()
    const p1 = q.enqueue({ path: '/a.wav', format: 'wav' }, 'darwin', spawnImpl)
    const p2 = q.enqueue({ path: '/b.wav', format: 'wav' }, 'darwin', spawnImpl)
    await flush()
    children[0]!.exit(1) // 第一条失败
    await flush()
    expect(calls.length).toBe(2) // 第二条仍被调度
    children[1]!.exit(0)
    await expect(p1).rejects.toThrow()
    await expect(p2).resolves.toBeUndefined()
  })
})
