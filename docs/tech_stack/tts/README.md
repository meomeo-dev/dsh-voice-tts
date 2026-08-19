# TTS 技术资料索引

这里保存 `dsh-voice-tts` 各 provider 的外部 API 证据、字段映射和声音目录资料。实现代码的行为以测试和源码为准，本文档记录外部服务的可复核事实。

## 目录约定

每个 provider 使用一个子目录 `docs/tech_stack/tts/<provider>/`。

- `api*.md`：endpoint、认证、请求/响应字段、限制和抓取日期。
- `voices*.md`：静态音色表或远程声音目录字段、映射规则和模型筛选规则。
- `integration*.md`：同一协议接入多个 vendor 时的 endpoint、key name 和差异。
- 外部文档发生变化时，更新原文档的抓取日期、过期日期和实现测试，不在 README 复制字段表。

## Provider 资料

| Provider | 资料 | 目录类型 |
|---|---|---|
| volcengine | [单向流式 HTTP](volcengine/api-unidirectional-http.md)、[音色列表](volcengine/voices.md) | 静态参考表 |
| Fish Audio | [官方 API / 302AI vendor / 声音目录](fish/api.md) | 远程分页目录 + 官方默认音色 |

OpenAI、MiniMax 和 SiliconFlow 的协议说明分别维护在 provider 源码头部注释、README 和现有集成文档中；新增独立外部 API 证据时按上面的子目录规则归档。
