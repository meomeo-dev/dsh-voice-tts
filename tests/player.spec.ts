import { describe, expect, it } from 'vitest'
import { resolvePlayer } from '../src/player.js'

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
