/**
 * capability seam 的词汇类型(纯类型,不 import cordis)。
 * @module dsh-voice-tts/types
 */

/** 音色表条目。字段名与 volcengine 音色列表列名一致。 */
export interface TtsVoice {
  /** API 请求的 `speaker` 值,如 `zh_female_vv_uranus_bigtts`。 */
  readonly voice_type: string
  /** 音色名称,如 `Vivi 2.0`。 */
  readonly name: string
  /** 适用场景,如 `通用场景`。 */
  readonly scene: string
  /** 语种/方言,如 `中文`。 */
  readonly lang: string
  /** 支持能力,如 `指令遵循`。 */
  readonly ability: string
  /** 特殊标签(抖音同款 等),可空。 */
  readonly tag?: string
  /** 归属表:`standard`(2.0 标准)或 `multilingual`(2.0 多语种)。 */
  readonly group: 'standard' | 'multilingual'
}

/** 一次合成请求:待合成文本 + 已解析的 provider 配置。 */
export interface TtsRequest {
  readonly text: string
  readonly config: Record<string, unknown>
}

/** 一次合成结果:解码后的音频字节 + 格式 + 计费字数。 */
export interface TtsResult {
  readonly audio: Uint8Array
  readonly format: string
  readonly textWords: number
}

/** `config --template` 输出的单个字段描述。 */
export interface ConfigTemplateField {
  readonly type: 'string' | 'number' | 'object'
  readonly required: boolean
  readonly default: string | number | null
  readonly description: string
  readonly enum?: readonly (string | number)[]
}

/** 一个 provider 的完整配置模板(含凭据引用名,不含凭据值)。 */
export interface ConfigTemplate {
  readonly provider: string
  readonly config: Readonly<Record<string, ConfigTemplateField>>
  readonly credentials: { readonly apiKeyRef: string }
}

/** capability seam 的 Provider 角色契约。 */
export interface TtsProvider {
  /** Provider 唯一 id,如 `volcengine`。 */
  readonly id: string
  /** 完整配置模板(供 `config --template` 展示)。 */
  readonly configTemplate: ConfigTemplate
  /** 合成一段文本为音频字节。 */
  synthesize(request: TtsRequest): Promise<TtsResult>
  /** 该 provider 可用的音色列表。 */
  listVoices(): readonly TtsVoice[]
}

/** 模型版本(请求头 `X-Api-Resource-Id`)。 */
export type VolcengineResourceId = 'seed-tts-2.0' | 'seed-icl-2.0'

/** 音频格式(`audio_params.format`)。 */
export type VolcengineFormat = 'mp3' | 'pcm' | 'ogg_opus' | 'wav'

/** 句子的语言类别:`zh` 纯中文、`en` 纯英文、`mixed` 中英混写。 */
export type SentenceLang = 'zh' | 'en' | 'mixed'

/** bilingual 播报模式:`both` 全读、`english_only` 只读英文(含混合)、`chinese_only` 只读中文(含混合)。 */
export type BilingualMode = 'both' | 'english_only' | 'chinese_only'

/** 各语言类别的音色覆盖(缺省回退 `voice_type`)。 */
export interface VoiceTtsVoices {
  /** 中文句音色。 */
  readonly zh?: string
  /** 英文句音色。 */
  readonly en?: string
  /** 中英混写句音色;缺省先回退 `zh` 再回退 `voice_type`。 */
  readonly mixed?: string
}

/** volcengine provider 的已解析配置(settings schema 解析后的字段)。 */
export interface VolcengineConfig {
  /** 音色 ID(`speaker`),必选。 */
  voice_type: string
  /** 请求头 `X-Api-Resource-Id`(模型版本)。 */
  resource_id: VolcengineResourceId
  /** `req_params.model`,仅复刻音色需覆盖。 */
  model: string
  /** 音频格式。 */
  format: VolcengineFormat
  /** 采样率 Hz,[8000, 48000]。 */
  sample_rate: number
  /** 语速,[-50, 100]。 */
  speech_rate: number
  /** 音量,[-50, 100]。 */
  loudness_rate: number
  /** 音调,[-12, 12]。 */
  pitch: number
  /** bilingual 播报模式。 */
  bilingual: BilingualMode
  /** 各语言类别音色覆盖。 */
  voices: VoiceTtsVoices
}

/** `voice-tts` 设置命名空间的已解析切片。 */
export interface VoiceTtsSettings {
  /** 自动播放开关(首版为预留,播放挂接点尚未实现)。 */
  autoplay: boolean
  /** 当前选中的 provider id。 */
  provider: string
  /** 各 provider 的配置。 */
  providers: { volcengine: VolcengineConfig }
}
