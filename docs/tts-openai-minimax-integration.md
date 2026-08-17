# 技术调研：OpenAI tts-1/tts-1-hd 与 MiniMax speech-2.8-turbo 接入（integration research）

> 状态：调研记录（实现参考，已按 302AI 落地端点更新）。收集两家的接入方式、凭据管理、
> 模型参数、音色，并评估是否可用 AI SDK 统一接入。配套设计见
> `docs/tts-vendor-credential-design.md`。选型对比见 `docs/tts-provider-comparison.md`。
>
> ⚠️ **vendor 选择**：本实现经 **302AI** 中转（OpenAI 兼容端点 + MiniMax DashScope 风格
> 端点），非官方直连。302AI 只支持 `tts-1`/`tts-1-hd`（**不支持** `gpt-4o-mini-tts`，实测
> 返回 `err_code -10003 参数错误`）。MiniMax 走 302AI 的 `/t2a_v2`（DashScope 风格），
> **不是** OpenAI 兼容协议。

## 1. OpenAI `tts-1` / `tts-1-hd`

### 1.1 端点与鉴权

| 项 | 值 |
|---|---|
| Endpoint | `POST {baseUrl}/audio/speech`（`baseUrl` 含版本前缀，如 302AI 的 `https://api.302.ai/v1`） |
| Auth | `Authorization: Bearer <API_KEY>` |
| Content-Type | `application/json`（body 直接 JSON，非 form-data） |
| 流式 | ✅ chunked transfer，首包 ~300–600ms；**无 `stream` body 参数** |

> **vendor 解耦**：OpenAI 兼容 reseller 只需换 `baseUrl`（前缀，含 `/v1`）+ 自己的
> `api_key`，路径仍是 `/audio/speech`。协议层的 `OPENAI_API_PATH = '/audio/speech'` 与
> vendor 的 `baseUrl` 拼接成完整 URL——**vendor 的 `baseUrl` 必须已含版本前缀 `/v1`**，
> 否则拼成 `https://host/audio/speech` 会缺 `/v1`。

### 1.2 请求参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | ✅ | `tts-1`(默认) / `tts-1-hd` |
| `input` | string | ✅ | 待合成文本，上限 4096 字符 |
| `voice` | string | ✅ | 见 §1.3 音色 |
| `response_format` | enum | 否 | `mp3`(默认) / `opus` / `aac` / `flac` |
| `speed` | number | 否 | 语速 0.25–4.0，默认 1.0 |
| `instructions` | string | 否 | 自然语言控情绪/语速/重音/口音（**仅 `gpt-4o-mini-tts`**；tts-1 忽略，留空不发送） |

> 302AI 的 `tts-1`/`tts-1-hd` 不支持 `wav`/`pcm` 输出，故 `format`/`play_format` 枚举只保留
> `mp3/opus/aac/flac`；host_play 默认 `mp3`（ffplay/afplay 均播 mp3）。

### 1.3 音色

`tts-1`/`tts-1-hd` 共 9 个：`alloy` `ash` `coral` `echo` `fable` `nova` `onyx` `sage` `shimmer`。
`gpt-4o-mini-tts` 额外 4 个 `ballad` `verse` `marin` `cedar`（共 13），但 302AI 不开放该模型。
实现里 `listVoices()` 返回 9 个（`OPENAI_TTS_1_VOICES`）；13 个完整枚举在
`OPENAI_GPT_4O_MINI_TTS_VOICES` 供未来启用 mini-tts 时切换。

### 1.4 响应与格式

- 非流式：响应体 = 音频字节，Content-Type 随 `response_format`（如 `audio/mpeg`）。
- 流式：`Transfer-Encoding: chunked`，边生成边返回裸音频字节（非 NDJSON）。

## 2. MiniMax `speech-2.8-turbo`（经 302AI，DashScope 风格）

### 2.1 端点与鉴权

| 项 | 值 |
|---|---|
| Endpoint | `POST {baseUrl}/t2a_v2`（302AI 的 `baseUrl = https://api.302.ai/minimaxi/v1`） |
| Auth | `Authorization: Bearer <API_KEY>` |
| Content-Type | `application/json` |
| 流式 | ✅ SSE，`stream: true`，音频逐帧以 hex 编码返回 |

> MiniMax 经 302AI 的 DashScope 风格端点 `/minimaxi/v1/t2a_v2`（原生 T2A v2 协议）。
> **不是** OpenAI 兼容协议——这是「vendor 决定协议/path」的价值所在：同一个 MiniMax
> provider 接不同 vendor 时 path 可能不同，但本实现固定 `MINIMAX_API_PATH = '/t2a_v2'`。

### 2.2 请求参数（扁平 body）

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | ✅ | `speech-2.8-turbo`(默认) / `speech-2.8-hd` / `speech-2.6-hd` |
| `text` | string | ✅ | 待合成文本 |
| `stream` | boolean | 否 | 是否 SSE 流式，默认 false |
| `voice_setting.voice_id` | string | ✅ | 音色 id（新域格式，见 §2.3） |
| `voice_setting.speed` | number | 否 | 语速 0.5–2.0 |
| `voice_setting.vol` | number | 否 | 音量 (0, 10] |
| `voice_setting.pitch` | number | 否 | 音调 -12 ~ +12 |
| `voice_setting.emotion` | string | 否 | 情感（HD 支持 whisper 等；留空不发送） |
| `audio_setting.sample_rate` | number | 否 | 采样率，默认 32000 |
| `audio_setting.format` | enum | 否 | `mp3`(默认) / `pcm` / `flac` / `wav` |
| `audio_setting.bitrate` | number | 否 | 32000–256000，**仅 mp3**（非 mp3 不发送） |
| `audio_setting.channel` | number | 否 | 1 或 2 |

### 2.3 音色

`voice_id` 是 MiniMax 预置系统音色，**新域格式**（`platform.minimax.io`）：
`Chinese (Mandarin)_Reliable_Executive`、`English_Trustworth_Man`、`Korean_ShyGirl` 等，
共 **332 个**，按语言分组。旧域（`minimaxi.com`）的 `male-qn-qingse`/`female-shaonv`
是**旧格式，不要混用**。实现里 `listVoices()` 返回 `MINIMAX_SPEECH_02_TURBO_VOICES`
（= 完整 332），源文件 `src/minimax-voices.ts` 头注释说明抓取方式。

### 2.4 响应与格式

- 非流式：`data.audio` 为 **hex 编码**音频字符串，需 hex→bytes 还原。
- 流式（SSE）：逐帧 `data.audio` 为 **hex 编码**，逐帧 decode 后 yield。

> 注意：官方 DashScope 原生通道非流式返回 **base64**，但 302AI 的 `/t2a_v2` 非流式与
> 流式都返回 **hex**。本实现 `decodeAudio` 对两者统一 hex 解码。

## 3. 凭据管理（对齐现有 dsh seam）

- dsh-voice-tts 现有凭据模型：settings 里只存 `apiKeyRef`（KEY NAME），实际密钥经
  `ctx.credentials.resolve(credentialRef(name))` 解析（读 `.credentials.yaml` / env）。
  `baseUrl` 不是密钥，放 settings 普通字段。
- 新增的「vendor」= `{ baseUrl, apiKeyRef }` 对：**`baseUrl` 落 settings（明文）、
  `apiKeyRef` 走 credentialRef（一个 KEY NAME）**，两者由 vendor 记录绑定，不把密钥塞进 settings。
- 302AI 两个 provider 共用同一个 KEY NAME：`TTS_302AI_API_KEY`（`.env` 里导出）。

## 4. AI SDK 能否统一接入？——结论：不采用

| 维度 | AI SDK 现状 |
|---|---|
| 统一 TTS 抽象 | `generateSpeech` 存在但**实验性**，`openai.speech('gpt-4o-mini-tts')` 可用 |
| 流式 | **不支持**（一次性返回 audio bytes，无 stream） |
| MiniMax TTS | 社区 `@ai-sdk/minimax` **只覆盖文本生成，不覆盖 TTS**；MiniMax TTS 是 DashScope 专有协议，非 OpenAI 兼容 |
| base_url override | 文档未给出 speech 场景的干净 baseURL 配置 |

结论：AI SDK 能统一 OpenAI 一家（还丢流式），但**统一不了 MiniMax**，且要拉入 `ai` +
`@ai-sdk/openai` 重依赖。dsh-voice-tts 已有 `TtsProvider`（synthesize / streamSynthesize /
listVoices）三层 seam，**保留它、各加一个 provider** 是更干净的路径；provider/vendor
解耦是数据模型问题，AI SDK 不解决。

## 5. 测试成本控制

- 每次合成测试文本 **≤ 50 词/字**（控制 302AI 计费成本）。测试 fixture 与真机 `speak`
  验证都遵循此上限。

## 6. 来源

- OpenAI TTS 指南：https://developers.openai.com/api/docs/guides/text-to-speech
- OpenAI Speech 参考：https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
- MiniMax T2A v2（原生）：https://platform.minimax.io/docs/api-reference/speech-t2a-http
- MiniMax 系统音色列表：https://platform.minimax.io/docs/faq/system-voice-id
- MiniMax 语音定价：https://platform.minimaxi.com/docs/guides/pricing-speech
- 302AI MiniMax 语音合成：https://302ai-en.apifox.cn/336008006e0
- AI SDK 社区 MiniMax：https://ai-sdk.dev/providers/community-providers/minimax
- AI SDK Speech（generateSpeech）：https://swift-ai-sdk-docs.vercel.app/ai-sdk-core/speech
