import { describe, expect, it, vi } from 'vitest'
import {
  buildVolcengineRequest,
  parseVolcengineStream,
  streamVolcengine,
  synthesizeVolcengine,
  VOLCENGINE_API_URL,
} from '../src/volcengine.js'
import type { VolcengineConfig } from '../src/types.js'

const config: VolcengineConfig = {
  voice_type: 'zh_female_vv_uranus_bigtts',
  resource_id: 'seed-tts-2.0',
  model: '',
  format: 'mp3',
  play_format: 'wav',
  sample_rate: 24000,
  speech_rate: 0,
  loudness_rate: 0,
  pitch: 0,
  bilingual: 'both',
  voices: {},
}

describe('buildVolcengineRequest', () => {
  it('sets the three required headers and encodes the body', () => {
    const { headers, body } = buildVolcengineRequest(config, 'key-123', '你好')
    expect(headers['X-Api-Key']).toBe('key-123')
    expect(headers['X-Api-Resource-Id']).toBe('seed-tts-2.0')
    expect(headers['X-Api-Request-Id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(headers['Content-Type']).toBe('application/json')

    const parsed = JSON.parse(body) as { req_params: Record<string, unknown>; post_process: { pitch: number } }
    expect(parsed.req_params.text).toBe('你好')
    expect(parsed.req_params.speaker).toBe('zh_female_vv_uranus_bigtts')
    expect(parsed.post_process).toEqual({ pitch: 0 })
    expect(parsed.req_params.audio_params).toMatchObject({
      format: 'mp3', sample_rate: 24000, speech_rate: 0, loudness_rate: 0,
    })
    // Standard path omits model (API default applies).
    expect(parsed.req_params).not.toHaveProperty('model')
  })

  it('includes model only when explicitly set', () => {
    const withModel = { ...config, model: 'seed-tts-1.1' }
    const { body } = buildVolcengineRequest(withModel, 'key', 'x')
    expect((JSON.parse(body) as { req_params: Record<string, unknown> }).req_params.model).toBe('seed-tts-1.1')
  })
})

describe('parseVolcengineStream', () => {
  const b64 = (s: string): string => Buffer.from(s).toString('base64')

  it('concatenates multiple NDJSON chunks and reads usage from the last line', () => {
    const text = [
      JSON.stringify({ code: 0, message: '', data: b64('hello ') }),
      JSON.stringify({ code: 0, message: '', data: b64('audio'), usage: { text_words: 7 } }),
    ].join('\n')
    const result = parseVolcengineStream(text, 'mp3')
    expect(result.format).toBe('mp3')
    expect(result.textWords).toBe(7)
    expect(Buffer.from(result.audio).toString('utf8')).toBe('hello audio')
  })

  it('treats the 20000000 success summary as success and reads its usage', () => {
    const text = [
      JSON.stringify({ code: 0, message: '', data: b64('hi') }),
      JSON.stringify({ code: 20000000, message: 'OK', data: null, usage: { text_words: 2 } }),
    ].join('\n')
    const result = parseVolcengineStream(text, 'mp3')
    expect(Buffer.from(result.audio).toString('utf8')).toBe('hi')
    expect(result.textWords).toBe(2)
  })

  it('throws on a non-zero code line with the message', () => {
    expect(() => parseVolcengineStream(JSON.stringify({ code: 400, message: 'bad request' }), 'mp3'))
      .toThrow('volcengine TTS failed (code 400): bad request')
  })

  it('throws on a malformed line', () => {
    expect(() => parseVolcengineStream('not json', 'mp3'))
      .toThrow('malformed JSON')
  })

  it('throws when the stream carries no audio data', () => {
    expect(() => parseVolcengineStream(JSON.stringify({ code: 0, message: '' }), 'mp3'))
      .toThrow('no audio data')
  })
})

describe('synthesizeVolcengine', () => {
  it('posts and parses a successful response', async () => {
    const audio = 'AUDIO'
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, message: '', data: Buffer.from(audio).toString('base64'), usage: { text_words: 4 } }),
    })) as unknown as typeof fetch

    const result = await synthesizeVolcengine(config, 'key', 'hello', fetchImpl)

    expect(fetchImpl).toHaveBeenCalledWith(VOLCENGINE_API_URL, expect.objectContaining({ method: 'POST' }))
    expect(Buffer.from(result.audio).toString('utf8')).toBe(audio)
    expect(result.textWords).toBe(4)
  })

  it('throws on a non-ok HTTP status', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom',
    })) as unknown as typeof fetch
    await expect(synthesizeVolcengine(config, 'key', 'x', fetchImpl)).rejects.toThrow('HTTP 500')
  })
})

describe('streamVolcengine', () => {
  const b64 = (s: string): string => Buffer.from(s).toString('base64')

  function chunkedBody(lines: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    const encoded = lines.map(line => encoder.encode(line + '\n'))
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of encoded) controller.enqueue(part)
        controller.close()
      },
    })
  }

  it('yields one chunk per audio line, skipping the success summary', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: chunkedBody([
        JSON.stringify({ code: 0, message: '', data: b64('A') }),
        JSON.stringify({ code: 0, message: '', data: b64('B') }),
        JSON.stringify({ code: 20000000, message: 'OK', data: null, usage: { text_words: 3 } }),
      ]),
    })) as unknown as typeof fetch

    const chunks: string[] = []
    for await (const chunk of streamVolcengine(config, 'key', 'hi', fetchImpl)) {
      chunks.push(Buffer.from(chunk.audio).toString('utf8'))
    }
    expect(chunks).toEqual(['A', 'B'])
  })

  it('throws on a non-zero code line', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: chunkedBody([JSON.stringify({ code: 500, message: 'oops' })]),
    })) as unknown as typeof fetch

    const chunks: string[] = []
    await expect(async () => {
      for await (const chunk of streamVolcengine(config, 'key', 'x', fetchImpl)) {
        chunks.push(Buffer.from(chunk.audio).toString('utf8'))
      }
    }).rejects.toThrow('code 500')
  })
})
