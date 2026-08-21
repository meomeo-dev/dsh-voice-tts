/**
 * Fish Audio TTS Provider:同一协议支持官方 Fish Audio 与 302AI 两个 vendor。
 * endpoint 与 API key 由注入的 `resolveEndpoint` 按每次操作解析,provider 不读取环境变量。
 * @module dsh-voice-tts/provider-fish
 */

import type {
  FishConfig,
  ResolvedEndpoint,
  TtsChunk,
  TtsProvider,
  TtsRequest,
  TtsResult,
  TtsVoice,
  TtsVoiceInfo,
  TtsVoiceListOptions,
  TtsVoicePage,
} from './types.js'
import {
  DEFAULT_FISH_MODEL,
  DEFAULT_FISH_OFFICIAL_VENDOR,
  FISH_CONFIG_TEMPLATE,
  FISH_DEFAULT_VOICES,
  getFishVoiceInfo,
  listFishVoices,
  streamFish,
  synthesizeFish,
} from './fish.js'

function formatOf(value: unknown, fallback: FishConfig['format']): FishConfig['format'] {
  return value === 'mp3' || value === 'wav' || value === 'pcm' || value === 'opus' ? value : fallback
}

function latencyOf(value: unknown): FishConfig['latency'] {
  return value === 'low' || value === 'balanced' || value === 'normal' ? value : 'normal'
}

function mp3BitrateOf(value: unknown): FishConfig['mp3_bitrate'] {
  return value === 64 || value === 192 ? value : 128
}

function opusBitrateOf(value: unknown): FishConfig['opus_bitrate'] {
  return value === 24000 || value === 32000 || value === 48000 || value === 64000 ? value : -1000
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function booleanOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 把宽松的命令/请求配置归一为 Fish Audio 配置。 */
function resolveConfig(config: Record<string, unknown>): FishConfig {
  return {
    vendor: typeof config.vendor === 'string' && config.vendor.length > 0 ? config.vendor : DEFAULT_FISH_OFFICIAL_VENDOR,
    model: typeof config.model === 'string' && config.model.length > 0 ? config.model : DEFAULT_FISH_MODEL,
    voice_type: typeof config.voice_type === 'string' ? config.voice_type : '',
    format: formatOf(config.format, 'mp3'),
    play_format: formatOf(config.play_format, 'wav'),
    sample_rate: numberOf(config.sample_rate, 44100),
    mp3_bitrate: mp3BitrateOf(config.mp3_bitrate),
    opus_bitrate: opusBitrateOf(config.opus_bitrate),
    speed: numberOf(config.speed, 1),
    volume: numberOf(config.volume, 0),
    normalize: booleanOf(config.normalize, true),
    normalize_loudness: booleanOf(config.normalize_loudness, true),
    latency: latencyOf(config.latency),
    chunk_length: numberOf(config.chunk_length, 200),
    temperature: numberOf(config.temperature, 0.7),
    top_p: numberOf(config.top_p, 0.7),
    max_new_tokens: numberOf(config.max_new_tokens, 1024),
    repetition_penalty: numberOf(config.repetition_penalty, 1.2),
    min_chunk_length: numberOf(config.min_chunk_length, 50),
    condition_on_previous_chunks: booleanOf(config.condition_on_previous_chunks, true),
    early_stop_threshold: numberOf(config.early_stop_threshold, 1),
    bilingual: 'both',
    segment_strategy: 'sentence',
    segment_threshold: 5,
    segment_separators: '',
    voices: {},
    voice_profiles: {},
  }
}

/** 展示窗口大小(合并默认音色后):与远端 page_size 对齐的规范值。 */
function pageSizeOf(options: TtsVoiceListOptions | undefined): number {
  return Math.min(100, Math.max(1, Math.trunc(options?.pageSize ?? 100)))
}

/** Fish Audio provider。`vendor` 决定官方或 302AI endpoint,配置字段保持协议一致。 */
export class FishTtsProvider implements TtsProvider {
  readonly id = 'fish-audio'
  readonly configTemplate = FISH_CONFIG_TEMPLATE

  private readonly resolveEndpoint: (vendorId: string) => Promise<ResolvedEndpoint>

  /**
   * @param resolveEndpoint - 每次合成或目录查询按 vendor id 解析 endpoint 与 API key。
   */
  constructor(resolveEndpoint: (vendorId: string) => Promise<ResolvedEndpoint>) {
    this.resolveEndpoint = resolveEndpoint
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    const config = resolveConfig(request.config)
    const endpoint = await this.resolveEndpoint(config.vendor)
    return synthesizeFish(config, endpoint.baseUrl, endpoint.apiKey, request.text, endpoint.kind)
  }

  async *streamSynthesize(request: TtsRequest): AsyncIterable<TtsChunk> {
    const config = resolveConfig(request.config)
    const endpoint = await this.resolveEndpoint(config.vendor)
    yield * streamFish(config, endpoint.baseUrl, endpoint.apiKey, request.text, endpoint.kind)
  }

  listVoices(): readonly TtsVoice[] {
    return FISH_DEFAULT_VOICES
  }

  async listVoicePage(configInput: Record<string, unknown>, options?: TtsVoiceListOptions): Promise<TtsVoicePage> {
    const config = resolveConfig(configInput)
    const endpoint = await this.resolveEndpoint(config.vendor)
    const pageSize = pageSizeOf(options)
    const pageNumber = Math.max(1, Math.trunc(options?.pageNumber ?? 1))
    // 官方页 1 并入默认音色:远端窗口收窄为 pageSize-1,使跨页无缝隙、total 页无关。
    const remotePageSize = endpoint.kind === 'official' ? Math.max(1, pageSize - FISH_DEFAULT_VOICES.length) : pageSize
    const page = await listFishVoices(endpoint.baseUrl, endpoint.apiKey, { ...options, pageSize: remotePageSize })
    if (endpoint.kind !== 'official') return { ...page, pageSize }
    const total = page.total + FISH_DEFAULT_VOICES.length
    if (pageNumber === 1) {
      return {
        ...page,
        voices: [...FISH_DEFAULT_VOICES, ...page.voices].slice(0, pageSize),
        total,
        pageSize,
        hasMore: page.hasMore || page.voices.length + FISH_DEFAULT_VOICES.length > pageSize,
      }
    }
    return { ...page, total, pageSize }
  }

  async getVoiceInfo(configInput: Record<string, unknown>, voiceId: string): Promise<TtsVoiceInfo> {
    const config = resolveConfig(configInput)
    const endpoint = await this.resolveEndpoint(config.vendor)
    return getFishVoiceInfo(endpoint.baseUrl, endpoint.apiKey, voiceId)
  }
}
