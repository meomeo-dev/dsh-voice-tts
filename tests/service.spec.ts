import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TtsService } from '../src/service.js'
import type { TtsProvider } from '../src/types.js'

const fakeProvider: TtsProvider = {
  id: 'fake',
  configTemplate: { provider: 'fake', config: {}, credentials: { apiKeyRef: 'X' } },
  synthesize: async () => ({ audio: new Uint8Array([1, 2, 3]), format: 'mp3', textWords: 3 }),
  listVoices: () => [],
}

describe('TtsService', () => {
  it('registers a provider, delegates synthesis, and disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(TtsService)
    const tts = ctx.tts

    const dispose = tts.registerProvider(fakeProvider)
    expect(tts.listProviders()).toEqual(['fake'])

    const result = await tts.synthesize('fake', { text: 'x', config: {} })
    expect(result.textWords).toBe(3)

    dispose()
    expect(tts.listProviders()).toEqual([])
  })

  it('rejects a duplicate provider id', async () => {
    const ctx = new Context()
    await ctx.plugin(TtsService)
    ctx.tts.registerProvider(fakeProvider)
    expect(() => ctx.tts.registerProvider(fakeProvider)).toThrow('already registered')
  })

  it('returns undefined for an unknown provider and rejects its synthesis', async () => {
    const ctx = new Context()
    await ctx.plugin(TtsService)
    expect(ctx.tts.provider('nope')).toBeUndefined()
    await expect(ctx.tts.synthesize('nope', { text: 'x', config: {} })).rejects.toThrow('unknown TTS provider "nope"')
  })

  it('returns an empty voice list for an unknown provider', async () => {
    const ctx = new Context()
    await ctx.plugin(TtsService)
    expect(ctx.tts.listVoices('nope')).toEqual([])
  })
})
