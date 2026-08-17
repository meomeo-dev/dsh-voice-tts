import { describe, expect, it } from 'vitest'
import { buildMinimaxRequest, MINIMAX_API_PATH, synthesizeMinimax } from '../src/minimax.ts'
import type { MinimaxConfig } from '../src/types.ts'

function cfg(over: Partial<MinimaxConfig> = {}): MinimaxConfig {
  return {
    vendor: 'v1',
    model: 'speech-2.8-turbo',
    voice_type: 'Chinese (Mandarin)_Reliable_Executive',
    speed: 1,
    vol: 1,
    pitch: 0,
    emotion: '',
    sample_rate: 32000,
    format: 'mp3',
    play_format: 'wav',
    bitrate: 128000,
    channel: 1,
    bilingual: 'both',
    voices: {},
    voice_profiles: {},
    ...over,
  }
}

describe('buildMinimaxRequest', () => {
  it('builds DashScope-style body (non-stream by default)', () => {
    const { headers, body } = buildMinimaxRequest(cfg(), 'sk-test', 'hello')
    expect(headers.Authorization).toBe('Bearer sk-test')
    const parsed = JSON.parse(body)
    expect(parsed).toEqual({
      model: 'speech-2.8-turbo',
      text: 'hello',
      stream: false,
      voice_setting: { voice_id: 'Chinese (Mandarin)_Reliable_Executive', speed: 1, vol: 1, pitch: 0 },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    })
  })

  it('includes emotion when set, omits when empty', () => {
    expect(JSON.parse(buildMinimaxRequest(cfg(), 'k', 'x').body).voice_setting).not.toHaveProperty('emotion')
    expect(JSON.parse(buildMinimaxRequest(cfg({ emotion: 'happy' }), 'k', 'x').body).voice_setting.emotion).toBe('happy')
  })

  it('sets stream: true for streaming', () => {
    expect(JSON.parse(buildMinimaxRequest(cfg(), 'k', 'x', true).body).stream).toBe(true)
  })
})

describe('synthesizeMinimax', () => {
  it('POSTs to baseUrl + /t2a_v2 and decodes hex audio', async () => {
    const hex = Buffer.from([1, 2, 3, 255]).toString('hex')
    const fetchImpl = (async (url: string | URL | Request) => {
      expect(String(url)).toBe(`https://api.302.ai/minimaxi/v1${MINIMAX_API_PATH}`)
      return new Response(JSON.stringify({ data: { audio: hex } }), { status: 200 })
    }) as typeof fetch
    const result = await synthesizeMinimax(cfg(), 'https://api.302.ai/minimaxi/v1', 'sk-test', 'hi', fetchImpl)
    expect(result.format).toBe('mp3')
    expect([...result.audio]).toEqual([1, 2, 3, 255])
  })

  it('throws when audio is missing', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as typeof fetch
    await expect(synthesizeMinimax(cfg(), 'https://x', 'k', 'hi', fetchImpl)).rejects.toThrow(/no audio data/)
  })

  it('throws with the error message on non-2xx', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ message: 'bad voice' }), { status: 400 })) as typeof fetch
    await expect(synthesizeMinimax(cfg(), 'https://x', 'k', 'hi', fetchImpl)).rejects.toThrow(/bad voice/)
  })
})
