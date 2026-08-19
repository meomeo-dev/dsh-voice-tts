# Fish Audio TTS API

> 证据抓取日期：2026-08-18。官方文档和 302AI Apifox 文档是本 provider 的协议依据；接口字段变化时需重新核对。

## 结论

Fish Audio 不是只能使用参考音频的 TTS。官方 `POST /v1/tts` 在省略 `reference_id` 时使用默认内置音色；也可以把 Voice Library 或自己创建的声音模型 ID 作为 `reference_id`。参考音频是另一条声音克隆路径，官方 API 通过 MessagePack 的 `references` 字段支持即时克隆，本 bundle 当前只接入可持久化声音模型 ID。

官方声音目录不是一个固定的少量系统音色枚举，而是 `/model` 返回的声音模型库。声音模型可以是公开模型、未列出模型或私有模型，详情由 `/model/{id}` 返回；因此运行时目录需要 API key 和分页，而不是只维护静态常量。

## Endpoint

| 能力 | 官方 Fish Audio | 302AI vendor |
|---|---|---|
| TTS | `POST https://api.fish.audio/v1/tts` | `POST https://api.302.ai/fish-audio/v1/tts?response_format=data` |
| 声音列表 | `GET https://api.fish.audio/model` | `GET https://api.302.ai/fish-audio/model` |
| 声音详情 | `GET https://api.fish.audio/model/{id}` | `GET https://api.302.ai/fish-audio/model/{id}` |
| 认证 | `Authorization: Bearer <key>` | `Authorization: Bearer <key>` |
| key name | `TTS_FISH_AUDIO_API_KEY` | `TTS_302AI_API_KEY` |

官方 TTS 返回分块二进制音频。302AI 的 `response_format=data` 表示返回原始音频数据；`response_format=url` 会返回转存 URL，本 provider 使用 `data` 避免额外的 URL 下载和凭据传播。

302AI 文档列出的 TTS body 是 Fish 的公共字段子集；provider 对 302AI 只发送 `text`、`reference_id`、分块、规范化、格式、码率和延迟字段，不发送官方专有的 `prosody` 与高级采样字段。

## Request Mapping

`fish-audio` provider 配置中的 `voice_type` 映射为 `reference_id`，`model` 映射为 `model` 请求头，`format`、`sample_rate`、`mp3_bitrate`、`opus_bitrate`、`latency`、`chunk_length`、`normalize` 和 `prosody` 字段按官方 JSON API 原样映射。官方 `reference_id` 可以留空；302AI 文档把 `reference_id` 标为必需，切换到 302AI vendor 后应选择一个声音模型 ID。

官方模型包括 `s1`、`s2-pro`、`s2.1-pro` 和 `s2.1-pro-free`，其中 `s2.1-pro` 是生产推荐模型，`s2.1-pro-free` 适合测试。302AI 文档声明 `speech-1.5`、`speech-1.6` 和 `s1`，两套模型列表在面板中按当前 vendor 分开显示。

## Voice Directory

`GET /model` 使用 `page_size`、`page_number`、`title`、`tag`、`author_id`、`language` 和 `sort_by` 查询参数。provider 过滤 `type: tts` 项并将 `_id` 映射为 `voice_type`；列表摘要保留 `like_count`、`mark_count`、`shared_count`、`task_count`、`tags`、`languages` 和 `samples[].audio`，供面板筛选、排序、比较和试听；面板通过 `total`/`has_more` 提供分页；完整原始模型字段仍通过声音详情返回。

官方内置默认音色没有可配置的 `reference_id`，面板以“Fish Audio 默认音色”展示，保存时保持 `voice_type: ""`。声音库中的模型和用户创建的克隆模型仍使用真实模型 ID。

## Sources

- [Fish Audio Text to Speech](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)
- [Fish Audio List Models](https://docs.fish.audio/api-reference/endpoint/model/list-models)
- [Fish Audio Get Model](https://docs.fish.audio/api-reference/endpoint/model/get-model)
- [Fish Audio Text to Speech Guide](https://docs.fish.audio/developer-guide/core-features/text-to-speech)
- [302AI TTS](https://302ai.apifox.cn/216669508e0)
- [302AI 获取声音列表](https://302ai.apifox.cn/216670117e0)
- [302AI 获取声音信息](https://302ai.apifox.cn/216668781e0)
