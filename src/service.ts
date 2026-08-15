/**
 * Service Definition:`ctx.tts` 注册表,承载 provider 的注册与转发。
 * @module dsh-voice-tts/service
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { TtsProvider, TtsRequest, TtsResult, TtsVoice } from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tts: TtsService
  }
}

/**
 * TTS 注册表。Provider 通过 {@link registerProvider} 挂进本服务,Consumer 通过
 * {@link provider} 取用某个 provider,再由它合成或查音色。一个 provider id 只注册一次。
 */
export class TtsService extends Service {
  private readonly providers = new Map<string, TtsProvider>()

  constructor(ctx: Context) {
    super(ctx, 'tts')
  }

  /**
   * 注册一个 provider 实现。重复 id 抛错(与 cordis 重复服务一致)。
   * @param provider - provider 实现。
   * @returns 注销该 provider 的 disposer。
   */
  registerProvider(provider: TtsProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new Error(`TTS provider "${provider.id}" is already registered`)
    }
    this.providers.set(provider.id, provider)
    return () => {
      this.providers.delete(provider.id)
    }
  }

  /** 按 id 取 provider,未知 id 返回 `undefined`。 */
  provider(id: string): TtsProvider | undefined {
    return this.providers.get(id)
  }

  /** 列出已注册 provider 的 id。 */
  listProviders(): readonly string[] {
    return [...this.providers.keys()]
  }

  /**
   * 委托某 provider 合成文本。
   * @param providerId - 目标 provider id。
   * @param request - 合成请求。
   * @returns 合成结果;未知 provider 拒绝。
   */
  synthesize(providerId: string, request: TtsRequest): Promise<TtsResult> {
    const provider = this.providers.get(providerId)
    if (provider === undefined) {
      return Promise.reject(new Error(`unknown TTS provider "${providerId}"`))
    }
    return provider.synthesize(request)
  }

  /** 列出某 provider 的音色;未知 provider 返回空表。 */
  listVoices(providerId: string): readonly TtsVoice[] {
    return this.providers.get(providerId)?.listVoices() ?? []
  }
}
