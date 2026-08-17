import { describe, expect, it } from 'vitest'
import { buildOpenaiRequest, OPENAI_API_PATH, synthesizeOpenai } from '../src/openai.ts'
import type { OpenaiConfig } from '../src/types.ts'

function cfg(over: Partial<OpenaiConfig> = {}): OpenaiConfig {
  return {
    vendor: 'v1',
    model: 'tts-1',
    voice_type: 'alloy',
    instructions: '',
    format: 'mp3',
    play_format: 'mp3',
    speed: 1,
    bilingual: 'both',
    voices: {},
    voice_profiles: {},
    ...over,
  }
}

describe('buildOpenaiRequest', () => {
  it('builds the standard body', () => {
    const { headers, body } = buildOpenaiRequest(cfg(), 'sk-test', 'hello')
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(body)).toEqual({
      model: 'tts-1', input: 'hello', voice: 'alloy', response_format: 'mp3', speed: 1,
    })
  })

  it('omits instructions when empty, includes when set', () => {
    expect(JSON.parse(buildOpenaiRequest(cfg(), 'k', 'x').body)).not.toHaveProperty('instructions')
    expect(JSON.parse(buildOpenaiRequest(cfg({ instructions: 'speak slowly' }), 'k', 'x').body).instructions).toBe('speak slowly')
  })
})

describe('synthesizeOpenai', () => {
  it('POSTs to baseUrl + /audio/speech and returns binary audio', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    }) as typeof fetch
    const result = await synthesizeOpenai(cfg(), 'https://api.302.ai/v1', 'sk-test', 'hi', fetchImpl)
    expect(calls[0]!.url).toBe(`https://api.302.ai/v1${OPENAI_API_PATH}`)
    expect(result.format).toBe('mp3')
    expect([...result.audio]).toEqual([1, 2, 3])
  })

  it('throws with the error message on non-2xx', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'bad model' } }), { status: 400 })) as typeof fetch
    await expect(synthesizeOpenai(cfg(), 'https://x/v1', 'k', 'hi', fetchImpl)).rejects.toThrow(/bad model/)
  })
})
