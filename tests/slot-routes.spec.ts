import { describe, expect, it } from 'vitest'
import { audioContentType, queryInt } from '../src/slot-routes.ts'

describe('audioContentType', () => {
  it('maps container formats browsers can play', () => {
    expect(audioContentType('mp3')).toBe('audio/mpeg')
    expect(audioContentType('wav')).toBe('audio/wav')
    expect(audioContentType('aiff')).toBe('audio/aiff')
    expect(audioContentType('ogg_opus')).toBe('audio/ogg')
    expect(audioContentType('opus')).toBe('audio/ogg')
    expect(audioContentType('pcm')).toBe('audio/L16')
  })

  it('falls back to octet-stream for unknown formats', () => {
    expect(audioContentType('flac')).toBe('application/octet-stream')
    expect(audioContentType('')).toBe('application/octet-stream')
  })
})

describe('queryInt', () => {
  it('reads a non-negative integer from the query string', () => {
    expect(queryInt('/voice-tts/audio?sessionId=a&turn=3&index=0', 'turn')).toBe(3)
    expect(queryInt('/voice-tts/audio?turn=0', 'turn')).toBe(0)
  })

  it('returns undefined for missing, empty, negative, or non-numeric values', () => {
    expect(queryInt('/voice-tts/audio?sessionId=a', 'turn')).toBeUndefined()
    expect(queryInt('/voice-tts/audio?turn=', 'turn')).toBeUndefined()
    expect(queryInt('/voice-tts/audio?turn=-1', 'turn')).toBeUndefined()
    expect(queryInt('/voice-tts/audio?turn=x', 'turn')).toBeUndefined()
    expect(queryInt(undefined, 'turn')).toBeUndefined()
  })
})
