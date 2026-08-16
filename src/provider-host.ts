/**
 * host TTS Provider:实现 {@link TtsProvider},调本机命令行(默认 macOS `say`)合成。
 * 与云 provider 的差异:无鉴权、无 HTTP,合成走 `spawn` + stdin;音频恒为 AIFF。
 * @module dsh-voice-tts/provider-host
 */

import type { TtsChunk, TtsProvider, TtsRequest, TtsResult, TtsVoice } from './types.js'
import {
  HOST_CONFIG_TEMPLATE,
  listSayVoices,
  resolveHostConfig,
  synthesizeSay,
} from './host.js'

/**
 * host TTS provider。本地命令行合成,无 API key;`say` 不流式,
 * `streamSynthesize` 退化为「合成一次、单分片」。
 */
export class HostTtsProvider implements TtsProvider {
  readonly id = 'host'
  readonly configTemplate = HOST_CONFIG_TEMPLATE

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    return synthesizeSay(resolveHostConfig(request.config), request.text)
  }

  async *streamSynthesize(request: TtsRequest): AsyncIterable<TtsChunk> {
    const result = await synthesizeSay(resolveHostConfig(request.config), request.text)
    yield { audio: result.audio }
  }

  listVoices(): readonly TtsVoice[] {
    return listSayVoices()
  }
}
