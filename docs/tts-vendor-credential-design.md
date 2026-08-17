# 设计：provider–vendor–credential–params 数据模型与 OpenAI / MiniMax provider 接入

> 状态：设计（实现前定稿）。背景调研见 `docs/tts-openai-minimax-integration.md`，
> 选型见 `docs/tts-provider-comparison.md`。本文定义「一个协议 provider 可接多个 vendor
> （不同 base_url + 不同折扣 api_key）」的数据模型，并据此落地 OpenAI 与 MiniMax 两个 provider。

## 1. 用户故事（user stories）

- **US1 换 vendor 不换 provider**：用户在「openai」provider 下配置了官方 endpoint 和某个
  reseller endpoint 两个 vendor，两者 API 协议相同、仅 `base_url`/`api_key` 不同；切换
  「当前 vendor」即可在同一套合成参数下换源，不改 provider、不改音色映射。
- **US2 每个 vendor 独立凭据**：每个 vendor 存自己的 `api_key`（走 credential 密钥引用，
  不进 settings），互不串用；删掉一个 vendor 不影响其它 vendor。
- **US3 provider 参数与 vendor 解耦**：合成参数（OpenAI 的 `voice/instructions/speed`、
  MiniMax 的 `voice_id/emotion/…`）挂在 provider 上，不随 vendor 变；换 vendor 只改
  `base_url` + key。
- **US4 抗手动改配置**：用户手改 settings 里某个 vendor 缺 `baseUrl`、或 `apiKeyRef` 指向
  一个不存在的密钥、或 `vendor` 指向不存在的 vendor id，插件**不崩**，只在合成时对该次调用
  报可读错误（misconfiguration fails loud at resolve point，不静默回退到另一个 vendor）。
- **US5 音色目录独立**：OpenAI 有固定 13 个音色枚举；MiniMax 音色是开放 id，目录可扩展。
  两者 `listVoices()` 独立、互不污染。

## 2. 数据模型

### 2.1 四个实体与关系

```
Provider（协议，代码，非用户数据）
  ├── 1 : N ── Vendor（一个协议可接多个 vendor：官方 + reseller-a + reseller-b …）
  ├── 1 : N ── Params（该协议支持的合成参数元数据 TunableParam）
  └── 1 : N ── Voice（该协议的音色目录 TtsVoice[]）

Vendor（用户配置）
  ├── provider：属于哪个协议（openai / minimax）
  ├── baseUrl：endpoint 前缀（明文，settings）
  └── apiKeyRef：密钥引用名（KEY NAME，真值在 credentials，不进 settings）

Credential（密钥，运行时）
  └── 由 ctx.credentials.resolve(credentialRef(apiKeyRef)) 解析，与 vendor 通过 apiKeyRef 关联
```

- **Provider** = 代码里的一个 `TtsProvider` 实现（`id`、`synthesize`、`streamSynthesize`、
  `listVoices`、`configTemplate`），**不是用户数据**，不可由配置增删。
- **Vendor** = 用户数据，一个命名的 endpoint+key 组合。`baseUrl` 是明文配置，`apiKey` 是密钥
  → 只存 `apiKeyRef`（KEY NAME），真值经现有 credentials seam 解析。
- **Credential** = 密钥真值，只在 credentials 存储（`.credentials.yaml` / env），settings 永不落密钥。
- **Params** = 协议专属合成参数，用现有 `TunableParam` 元数据驱动 schema/面板/`config --template`。

### 2.2 与现有模型的差异

现状 `VoiceTtsSettings.providers` 里每个 provider 自带一个 `apiKeyRef`（一个 key、一个隐含
base_url）。新模型把「endpoint + key」抽成**独立的 `vendors` 注册表**，provider 只持有合成
参数 + 一个 `vendor` 引用。好处：同一协议换源只改 `vendor` 字段；一个 vendor 的定义集中一处，
可复用、可审计。

## 3. Schema 变更

### 3.1 顶层新增 `vendors` 注册表

```ts
vendors: z.record(z.object({
  label: z.string(),                                  // 展示名
  provider: z.union(['openai', 'minimax'] as const),  // 所属协议
  baseUrl: z.string(),                                 // 明文 endpoint 前缀
  apiKeyRef: z.string(),                              // 密钥引用名（KEY NAME）
})).default({})
```

### 3.2 新增两个 provider config

```ts
providers: {
  // …现有 volcengine / siliconflow-cn / host 不变（本轮不迁移，见 §7 非目标）…
  openai: z.object({
    vendor: z.string().default('302ai-openai'),  // 指向 vendors 里的 id
    model: z.string().default('tts-1'),          // tts-1 / tts-1-hd（302AI 不支持 mini-tts）
    voice_type: z.string().default('alloy'),     // 9 个枚举之一（默认音色走共享 voice_type）
    instructions: z.string().default(''),        // 自然语言控情绪/语速/口音（仅 mini-tts，留空不发送）
    format: z.union(['mp3','opus','aac','flac']).default('mp3'),
    play_format: z.union(['mp3','opus','aac','flac']).default('mp3'),
    speed: z.number().step(0.05).min(0.25).max(4).default(1),
    bilingual: BILINGUAL_SCHEMA,
    voices: voicesSchema(OPENAI_TUNABLE_PARAMS),
    voice_profiles: voiceProfilesSchema(OPENAI_TUNABLE_PARAMS),
  }),
  minimax: z.object({
    vendor: z.string().default('302ai-minimax'),
    model: z.string().default('speech-2.8-turbo'),  // speech-2.8-turbo / speech-2.8-hd / speech-2.6-hd
    voice_type: z.string().default('Chinese (Mandarin)_Reliable_Executive'),
    speed: z.number().step(0.1).min(0.5).max(2).default(1),
    vol: z.number().step(0.1).min(0.1).max(10).default(1),
    pitch: z.number().step(1).min(-12).max(12).default(0),
    emotion: z.string().default(''),
    sample_rate: z.number().step(1).min(8000).max(48000).default(32000),
    format: z.union(['mp3','pcm','flac','wav']).default('mp3'),
    play_format: z.union(['mp3','pcm','flac','wav']).default('wav'),
    bitrate: z.number().step(1).min(32000).max(256000).default(128000),
    channel: z.union([1,2]).default(1),
    bilingual: BILINGUAL_SCHEMA,
    voices: voicesSchema(MINIMAX_TUNABLE_PARAMS),
    voice_profiles: voiceProfilesSchema(MINIMAX_TUNABLE_PARAMS),
  }),
}
```

> 字段说明：OpenAI/MiniMax 的默认音色统一收敛到共享 `BilingualVoiceConfig.voice_type`（与
> siliconflow 一致），协议层再把它映射到 API 的 `voice`（OpenAI）/ `voice_id`（MiniMax）。
> 故 schema 里用 `voice_type`，而非 §3.2 早期草稿的 `voice`/`voice_id`。

### 3.3 合成时的解析链

```
settings.provider（协议，如 'openai'）
  → settings.providers.openai.vendor（vendorId）
  → settings.vendors[vendorId]（{ baseUrl, apiKeyRef }）
  → ctx.credentials.resolve(credentialRef(apiKeyRef))（api_key 真值）
  → provider.synthesize({ text, baseUrl, apiKey, ...params })
```

`provider` 实现从 `resolveApiKey()` 改为 `resolveEndpoint()`：一次解析返回 `{ baseUrl, apiKey }`，
缺 vendor / 缺 key / vendor 不存在时**当场抛可读错误**（US4）。

## 4. Provider 实现（协议层）

- `OpenaiTtsProvider`：`POST {baseUrl}/audio/speech`（`baseUrl` 已含 `/v1`），body
  `{ model, input, voice, response_format, speed }`（`instructions` 留空不发送）；流式走 chunked。
  `listVoices()` 返回 `src/openai-voices.ts` 的 `OPENAI_TTS_1_VOICES`（9 个，tts-1/tts-1-hd）；
  `OPENAI_GPT_4O_MINI_TTS_VOICES`（13 个）供未来启用 mini-tts 时切换。
- `MinimaxTtsProvider`：`POST {baseUrl}/t2a_v2`（302AI 的 DashScope 风格，`baseUrl`
  `https://api.302.ai/minimaxi/v1`），扁平 body `{ model, text, stream, voice_setting,
  audio_setting }`；非流式与流式 `data.audio` 均为 **hex**，统一 hex→bytes。`listVoices()`
  返回 `src/minimax-voices.ts` 的 `MINIMAX_SPEECH_02_TURBO_VOICES`（完整 332 个系统音色；
  `MINIMAX_SPEECH_02_HD_VOICES` 同源）。
- 二者 `configTemplate` 暴露 §3.2 的参数与 vendor 字段，`/dsh-voice-tts config --template` 与面板共享同一份 `TunableParam` 元数据。

> 音色常量命名规范：`<PROVIDER>_<MODEL>_VOICES`（如 `OPENAI_GPT_4O_MINI_TTS_VOICES`、
> `MINIMAX_SPEECH_02_TURBO_VOICES`），文件命名 `<provider>-voices.ts`，与现有
> `src/voices.ts`（volcengine）/ `src/siliconflow-voices.ts` 同构。MiniMax 完整 332 音色
> 已内置（抓取自官方系统音色列表，见 `src/minimax-voices.ts` 头注释）。

## 5. 凭据管理

- `apiKeyRef` 仍是 KEY NAME，复用 `/dsh-voice-tts-key set|unset|status`（它按 provider 的
  当前 vendor 取 apiKeyRef）。**当前实现是 provider 维度**：key 命令对「当前选中的 vendor」
  生效（`apiKeyRefOf` 读 `providers.<id>.vendor` 指向的那条 vendor 的 apiKeyRef）。
  按「任意 vendor」维度 set/unset/status（不切换当前 vendor）**本轮未做**，见 §7 非目标。
- `baseUrl` 是明文，直接写 settings；面板 vendor 区提供 `label/provider/baseUrl/apiKeyRef` 编辑（**未做**，见 §7）。

## 6. 改造面（文件清单）

| 文件 | 动作 |
|---|---|
| `src/types.ts` | 新增 `VendorRecord`、`OpenaiConfig`、`MinimaxConfig`；`VoiceTtsSettings` 增 `vendors` + `providers.openai/minimax` |
| `src/openai.ts` | 新增：OpenAI 协议纯逻辑（请求构造/响应解析/流式/配置模板） |
| `src/minimax.ts` | 新增：MiniMax 协议纯逻辑（同 OpenAI，含 hex 解码） |
| `src/openai-voices.ts` | 新增：`OPENAI_GPT_4O_MINI_TTS_VOICES` / `OPENAI_TTS_1_VOICES`（13 / 9 音色） |
| `src/minimax-voices.ts` | 新增：`MINIMAX_SPEECH_02_TURBO_VOICES` / `MINIMAX_SPEECH_02_HD_VOICES`（seed） |
| `src/provider-openai.ts` / `provider-minimax.ts` | 新增：`TtsProvider` 实现，注入 `resolveEndpoint()` |
| `src/index.ts` | 注册两个 provider；`resolveEndpoint(vendorId)`；SCHEMA/DEFAULT_SETTINGS 增 vendors + 两 provider |
| `src/command.ts` | `renderConfigTemplate`/`renderStatus` 支持 openai/minimax + vendor |
| `src/web-ui/panel/*` | ~~面板增 vendor 管理 + openai/minimax provider 卡片~~ **未做**（backend RPC seam 已就绪，UI 缺 openai/minimax/vendor 卡片，见 §7） |
| `tests/openai.spec.ts` / `tests/minimax.spec.ts` | 新增：请求构造/响应解析/流式 SSE 解析/hex 解码/异常 |
| `docs/tts-vendor-credential-design.md` | 本文 |

## 7. 非目标（本轮不做）

- 迁移现有 `volcengine` / `siliconflow-cn` / `host` 到 vendor 模型（它们仍用旧 `apiKeyRef` 单一 key；vendor 模型先服务新增的 openai/minimax）。
- 音色克隆（ElevenLabs/Fish）、Gemini TTS（多模态语音）——见选型文档，另立需求。
- 逐 vendor 的配额/用量统计。
- **Web 面板的 vendor 管理 + openai/minimax provider 卡片**（backend `PanelDeps` 的
  `listModels`/`listParams` 已支持 openai/minimax，但前端 `App.tsx` 只渲染
  volcengine/siliconflow-cn/host 三张卡片，无 vendor 编辑 UI）。
- **按任意 vendor（非当前 vendor）的 key set/unset/status**（key 命令当前是 provider 维度）。

## 8. 验收标准（AC）

1. `vendors` 可定义多个 vendor，每个含 `label/provider/baseUrl/apiKeyRef`；openai 与 minimax 各能挂多个 vendor。
2. 切换 `providers.<protocol>.vendor` 即可换源，合成参数（voice_type/speed/…）不变。
3. `api_key` 只经 credentials 解析，settings 永不落明文密钥；`/dsh-voice-tts-key` 能对「当前 provider 当前 vendor」set/unset/status（按任意 vendor 维度见 §7 非目标）。
4. OpenAI 合成走 `POST {baseUrl}/audio/speech`（`baseUrl` 含 `/v1`），`tts-1`/`tts-1-hd` 输出 mp3/opus/aac/flac 与流式均正确；9 音色可列。
5. MiniMax 合成走 302AI `/t2a_v2`，非流式与流式 `data.audio` 均 hex 正确还原为音频；`voice_id`/`emotion`/`audio_setting` 生效；SSE 流式兼容 LF/CRLF 分隔且不丢末帧。
6. 缺 vendor / vendor 不存在 / 缺 key / 协议不匹配时合成当场报可读错误（fail loud），不静默回退、不崩。
7. `pnpm test` + `pnpm typecheck` + `pnpm build` 全绿。（面板 vendor 配置 UI 见 §7 非目标。）
