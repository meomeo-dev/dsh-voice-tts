# 技术调研：OpenAI gpt-4o-mini-tts 与 MiniMax speech-02-turbo 接入（integration research）

> 状态：调研记录（实现前参考）。收集两家的接入方式、凭据管理、模型参数、音色，并评估
> 是否可用 AI SDK 统一接入。配套设计见 `docs/tts-vendor-credential-design.md`。

## 1. OpenAI `gpt-4o-mini-tts`

### 1.1 端点与鉴权

| 项 | 值 |
|---|---|
| Endpoint | `POST https://api.openai.com/v1/audio/speech` |
| Auth | `Authorization: Bearer <OPENAI_API_KEY>` |
| Content-Type | `application/json`（body 直接 JSON，非 form-data） |
| 流式 | ✅ chunked transfer，首包 ~300–600ms |

> 关键：OpenAI 兼容的 reseller 只需换 `base_url`（前缀）+ 自己的 `api_key`，路径仍是 `/v1/audio/speech`。这正是「provider=openai、vendor 可换」的落点。

### 1.2 请求参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | ✅ | `gpt-4o-mini-tts`（也兼容 `tts-1`/`tts-1-hd`） |
| `input` | string | ✅ | 待合成文本，上限 4096 字符（mini-tts 上下文 ~2000 token） |
| `voice` | string | ✅ | 见 §1.3 音色 |
| `instructions` | string | 否 | 自然语言控情绪/语速/重音/口音（mini-tts 独有） |
| `response_format` | enum | 否 | `mp3`(默认) / `opus` / `aac` / `flac` / `wav` / `pcm` |
| `speed` | number | 否 | 语速 0.25–4.0，默认 1.0 |

### 1.3 音色（13 个）

`alloy` `ash` `ballad` `coral` `echo` `fable` `nova` `onyx` `sage` `shimmer` `verse` `marin` `cedar`
（`tts-1`/`tts-1-hd` 只支持其中 9 个：无 ballad/verse/marin/cedar）

### 1.4 响应与格式

- 非流式：响应体 = 音频字节，Content-Type 随 `response_format`（如 `audio/mpeg`）。
- 流式：`Transfer-Encoding: chunked`，边生成边返回音频块。

## 2. MiniMax `speech-02-turbo`

### 2.1 端点与鉴权

| 项 | 值 |
|---|---|
| Endpoint | `POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`（新工作区域 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/...` 同路径） |
| Auth | `Authorization: Bearer <DASHSCOPE_API_KEY>` |
| 流式 | ✅ 加头 `X-DashScope-SSE: enable`（SSE，音频以 hex 编码返回） |

> MiniMax 经阿里云 Model Studio（DashScope）通道接入；不同 reseller 的 base_url 前缀不同，路径一致。

### 2.2 请求参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | ✅ | `MiniMax/speech-02-turbo`（HD 为 `MiniMax/speech-02-hd`） |
| `input.text` | string | ✅ | 待合成文本，< 10000 字符 |
| `input.voice_setting.voice_id` | string | ✅ | 音色 id（如 `male-qn-qingse`） |
| `input.voice_setting.speed` | number | 否 | 语速 0.5–2.0 |
| `input.voice_setting.vol` | number | 否 | 音量 |
| `input.voice_setting.pitch` | number | 否 | 音调 -12 ~ +12 |
| `input.voice_setting.emotion` | string | 否 | 情感（HD 支持 whisper 等） |
| `input.audio_setting.sample_rate` | number | 否 | 8000–44100，默认 32000 |
| `input.audio_setting.format` | enum | 否 | `mp3`(默认) / `pcm` / `flac` / `wav` |
| `input.audio_setting.bitrate` | number | 否 | 32000–256000，仅 mp3 |
| `input.audio_setting.channel` | number | 否 | 1 或 2 |

### 2.3 音色

`voice_id` 是 MiniMax 预置音色字符串（`male-qn-qingse`、`female-…` 等一组固定 id）。**不像 OpenAI 有稳定公开的 13 个枚举**，MiniMax 音色表需要「静态目录 + 可扩展」，实现时 `listVoices()` 返回内置的已知 id 集合，用户可在配置里补。

### 2.4 响应与格式

- 非流式：`output.data.audio` 为 base64 音频；`extra_info` 含 `audio_length/sample_rate/format/size` 与 usage 字符数。
- 流式（SSE）：`output.data.audio` 以 **hex 编码**逐帧返回，需 hex→Buffer 还原。

## 3. 凭据管理（对齐现有 dsh seam）

- dsh-voice-tts 现有凭据模型：settings 里只存 `apiKeyRef`（KEY NAME），实际密钥经 `ctx.credentials.resolve(credentialRef(name))` 解析（读 `.credentials.yaml` / env）。`base_url` 不是密钥，放 settings 普通字段。
- 本次要新增的「vendor」= `{ base_url, api_key }` 对：**`base_url` 落 settings（明文）、`api_key` 仍走 `credentialRef`（一个 KEY NAME）**，两者由 vendor 记录绑定，不把密钥塞进 settings。

## 4. AI SDK 能否统一接入？——结论：不采用

| 维度 | AI SDK 现状 |
|---|---|
| 统一 TTS 抽象 | `generateSpeech` 存在但**实验性**，`openai.speech('gpt-4o-mini-tts')` 可用 |
| 流式 | **不支持**（一次性返回 audio bytes，无 stream） |
| MiniMax TTS | 社区 `@ai-sdk/minimax` **只覆盖文本生成，不覆盖 TTS**；MiniMax TTS 是 DashScope 专有协议，非 OpenAI 兼容 |
| base_url override | 文档未给出 speech 场景的干净 baseURL 配置 |

结论：AI SDK 能统一 OpenAI 一家（还丢流式），但**统一不了 MiniMax**，且要拉入 `ai` + `@ai-sdk/openai` 重依赖。dsh-voice-tts 已有 `TtsProvider`（synthesize / streamSynthesize / listVoices）三层 seam，**保留它、各加一个 provider** 是更干净的路径；provider/vendor 解耦是数据模型问题，AI SDK 不解决。

## 5. 来源

- OpenAI TTS 指南：https://developers.openai.com/api/docs/guides/text-to-speech
- OpenAI Speech 参考：https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
- MiniMax 同步语音合成（阿里云）：https://help.aliyun.com/zh/model-studio/minimax-synchronous-speech-synthesis-api
- MiniMax 语音定价：https://platform.minimaxi.com/docs/guides/pricing-speech
- AI SDK 社区 MiniMax：https://ai-sdk.dev/providers/community-providers/minimax
- AI SDK Speech（generateSpeech）：https://swift-ai-sdk-docs.vercel.app/ai-sdk-core/speech
