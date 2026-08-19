import { describe, expect, it, vi } from 'vitest'
import {
  buildFishRequest,
  FISH_DEFAULT_VOICES,
  FISH_MODEL_PATH,
  FISH_TTS_PATH,
  getFishVoiceInfo,
  listFishVoices,
  streamFish,
  synthesizeFish,
} from '../src/fish.ts'
import { FishTtsProvider } from '../src/provider-fish.ts'
import type { FishConfig, ResolvedEndpoint, TtsChunk } from '../src/types.ts'

function cfg(over: Partial<FishConfig> = {}): FishConfig {
  return {
    vendor: 'fish-audio-official',
    model: 's2.1-pro',
    voice_type: 'voice-1',
    format: 'mp3',
    play_format: 'wav',
    sample_rate: 44100,
    mp3_bitrate: 128,
    opus_bitrate: -1000,
    speed: 1,
    volume: 0,
    normalize: true,
    normalize_loudness: true,
    latency: 'normal',
    chunk_length: 200,
    temperature: 0.7,
    top_p: 0.7,
    max_new_tokens: 1024,
    repetition_penalty: 1.2,
    min_chunk_length: 50,
    condition_on_previous_chunks: true,
    early_stop_threshold: 1,
    bilingual: 'both',
    voices: {},
    voice_profiles: {},
    ...over,
  }
}

function responseStream(chunks: readonly number[][]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

async function collect(gen: AsyncIterable<TtsChunk>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  for await (const chunk of gen) out.push(chunk.audio)
  return out
}

describe('buildFishRequest', () => {
  it('builds the official request and omits an empty reference id', () => {
    const request = buildFishRequest(cfg({ voice_type: '', speed: 1.25, volume: -2 }), 'sk-test', 'hello', 'https://api.fish.audio', 'official')
    expect(request.url).toBe(`https://api.fish.audio${FISH_TTS_PATH}`)
    expect(request.headers).toEqual({
      Authorization: 'Bearer sk-test',
      'Content-Type': 'application/json',
      model: 's2.1-pro',
    })
    const body = JSON.parse(request.body) as Record<string, unknown>
    expect(body).not.toHaveProperty('reference_id')
    expect(body.prosody).toEqual({ speed: 1.25, volume: -2, normalize_loudness: true })
    expect(body.format).toBe('mp3')
  })

  it('uses 302AI response_format=data and sends reference_id', () => {
    const request = buildFishRequest(cfg({ vendor: '302ai-fish-audio', model: 's1' }), 'sk-302', '你好', 'https://api.302.ai/fish-audio', 'reseller')
    expect(request.url).toBe(`https://api.302.ai/fish-audio${FISH_TTS_PATH}?response_format=data`)
    const body = JSON.parse(request.body) as Record<string, unknown>
    expect(body).toHaveProperty('reference_id', 'voice-1')
    expect(body).not.toHaveProperty('prosody')
    expect(body).not.toHaveProperty('sample_rate')
  })

  it('keeps the reseller subset behavior driven by vendor kind, not the base URL', () => {
    const request = buildFishRequest(cfg(), 'sk-test', 'hi', 'https://proxy.example.com/fish-audio', 'reseller')
    expect(request.url).toBe('https://proxy.example.com/fish-audio/v1/tts?response_format=data')
    const body = JSON.parse(request.body) as Record<string, unknown>
    expect(body).not.toHaveProperty('prosody')
    expect(body).not.toHaveProperty('temperature')
  })
})

describe('synthesizeFish', () => {
  it('returns binary audio and rejects redirect following', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return new Response(Uint8Array.from([1, 2, 3]), { status: 200 })
    }) as typeof fetch
    const result = await synthesizeFish(cfg(), 'https://api.fish.audio', 'sk-test', 'hi', 'official', fetchImpl)
    expect([...result.audio]).toEqual([1, 2, 3])
    expect(result.format).toBe('mp3')
    expect(calls[0]!.init.redirect).toBe('error')
  })

  it('reads 302AI raw data response', async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      expect(String(url)).toContain('response_format=data')
      return new Response(Uint8Array.from([9, 8]), { status: 200 })
    }) as typeof fetch
    const result = await synthesizeFish(cfg({ vendor: '302ai-fish-audio', model: 's1' }), 'https://api.302.ai/fish-audio', 'sk-test', 'hi', 'reseller', fetchImpl)
    expect([...result.audio]).toEqual([9, 8])
  })

  it('fails before calling 302AI without a reference model', async () => {
    const fetchImpl = (async () => { throw new Error('network must not be called') }) as typeof fetch
    await expect(synthesizeFish(cfg({ vendor: '302ai-fish-audio', voice_type: '' }), 'https://api.302.ai/fish-audio', 'sk-test', 'hi', 'reseller', fetchImpl)).rejects.toThrow(/requires a voice model id/)
  })

  it('includes provider error messages', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ status: 400, message: 'bad reference', reason: 'not trained' }), { status: 400 })) as typeof fetch
    await expect(synthesizeFish(cfg(), 'https://api.fish.audio', 'sk-test', 'hi', 'official', fetchImpl)).rejects.toThrow('bad reference (not trained)')
  })
})

describe('streamFish', () => {
  it('yields raw response chunks without parsing text', async () => {
    const fetchImpl = (async () => responseStream([[1, 2], [3]])) as typeof fetch
    expect(await collect(streamFish(cfg(), 'https://api.fish.audio', 'sk-test', 'hi', 'official', fetchImpl))).toEqual([
      Uint8Array.from([1, 2]),
      Uint8Array.from([3]),
    ])
  })
})

describe('Fish voice directory', () => {
  it('lists only TTS models and maps the model summary', async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url))
      expect(parsed.pathname).toBe(FISH_MODEL_PATH)
      expect(parsed.searchParams.get('page_size')).toBe('20')
      expect(parsed.searchParams.get('page_number')).toBe('2')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
      expect(init?.redirect).toBe('error')
      return new Response(JSON.stringify({
        total: 21,
        has_more: false,
        items: [
          { _id: 'voice-1', type: 'tts', title: 'Alice', description: 'narration', languages: ['en'], tags: ['warm'], state: 'trained', train_mode: 'fast' },
          { _id: 'service-1', type: 'svc', title: 'not a voice' },
        ],
      }), { status: 200 })
    }) as typeof fetch
    const page = await listFishVoices('https://api.fish.audio', 'sk-test', { pageSize: 20, pageNumber: 2 }, fetchImpl)
    expect(page).toMatchObject({ total: 21, pageSize: 20, pageNumber: 2, hasMore: false })
    expect(page.voices).toEqual([expect.objectContaining({ voice_type: 'voice-1', name: 'Alice', lang: 'en', group: 'remote' })])
  })

  it('gets a voice detail with an encoded id and preserves raw metadata', async () => {
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`https://api.302.ai/fish-audio${FISH_MODEL_PATH}/a%2Fb`)
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
      expect(init?.redirect).toBe('error')
      return new Response(JSON.stringify({ _id: 'a/b', type: 'tts', title: 'Voice', languages: ['zh'], state: 'trained' }), { status: 200 })
    }) as typeof fetch
    const info = await getFishVoiceInfo('https://api.302.ai/fish-audio', 'sk-test', 'a/b', fetchImpl)
    expect(info.id).toBe('a/b')
    expect(info.voice.name).toBe('Voice')
    expect(info.metadata).toHaveProperty('_id', 'a/b')
  })

  it('rejects malformed list responses', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ items: 'nope' }), { status: 200 })) as typeof fetch
    await expect(listFishVoices('https://api.fish.audio', 'sk-test', {}, fetchImpl)).rejects.toThrow('malformed JSON')
  })
})

describe('FishTtsProvider', () => {
  it('resolves the selected vendor for remote directory calls', async () => {
    const resolveEndpoint = vi.fn(async (vendorId: string): Promise<ResolvedEndpoint> => {
      expect(vendorId).toBe('302ai-fish-audio')
      return { baseUrl: 'https://api.302.ai/fish-audio', apiKey: 'sk-test', kind: 'reseller' }
    })
    vi.stubGlobal('fetch', (async () => new Response(JSON.stringify({ total: 1, items: [{ _id: 'v1', type: 'tts', title: 'Voice' }] }), { status: 200 })) as typeof fetch)
    try {
      const provider = new FishTtsProvider(resolveEndpoint)
      const page = await provider.listVoicePage({ vendor: '302ai-fish-audio' }, { pageSize: 1 })
      expect(page.voices[0]?.voice_type).toBe('v1')
      expect(resolveEndpoint).toHaveBeenCalledWith('302ai-fish-audio')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('merges the default voice on official page 1 with a gapless, page-invariant window', async () => {
    const remoteItems = Array.from({ length: 99 }, (_, i) => ({ _id: `voice-${i}`, type: 'tts', title: `Voice ${i}` }))
    const seenPageSizes: string[] = []
    const resolveEndpoint = vi.fn(async (): Promise<ResolvedEndpoint> => ({ baseUrl: 'https://api.fish.audio', apiKey: 'sk-test', kind: 'official' }))
    vi.stubGlobal('fetch', (async (url: string | URL | Request) => {
      const parsed = new URL(String(url))
      seenPageSizes.push(parsed.searchParams.get('page_size') ?? '')
      return new Response(JSON.stringify({ total: 199, has_more: true, items: remoteItems }), { status: 200 })
    }) as typeof fetch)
    try {
      const provider = new FishTtsProvider(resolveEndpoint)
      const page = await provider.listVoicePage({ vendor: 'fish-audio-official' }, { pageSize: 100 })
      expect(seenPageSizes).toEqual(['99'])
      expect(page.voices).toHaveLength(100)
      expect(page.voices[0]!.voice_type).toBe('')
      expect(page.voices[1]!.voice_type).toBe('voice-0')
      expect(page.voices[99]!.voice_type).toBe('voice-98')
      expect(page.total).toBe(200)
      expect(page.pageSize).toBe(100)
      expect(page.hasMore).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps total page-invariant on official later pages without merging the default voice', async () => {
    const remoteItems = Array.from({ length: 99 }, (_, i) => ({ _id: `voice-${i + 99}`, type: 'tts', title: `Voice ${i + 99}` }))
    const seenPageSizes: string[] = []
    const resolveEndpoint = vi.fn(async (): Promise<ResolvedEndpoint> => ({ baseUrl: 'https://api.fish.audio', apiKey: 'sk-test', kind: 'official' }))
    vi.stubGlobal('fetch', (async (url: string | URL | Request) => {
      const parsed = new URL(String(url))
      seenPageSizes.push(parsed.searchParams.get('page_size') ?? '')
      return new Response(JSON.stringify({ total: 199, has_more: true, items: remoteItems }), { status: 200 })
    }) as typeof fetch)
    try {
      const provider = new FishTtsProvider(resolveEndpoint)
      const page = await provider.listVoicePage({ vendor: 'fish-audio-official' }, { pageSize: 100, pageNumber: 2 })
      expect(seenPageSizes).toEqual(['99'])
      expect(page.voices).toHaveLength(99)
      expect(page.voices[0]!.voice_type).toBe('voice-99')
      expect(page.total).toBe(200)
      expect(page.hasMore).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('passes the vendor kind into synthesis', async () => {
    const resolveEndpoint = vi.fn(async (): Promise<ResolvedEndpoint> => ({ baseUrl: 'https://api.302.ai/fish-audio', apiKey: 'sk-test', kind: 'reseller' }))
    const fetchImpl = (async (url: string | URL | Request) => {
      expect(String(url)).toContain('response_format=data')
      return new Response(Uint8Array.from([1]), { status: 200 })
    }) as typeof fetch
    vi.stubGlobal('fetch', fetchImpl)
    try {
      const provider = new FishTtsProvider(resolveEndpoint)
      const result = await provider.synthesize({ text: 'hi', config: { vendor: '302ai-fish-audio', voice_type: 'v1' } })
      expect([...result.audio]).toEqual([1])
      expect(FISH_DEFAULT_VOICES[0]!.voice_type).toBe('')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
