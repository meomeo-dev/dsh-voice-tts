# TTS Provider 对比与选型（candidate comparison）

> 状态：调研记录（实现前参考）。为 dsh-voice-tts 引入「便宜语音合成」而做的候选对比，
> 覆盖 5 家 provider，供按「价格 / 中文音质 / 情感表达 / 多语种」四维选型。
> 计费单位不统一（字符 / token / 字节），下表统一折算到「每 1M 字符」与「约每分钟语音」两个口径。

## 0. 口径说明

- **每 1M 字符**：TTS 最标准的计费单位（Google/ElevenLabs/MiniMax 均按字符）。中英文一个字符都算 1，空格与 SSML 标签也计费。
- **约每分钟语音**：按英文 ~900 字符/分钟估算的统一口径；中文信息密度高、字符少，**中文实际更便宜**（约 220 字/分钟，同样 1M 字符中文能读更久）。
- **汇率**：`$1 ≈ ¥7.2`（2026 年参考值，实际以当日为准）。所有 USD 列右侧都跟一列 **≈CNY**，方便按人民币判断。
- OpenAI `gpt-4o-mini-tts` 按 token 计费，无法直接折算到字符，保留官方「约每分钟」口径并单独说明。

## 1. 五家候选总表

| Provider / 模型 | 每 1M 字符 (USD) | ≈ CNY | 约每分钟语音 (USD) | ≈ CNY | 中文 | 免费额度/月 | 音色 | 流式 | 输出格式 | 情感/语气控制 | 成熟度 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Google Cloud TTS `WaveNet`** ⭐便宜 | **$4** | **¥28.8** | **~$0.004** | **~¥0.03** | ✅ 多音色 | 1M 字符 | 多 | ✅ | MP3 / OGG_OPUS / LINEAR16(WAV) | 仅音色 + SSML | GA |
| **OpenAI `gpt-4o-mini-tts`** ⭐性价比 | token | — | ~$0.015 | ~¥0.11 | ✅ 50+ 语言 | 无 | 13 | ✅ | MP3 / Opus / AAC / FLAC | `instructions` 自然语言控情绪/语速/口音 | GA |
| **MiniMax `speech-02-turbo`** | ~$28 | **¥200**（原生） | ~$0.031 | ~¥0.22 | ✅ 母语级 | 平台券 | 多 | ✅(SSE) | MP3 / PCM / FLAC / WAV | HD 版有 whisper 等情感标签 | GA |
| **Fish Audio `S2 Pro`** | 表面 $15，CJK 按字节 → **中文 ~$45** | 表面 ¥108 / 中文 ~¥324 | ~$0.05 | ~¥0.36 | ✅ 强 | 1K 字符/天 | 多 | ✅ | (MP3/WAV 等) | 音色克隆(10–30s 音频) | GA |
| **ElevenLabs `Flash v2.5`** | **$60** | **¥432** | ~$0.067 | ~¥0.48 | ✅ 多语 | 1 万 credits/月 | 多 | ✅ | MP3 / PCM(44.1kHz) | 音色克隆 + 配音风格 | GA |

（同一 provider 的高低档见 §3 细分；Gemini TTS 因价格显著高于本表、且属「多模态语音生成」而非「便宜朗读」，单独在 §4 说明，不占 5 家名额。）

## 2. 四维选型结论

| 目标 | 首选 | 理由 |
|---|---|---|
| **最便宜** | Google `WaveNet`（$4/M ≈ ¥28.8/M ≈ ¥0.03/min） | 2026 年初从 $16 降到 $4，价格 ≈ Standard 但音质更好；免费 1M 字符/月 |
| **性价比 + 语气可控** | OpenAI `gpt-4o-mini-tts`（~¥0.11/min） | `instructions` 参数用自然语言控情绪/语速/口音，老 tts-1 没有 |
| **中文母语级音质 + 情感** | MiniMax `speech-02-hd`（¥3.5/万字符） | 中文 TTS 头部，HD 有 whisper 情感、latex_read 等中文专属能力 |
| **音色克隆 / 多语种** | ElevenLabs 或 Fish Audio | ElevenLabs 是配音质量标杆；Fish 中文强、80+ 语言、克隆门槛低（10s 音频） |

## 3. 各 provider 细分档位

### 3.1 Google Cloud Text-to-Speech（按字符，非 Gemini）

| Voice 类型 | 每 1M 字符 (USD) | ≈ CNY | 免费额度/月 |
|---|---|---|---|
| Standard | $4 | ¥28.8 | 4M 字符 |
| **WaveNet** | **$4**（从 $16 降） | ¥28.8 | 1M 字符 |
| Neural2 / Polyglot | $16 | ¥115.2 | 1M 字符 |
| Chirp 3 HD | $30 | ¥216 | 1M 字符 |
| Studio | $160 | ¥1152 | 100K 字符 |

免费额度各类型叠加 ≈ 每月 100+ 小时免费；新账号另送 $300 券（90 天）。API 为 `texttosynthesize.googleapis.com/v1/text:synthesize`，有 `streaming:synthesize`，输出 MP3 / OGG_OPUS / LINEAR16(WAV)。

### 3.2 OpenAI（TTS 三档）

| 模型 | 计费 | ≈ CNY | 约每分钟 |
|---|---|---|---|
| `tts-1` | $15 / 1M 字符 | ¥108 / 1M | ~$0.015（~¥0.11） |
| `tts-1-hd` | $30 / 1M 字符 | ¥216 / 1M | ~$0.03（~¥0.22） |
| **`gpt-4o-mini-tts`** | $0.60/M 输入 + $12/M 音频 token | — | ~$0.015/min（~¥0.11/min） |

`gpt-4o-mini-tts` 与 `tts-1` 单价相当，但多了 `instructions` 自然语言控制（情绪/语速/重音/口音），13 音色、50+ 语言、支持流式（首包 ~300–600ms）。上下文 2000 input token。

### 3.3 MiniMax（阿里云 Model Studio 通道）

| 模型 | 定价 | 每 1M 字符 | ≈ CNY | 说明 |
|---|---|---|---|---|
| **`speech-02-turbo`** | ¥2 / 万字符 | ~$28 | ¥200 | 低价档，支持流式(SSE) |
| `speech-02-hd` | ¥3.5 / 万字符 | ~$49 | ¥350 | 高质量，whisper 情感标签、latex_read（中文）、language_boost |

输出 `mp3`(默认) / `pcm` / `flac` / `wav`；流式走 `X-DashScope-SSE: enable`（hex 音频）。

### 3.4 Fish Audio

`S2 Pro`：**表面 $15/1M 字符，但按 UTF-8 字节计费** —— 中文一个汉字 3 字节，所以中文实际 ≈ $45/1M 字符（≈¥324/M）。80+ 语言、中文日韩(CJK) 强、~200ms 延迟、10–30s 音频即可克隆音色。免费 1K 字符/天。

### 3.5 ElevenLabs

| 模型 | 每 1M 字符 (USD) | ≈ CNY |
|---|---|---|
| **Flash v2.5 / Turbo** | $60 | ¥432 |
| Multilingual v2 / v3 | $120 | ¥864 |

免费 1 万 credits/月（Multilingual 1 字符 = 1 credit，Flash/Turbo 0.5 credit/字符）。配音质量标杆、音色克隆强；单价是 5 家里最高的。

## 4. 不在候选内的：Gemini TTS

Gemini 3.1 Flash TTS 是**多模态语音生成**（200+ 内联语气标签、双说话人），不是「便宜朗读」：
- 定价 ~$1/M 输入 + $20/M 音频 token（≈ ¥144/M 音频 token，OpenRouter 口径），显著高于本表全部 5 家。
- 输出裸 PCM 24kHz（需自行封 WAV 头），仅 3.1 支持流式，Preview 状态。

只有当需求是「语气/情绪/多说话人导演式配音」时才值得，与「便宜」目标相反，故不占名额。

## 5. 对 dsh-voice-tts 的落地建议

- 若目标就是「便宜」：先做 **Google Cloud TTS**（默认 `WaveNet`，`Chirp 3 HD` 作高质量档可选），它单价最低、标准 REST + MP3/WAV 容器头，最贴合现有 `TtsProvider` 三件套（synthesize / streamSynthesize / listVoices）。
- 若还要「中文情感表达」：**MiniMax** 的 HD 档是中文场景的加分项，也可做成 provider。
- ElevenLabs / Fish Audio 属于「高质量配音 / 音色克隆」方向，与「便宜」是不同诉求，可后续按需加。

## 6. 来源

- Google Cloud TTS 定价：https://texttolab.com/blog/google-cloud-tts-pricing
- OpenAI TTS 定价对比：https://texttolab.com/blog/openai-tts-pricing / https://tokenmix.ai/blog/gpt-4o-mini-tts-cheapest-tts-api-2026
- MiniMax 语音定价：https://platform.minimaxi.com/docs/guides/pricing-speech / https://help.aliyun.com/zh/model-studio/minimax-synchronous-speech-synthesis-api
- ElevenLabs 定价：https://texttolab.com/blog/elevenlabs-pricing
- Fish Audio / Cartesia / Deepgram 对比：https://texttolab.com/blog/best-text-to-speech-api
- Gemini 语音生成文档：https://ai.google.dev/gemini-api/docs/speech-generation
