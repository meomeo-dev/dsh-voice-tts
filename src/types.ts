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

/** 流式合成的一个音频分片(stream 交付的最小单位)。 */
export interface TtsChunk {
  /** 分片音频字节。 */
  readonly audio: Uint8Array
}

/** capability seam 的 Provider 角色契约。 */
export interface TtsProvider {
  /** Provider 唯一 id,如 `volcengine`。 */
  readonly id: string
  /** 完整配置模板(供 `config --template` 展示)。 */
  readonly configTemplate: ConfigTemplate
  /** 合成一段文本为音频字节。 */
  synthesize(request: TtsRequest): Promise<TtsResult>
  /** 流式合成一段文本为音频分片序列。 */
  streamSynthesize(request: TtsRequest): AsyncIterable<TtsChunk>
  /** 该 provider 可用的音色列表。 */
  listVoices(): readonly TtsVoice[]
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

/** 模型版本(请求头 `X-Api-Resource-Id`)。 */
export type VolcengineResourceId = 'seed-tts-2.0' | 'seed-icl-2.0'

/** 音频格式(`audio_params.format`)。 */
export type VolcengineFormat = 'mp3' | 'pcm' | 'ogg_opus' | 'wav'

/** 句子的语言类别:`zh` 纯中文、`en` 纯英文、`mixed` 中英混写。 */
export type SentenceLang = 'zh' | 'en' | 'mixed'

/** bilingual 播报模式:`both` 全读、`english_only` 只读英文(含混合)、`chinese_only` 只读中文(含混合)。 */
export type BilingualMode = 'both' | 'english_only' | 'chinese_only'

/** 一个可调合成参数的元数据(驱动 schemastery 校验、Web 面板控件与 `config --template` 文档三处)。 */
export interface TunableParam {
  /** 参数键(与 provider 顶层同名字段,如 `loudness_rate` / `speed`)。 */
  readonly key: string
  /** 展示名(中文)。 */
  readonly label: string
  /** 最小值。 */
  readonly min: number
  /** 最大值。 */
  readonly max: number
  /** 步进。 */
  readonly step: number
}

/**
 * 一个语言类别槽位:音色(`voice_type`)+ 可选的可调合成参数。
 * 参数键随 provider(volcengine 与 siliconflow-cn 各不同);槽位未写的参数
 * 回退 provider 顶层同名字段(见 design.md §7.5)。
 */
export interface VoiceSlot {
  /** 音色(`voice_type`):volcengine 的 `speaker` / siliconflow 的 `voice`。缺省回退 provider 顶层 `voice_type`。 */
  readonly voice_type?: string
  /** volcengine:音调 [-12,12]。 */
  readonly pitch?: number
  /** volcengine:语速 [-50,100]。 */
  readonly speech_rate?: number
  /** volcengine:音量 [-50,100]。 */
  readonly loudness_rate?: number
  /** siliconflow-cn:语速 [0.25,4.0]。 */
  readonly speed?: number
  /** siliconflow-cn:音量增益 dB [-10,10]。 */
  readonly gain?: number
}

/** 各语言类别的音色槽位(缺省回退 `voice_type`)。 */
export interface VoiceTtsVoices {
  /** 中文句槽位。 */
  readonly zh?: VoiceSlot
  /** 英文句槽位。 */
  readonly en?: VoiceSlot
  /** 中英混写句槽位;缺省先回退 `zh` 再回退 `voice_type`。 */
  readonly mixed?: VoiceSlot
}

/** per-voice 音色映射:key 是 dsh-voice 的 voice id(如 `steve-jobs`),value 是该口吻的音色槽位覆盖。 */
export type VoiceTtsProfiles = Record<string, VoiceTtsVoices>

/** turn-final 的音频交付方式。 */
export type DeliveryMode = 'off' | 'file' | 'host_play' | 'stream'

/** 音频落盘层级:`user` 用户级(默认)/ `project` 仓库级。 */
export type StorageScope = 'user' | 'project'

/** 音频落盘配置(见 docs/audio-storage-and-playback.md §3)。 */
export interface StorageConfig {
  /** 无 `dir` 时选层级:默认用户级;project 时写 `<repo>/.dsh/voice-tts`(非仓库回退用户)。 */
  scope: StorageScope
  /** 会话自定义绝对路径;非空时优先级最高。 */
  dir: string
}

/** 本机播放器配置(见 docs/audio-storage-and-playback.md §4.2)。 */
export interface PlayerConfig {
  /** 播放器命令路径;空 = 自动探测 ffplay → afplay。 */
  command: string
}

/**
 * 双语播报 + 音色映射的共享配置(provider 无关)。各 provider 的 config 都继承它,
 * 双语规划(`bilingual.ts`)只依赖这一份,不感知 provider 差异。
 */
export interface BilingualVoiceConfig {
  /** bilingual 播报模式。 */
  bilingual: BilingualMode
  /** 默认音色 ID(volcengine 的 `speaker` / siliconflow 的 `voice`,值随 provider)。 */
  voice_type: string
  /** 各语言类别音色覆盖(缺省回退 voice_type)。 */
  voices: VoiceTtsVoices
  /** per-voice 音色覆盖:命中当前 dsh-voice 的 voice id 时取代 `voices`。 */
  voice_profiles: VoiceTtsProfiles
}

/** API key 的凭证引用(KEY NAME)。settings 只存引用名,值在 credentials 存储。 */
export interface ApiKeyRefSettings {
  /** 凭证引用名(如 `VOLCENGINE_TTS_API_KEY`),运行时经 `ctx.credentials.resolve` 解析。 */
  apiKeyRef: string
}

/** volcengine provider 的已解析配置(合成参数 + 双语共享配置)。 */
export interface VolcengineConfig extends BilingualVoiceConfig {
  /** 请求头 `X-Api-Resource-Id`(模型版本)。 */
  resource_id: VolcengineResourceId
  /** `req_params.model`,仅复刻音色需覆盖。 */
  model: string
  /** 音频格式(file/stream 落盘用)。 */
  format: VolcengineFormat
  /** host_play 的合成格式(跨平台播放器兼容,默认 wav)。 */
  play_format: VolcengineFormat
  /** 采样率 Hz,[8000, 48000]。 */
  sample_rate: number
  /** 语速,[-50, 100]。 */
  speech_rate: number
  /** 音量,[-50, 100]。 */
  loudness_rate: number
  /** 音调,[-12, 12]。 */
  pitch: number
}

/** siliconflow provider 的已解析配置(合成参数 + 双语共享配置)。 */
export interface SiliconflowConfig extends BilingualVoiceConfig {
  /** TTS 模型 id(如 `FunAudioLLM/CosyVoice2-0.5B`)。 */
  model: string
  /** 音频格式(file/stream 落盘用;映射到 API 的 `response_format`)。 */
  format: 'mp3' | 'opus' | 'wav' | 'pcm'
  /** host_play 的合成格式(跨平台播放器兼容,默认 wav)。 */
  play_format: 'mp3' | 'opus' | 'wav' | 'pcm'
  /** 采样率 Hz;不同格式允许值不同。 */
  sample_rate: number
  /** 语速,[0.25, 4.0]。 */
  speed: number
  /** 音量增益 dB,[-10, 10]。 */
  gain: number
}

/** 一个 provider 的完整设置(config + 凭证引用)。 */
export type VolcengineProviderSettings = VolcengineConfig & ApiKeyRefSettings
/** 一个 siliconflow provider 的完整设置(config + 凭证引用)。 */
export type SiliconflowProviderSettings = SiliconflowConfig & ApiKeyRefSettings

/** host provider 的已解析配置(本地命令行 TTS,无凭证)。 */
export interface HostConfig extends BilingualVoiceConfig {
  /** 本地 TTS 命令绝对路径,如 `/usr/bin/say`。 */
  command: string
  /** 语速(words per minute,`say` 的 `-r`)。 */
  rate: number
}

/** `voice-tts` 设置命名空间的已解析切片(多 provider)。 */
export interface VoiceTtsSettings {
  /** turn-final 交付方式:off 不处理 / file 落盘 / host_play 本机播放 / stream 流式。 */
  delivery: DeliveryMode
  /** 当前选中的 provider id。 */
  provider: string
  /** 音频落盘目录配置(见 docs/audio-storage-and-playback.md §3)。 */
  storage: StorageConfig
  /** 本机播放器配置(见 docs/audio-storage-and-playback.md §4.2)。 */
  player: PlayerConfig
  /** 各 provider 的设置(键 = provider id,与注册的 provider 一一对应)。 */
  providers: {
    volcengine: VolcengineProviderSettings
    'siliconflow-cn': SiliconflowProviderSettings
    host: HostConfig
  }
}
