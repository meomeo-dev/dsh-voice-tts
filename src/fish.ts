/**
 * Fish Audio TTS 纯逻辑:请求构造、二进制响应、声音目录与声音详情。
 * 官方 endpoint 使用 `https://api.fish.audio`;302AI 只替换 endpoint 前缀为
 * `https://api.302.ai/fish-audio`,请求字段与 Fish API 保持一致。
 * @module dsh-voice-tts/fish
 */

import type {
  ConfigTemplate,
  FishConfig,
  TtsChunk,
  TtsVoice,
  TtsVoiceInfo,
  TtsVoiceListOptions,
  TtsVoicePage,
  TtsResult,
  TunableParam,
  VendorKind,
} from './types.js'

/** Fish Audio TTS 路径。 */
export const FISH_TTS_PATH = '/v1/tts'
/** Fish Audio 声音模型列表路径。 */
export const FISH_MODEL_PATH = '/model'

/** 官方 Fish Audio vendor id。 */
export const DEFAULT_FISH_OFFICIAL_VENDOR = 'fish-audio-official'
/** 302AI Fish Audio vendor id。 */
export const DEFAULT_FISH_302_VENDOR = '302ai-fish-audio'
/** 官方默认模型。 */
export const DEFAULT_FISH_MODEL = 's2.1-pro'
/** 302AI 文档推荐模型。 */
export const DEFAULT_FISH_302_MODEL = 's1'
/** 官方可用模型。 */
export const FISH_OFFICIAL_MODELS: readonly string[] = ['s1', 's2-pro', 's2.1-pro', 's2.1-pro-free']
/** 302AI 文档声明可用模型。 */
export const FISH_302_MODELS: readonly string[] = ['speech-1.5', 'speech-1.6', 's1']

/** Fish Audio 的默认内置音色:不带 `reference_id` 时使用。 */
export const FISH_DEFAULT_VOICES: readonly TtsVoice[] = [
  {
    voice_type: '',
    name: 'Fish Audio 默认音色',
    scene: '官方默认音色',
    lang: '自动检测（官方模型支持多语种）',
    ability: '无需 reference_id',
    group: 'standard',
  },
]

/** Fish Audio 槽位可调参数。 */
export const FISH_TUNABLE_PARAMS: readonly TunableParam[] = [
  { key: 'speed', label: '语速', min: 0.5, max: 2, step: 0.05 },
]

/** Fish Audio provider 的完整配置模板。 */
export const FISH_CONFIG_TEMPLATE: ConfigTemplate = {
  provider: 'fish-audio',
  config: {
    vendor: {
      type: 'string', required: true, default: DEFAULT_FISH_OFFICIAL_VENDOR,
      description: 'vendors 注册表里的 Fish Audio endpoint:官方或 302AI',
    },
    model: {
      type: 'string', required: true, default: DEFAULT_FISH_MODEL,
      description: '模型请求头:官方 s1/s2-pro/s2.1-pro/s2.1-pro-free;302AI speech-1.5/speech-1.6/s1',
    },
    voice_type: {
      type: 'string', required: false, default: '',
      description: 'reference_id;官方留空使用内置默认音色,也可填写声音模型 ID;302AI 必须填写声音模型 ID',
    },
    format: {
      type: 'string', required: false, default: 'mp3', enum: ['mp3', 'wav', 'pcm', 'opus'],
      description: '输出音频格式',
    },
    play_format: {
      type: 'string', required: false, default: 'wav', enum: ['mp3', 'wav', 'pcm', 'opus'],
      description: 'host_play 的输出音频格式',
    },
    sample_rate: {
      type: 'number', required: false, default: 44100,
      description: '采样率 Hz;按输出格式选择 API 支持的采样率',
    },
    mp3_bitrate: {
      type: 'number', required: false, default: 128, enum: [64, 128, 192],
      description: 'MP3 码率 kbps',
    },
    opus_bitrate: {
      type: 'number', required: false, default: -1000, enum: [-1000, 24000, 32000, 48000, 64000],
      description: 'Opus 码率 bps;-1000 为自动',
    },
    speed: {
      type: 'number', required: false, default: 1,
      description: '语速 [0.5, 2.0]',
    },
    volume: {
      type: 'number', required: false, default: 0,
      description: 'prosody 音量调整(dB);Fish API 未声明固定上下界',
    },
    normalize: {
      type: 'boolean', required: false, default: true,
      description: '是否规范化英文/中文数字文本',
    },
    normalize_loudness: {
      type: 'boolean', required: false, default: true,
      description: '是否规范化输出响度(S2 系列生效)',
    },
    latency: {
      type: 'string', required: false, default: 'normal', enum: ['low', 'normal', 'balanced'],
      description: '延迟/质量策略',
    },
    chunk_length: {
      type: 'number', required: false, default: 200,
      description: '文本分块长度 [100, 300]',
    },
    temperature: {
      type: 'number', required: false, default: 0.7,
      description: '采样温度 [0, 1]',
    },
    top_p: {
      type: 'number', required: false, default: 0.7,
      description: 'nucleus sampling [0, 1]',
    },
    max_new_tokens: {
      type: 'number', required: false, default: 1024,
      description: '每个文本分块的最大音频 token 数',
    },
    repetition_penalty: {
      type: 'number', required: false, default: 1.2,
      description: '重复惩罚系数',
    },
    min_chunk_length: {
      type: 'number', required: false, default: 50,
      description: '新分块的最小字符数 [0, 100]',
    },
    condition_on_previous_chunks: {
      type: 'boolean', required: false, default: true,
      description: '是否把前一分块作为上下文',
    },
    early_stop_threshold: {
      type: 'number', required: false, default: 1,
      description: '批处理提前停止阈值 [0, 1]',
    },
    bilingual: {
      type: 'string', required: false, default: 'both', enum: ['both', 'english_only', 'chinese_only'],
      description: '双语播报过滤',
    },
    voices: {
      type: 'object', required: false, default: null,
      description: '各语言类别槽位 { zh, en, mixed },每槽 { voice_type, speed? }',
    },
    voice_profiles: {
      type: 'object', required: false, default: null,
      description: '按 dsh-voice id 映射的音色槽位',
    },
  },
  credentials: { apiKeyRef: '' },
}

/** Fish Audio API 返回的声音模型分页。 */
interface FishModelPagePayload {
  readonly total?: unknown
  readonly items?: unknown
  readonly has_more?: unknown
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function stringArrayOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function firstSampleAudioOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  for (const item of value) {
    const sample = recordOf(item)
    const audio = stringOf(sample?.audio)
    if (audio.length > 0) return audio
  }
  return undefined
}

/** 把 Fish 模型实体映射为 dsh 音色摘要。 */
export function fishVoiceOf(value: unknown): TtsVoiceInfo | undefined {
  const raw = recordOf(value)
  const id = stringOf(raw?._id)
  if (raw === undefined || id.length === 0) return undefined
  const title = stringOf(raw.title, id)
  const description = stringOf(raw.description, 'Fish Audio 声音模型')
  const languages = stringArrayOf(raw.languages)
  const tags = stringArrayOf(raw.tags)
  const state = stringOf(raw.state)
  const trainMode = stringOf(raw.train_mode)
  const numberOf = (key: string): number | undefined => typeof raw[key] === 'number' ? raw[key] as number : undefined
  const audio = stringOf(raw.audio) || firstSampleAudioOf(raw.samples) || ''
  const voice: TtsVoice = {
    voice_type: id,
    name: title,
    scene: description,
    lang: languages.length > 0 ? languages.join('、') : '自动检测/多语种',
    ability: [state, trainMode].filter(part => part.length > 0).join(' / ') || 'Fish Audio TTS',
    ...(tags.length > 0 ? { tag: tags.join(',') } : {}),
    group: 'remote',
    ...(numberOf('like_count') !== undefined ? { likeCount: numberOf('like_count') } : {}),
    ...(numberOf('mark_count') !== undefined ? { markCount: numberOf('mark_count') } : {}),
    ...(numberOf('shared_count') !== undefined ? { sharedCount: numberOf('shared_count') } : {}),
    ...(numberOf('task_count') !== undefined ? { taskCount: numberOf('task_count') } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(languages.length > 0 ? { languages } : {}),
    ...(audio.length > 0 ? { audioUrl: audio } : {}),
  }
  return { id, voice, metadata: raw }
}

function isTtsModel(value: unknown): boolean {
  const raw = recordOf(value)
  return raw !== undefined && (raw.type === undefined || raw.type === 'tts')
}

function baseUrlOf(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '')
}

/** 构造 Fish TTS 请求;转售 vendor(302AI)通过 query `response_format=data` 返回原始音频。 */
export function buildFishRequest(
  config: FishConfig,
  apiKey: string,
  text: string,
  baseUrl: string,
  kind: VendorKind,
): { url: string; headers: Record<string, string>; body: string } {
  const reseller = kind === 'reseller'
  const url = new URL(`${baseUrlOf(baseUrl)}${FISH_TTS_PATH}`)
  if (reseller) url.searchParams.set('response_format', 'data')
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    model: config.model,
  }
  const payload: Record<string, unknown> = reseller
    ? {
        text,
        chunk_length: config.chunk_length,
        normalize: config.normalize,
        format: config.format,
        mp3_bitrate: config.mp3_bitrate,
        opus_bitrate: config.opus_bitrate,
        latency: config.latency,
      }
    : {
        text,
        chunk_length: config.chunk_length,
        normalize: config.normalize,
        format: config.format,
        sample_rate: config.sample_rate,
        mp3_bitrate: config.mp3_bitrate,
        opus_bitrate: config.opus_bitrate,
        latency: config.latency,
        prosody: {
          speed: config.speed,
          volume: config.volume,
          normalize_loudness: config.normalize_loudness,
        },
        temperature: config.temperature,
        top_p: config.top_p,
        max_new_tokens: config.max_new_tokens,
        repetition_penalty: config.repetition_penalty,
        min_chunk_length: config.min_chunk_length,
        condition_on_previous_chunks: config.condition_on_previous_chunks,
        early_stop_threshold: config.early_stop_threshold,
      }
  if (config.voice_type.length > 0) payload.reference_id = config.voice_type
  return { url: url.toString(), headers, body: JSON.stringify(payload) }
}

async function readError(response: Response): Promise<string> {
  const text = await response.text()
  try {
    const parsed = recordOf(JSON.parse(text))
    const message = parsed?.message
    if (typeof message === 'string') {
      const reason = typeof parsed?.reason === 'string' ? ` (${parsed.reason})` : ''
      return `${message}${reason}`
    }
    if (typeof parsed?.detail === 'string') return parsed.detail
    return JSON.stringify(parsed)
  } catch {
    return text.slice(0, 200)
  }
}

async function fishResponse(
  config: FishConfig,
  apiKey: string,
  text: string,
  baseUrl: string,
  kind: VendorKind,
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (kind === 'reseller' && config.voice_type.length === 0) {
    throw new Error('fish-audio 302AI requires a voice model id in voice_type/reference_id')
  }
  const request = buildFishRequest(config, apiKey, text, baseUrl, kind)
  const response = await fetchImpl(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`fish-audio TTS HTTP ${response.status}: ${await readError(response)}`)
  return response
}

/** 合成一段文本并读取完整二进制音频。 */
export async function synthesizeFish(
  config: FishConfig,
  baseUrl: string,
  apiKey: string,
  text: string,
  kind: VendorKind,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TtsResult> {
  const response = await fishResponse(config, apiKey, text, baseUrl, kind, fetchImpl)
  return { audio: new Uint8Array(await response.arrayBuffer()), format: config.format, textWords: 0 }
}

/** 读取 Fish 的分块二进制音频;没有 reader 时退化为单分片。 */
export async function* streamFish(
  config: FishConfig,
  baseUrl: string,
  apiKey: string,
  text: string,
  kind: VendorKind,
  fetchImpl: typeof fetch = globalThis.fetch,
): AsyncIterable<TtsChunk> {
  const response = await fishResponse(config, apiKey, text, baseUrl, kind, fetchImpl)
  const reader = response.body?.getReader()
  if (reader === undefined) {
    yield { audio: new Uint8Array(await response.arrayBuffer()) }
    return
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value !== undefined && value.byteLength > 0) yield { audio: value }
  }
}

function queryUrl(baseUrl: string, options: TtsVoiceListOptions): string {
  const url = new URL(`${baseUrlOf(baseUrl)}${FISH_MODEL_PATH}`)
  const pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 100)))
  const pageNumber = Math.max(1, Math.trunc(options.pageNumber ?? 1))
  url.searchParams.set('page_size', String(pageSize))
  url.searchParams.set('page_number', String(pageNumber))
  if (options.title !== undefined && options.title.length > 0) url.searchParams.set('title', options.title)
  if (options.tag !== undefined && options.tag.length > 0) url.searchParams.set('tag', options.tag)
  if (options.authorId !== undefined && options.authorId.length > 0) url.searchParams.set('author_id', options.authorId)
  if (options.language !== undefined && options.language.length > 0) url.searchParams.set('language', options.language)
  if (options.sortBy !== undefined) url.searchParams.set('sort_by', options.sortBy)
  return url.toString()
}

/** 获取一页 Fish 声音模型并映射为 dsh 声音摘要。 */
export async function listFishVoices(
  baseUrl: string,
  apiKey: string,
  options: TtsVoiceListOptions = {},
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TtsVoicePage> {
  const response = await fetchImpl(queryUrl(baseUrl, options), {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`fish-audio voice list HTTP ${response.status}: ${await readError(response)}`)
  const payload = recordOf(await response.json()) as FishModelPagePayload | undefined
  if (payload === undefined || !Array.isArray(payload.items)) throw new Error('fish-audio voice list returned malformed JSON')
  const voices = payload.items
    .filter(isTtsModel)
    .map(fishVoiceOf)
    .filter((item): item is TtsVoiceInfo => item !== undefined)
  const pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 100)))
  const pageNumber = Math.max(1, Math.trunc(options.pageNumber ?? 1))
  const total = typeof payload.total === 'number' ? payload.total : voices.length
  const hasMore = typeof payload.has_more === 'boolean' ? payload.has_more : pageNumber * pageSize < total
  return { voices: voices.map(item => item.voice), total, pageSize, pageNumber, hasMore }
}

/** 获取一个 Fish 声音模型的完整详情。 */
export async function getFishVoiceInfo(
  baseUrl: string,
  apiKey: string,
  voiceId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TtsVoiceInfo> {
  const url = `${baseUrlOf(baseUrl)}${FISH_MODEL_PATH}/${encodeURIComponent(voiceId)}`
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`fish-audio voice info HTTP ${response.status}: ${await readError(response)}`)
  const info = fishVoiceOf(await response.json())
  if (info === undefined) throw new Error('fish-audio voice info returned malformed JSON')
  return info
}
