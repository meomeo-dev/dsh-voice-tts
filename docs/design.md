# dsh-voice-tts 设计文档

> **状态:定稿(final)**
> 本文档基于 volcengine TTS 官方文档研究定稿,证据见 `docs/tech_stack/tts/volcengine/`(`api-unidirectional-http.md` + `voices.md`),**过期 D+90 天**(2026-11-12)。

## 1. 定位与发布形式

**结论:dsh-voice-tts 是独立 bundle,不整合进 dsh-voice。**

- 仓库:与 `dsh-voice` 平级的独立仓库 `dsh-voice-tts`。
- 包名:`@meomeo-dev/dsh-voice-tts`,声明 `dsh.bundle.patch`,独立 npm 发布。
- 安装:`dsh plugin --profile <p> add @meomeo-dev/dsh-voice-tts`。

**为什么独立**(而非并进 dsh-voice):

| | dsh-voice | dsh-voice-tts |
|---|---|---|
| 领域 | 文本口吻(system prompt 风格) | 语音合成 + 播放 |
| 网络调用 | 无 | 有(调 TTS provider API) |
| 前端 | 无 | 有(自动/手动播放按钮) |
| 依赖 | handlebars + yaml | HTTP + 音频解码 + UI |

两者是正交能力,各自一个 capability seam,各自一个包。切到某 voice 口吻时是否用对应音色,通过**配置关联**(provider 配置里指定 voice_type)实现,不靠合并。

## 2. capability seam 三段式(遵循 dsh 铁律)

```
dsh-tts          (Service Definition —— TTS registry,ctx.tts)
volcengine-tts   (Provider —— 调 volcengine TTS API)
dsh-tts-player   (Consumer —— 自动播放 / 手动播放按钮 / 命令)
```

- **Service Definition(`dsh-tts`)**:定义 `ctx.tts` 服务、`TtsRequest`/`TtsResult` 词汇类型、provider 注册接口、音色列表查询接口。
- **Provider(`volcengine-tts`)**:实现 volcengine 的合成;换 provider(阿里云/微软)只换这个包。
- **Consumer**:前端播放(自动/手动)+ `/dsh-voice-tts` 命令 + 可能的 model tool。

**打包决策(定稿):首版合包。** 三个角色放在同一个 bundle `@meomeo-dev/dsh-voice-tts` 内按目录分层(`service/`、`provider/volcengine/`、`player/`),而非拆 3 个 npm 包。理由:

- 首版仅一个 provider,三个角色无独立演进节奏;
- 包数少、安装心智简单;
- 若日后 Player 或某 Provider 需独立迭代(如新前端 seam、多 provider),再按 capability seam 拆分,拆包是机械操作、不破坏 seam 三角色结构。

## 3. 配置分层:settings 与 credentials 严格分离

**关键原则:dsh-voice-tts 的普通配置走 settings,敏感凭据走 credentials,两者绝不混。**

### 3.1 settings(普通配置,可 `/config --json` 改)

用户可写、热更新、集中管理的配置,用 `settingsNamespace('voice-tts')`(对齐 dsh-voice 的做法):

```yaml
voice-tts:
  delivery: off                      # turn-final 交付:off / file / host_play / stream
  provider: volcengine               # 当前选中的 provider
  providers:
    volcengine:
      voice_type: zh_female_vv_uranus_bigtts   # speaker(音色 ID),必选
      resource_id: seed-tts-2.0               # X-Api-Resource-Id(模型版本)
      model: ""                              # req_params.model 显式覆盖(通常留空,由 X-Api-Resource-Id 决定;仅旧版 1.0 音色需设如 seed-tts-1.1)
      format: mp3                             # file/stream 落盘格式:mp3/pcm/ogg_opus/wav
      play_format: wav                        # host_play 合成格式(跨平台系统播放器兼容,默认 wav)
      sample_rate: 24000                      # audio_params.sample_rate [8000,48000]
      speech_rate: 0                          # audio_params.speech_rate [-50,100]
      loudness_rate: 0                        # audio_params.loudness_rate [-50,100]
      pitch: 0                                # post_process.pitch [-12,12]
      bilingual: both                         # 双语播报模式:both / english_only / chinese_only
      voices:                                 # 各语言类别音色覆盖(缺省回退 voice_type)
        zh: zh_female_vv_uranus_bigtts
        en: en_male_alex_uranus_bigtts
        mixed: zh_female_vv_uranus_bigtts
```

字段与 volcengine API 的映射(权威见 `api-unidirectional-http.md`):

| settings 字段 | API 位置 | 默认 | 取值范围 | 说明 |
|---|---|---|---|---|
| `delivery` | —(本地策略) | `off` | `off` / `file` / `host_play` / `stream` | turn-final 交付方式(见 §6) |
| `voice_type` | `req_params.speaker` | —(必选) | — | 音色 ID,值见 `voices.md`;双语各语言类别的回退音色 |
| `resource_id` | 请求头 `X-Api-Resource-Id` | `seed-tts-2.0` | `seed-tts-2.0` / `seed-icl-2.0` | 模型版本;复刻音色用 `seed-icl-2.0` |
| `model` | `req_params.model` | `''`(空) | — | 可选显式覆盖;空则不发送(由 `X-Api-Resource-Id` 决定模型)。仅旧版 1.0 音色需设(如 `seed-tts-1.1`);2.0 合成/复刻均勿设 |
| `format` | `audio_params.format` | `mp3` | `mp3`/`pcm`/`ogg_opus`/`wav` | file/stream 落盘格式 |
| `play_format` | `audio_params.format` | `wav` | `mp3`/`pcm`/`ogg_opus`/`wav` | host_play 合成格式(跨平台系统播放器兼容,默认 wav) |
| `sample_rate` | `audio_params.sample_rate` | `24000` | `[8000,16000,22050,24000,32000,44100,48000]` | Hz |
| `speech_rate` | `audio_params.speech_rate` | `0` | `[-50,100]` | 100=2 倍速,-50=0.5 倍速 |
| `loudness_rate` | `audio_params.loudness_rate` | `0` | `[-50,100]` | 100=2 倍音量 |
| `pitch` | `post_process.pitch` | `0` | `[-12,12]` | 音调 |
| `bilingual` | —(本地策略) | `both` | `both` / `english_only` / `chinese_only` | 双语播报过滤(见 §7) |
| `voices` | —(本地策略) | `{}` | `{ zh?, en?, mixed? }` | 各语言类别音色覆盖;缺省回退 `voice_type`,mixed 先回退 zh 再回退 voice_type |

**非目标(首版不进 settings)**:`additions` 里的 `silence_duration`/`disable_markdown_filter`/`disable_emoji_filter`/`explicit_language`/`explicit_dialect`、`context_texts`(语音指令)、`section_id`、`tone_fidelity`、字幕、缓存——这些是进阶能力,后续 provider 扩展时逐个加进 settings,首版只做「文本→音频」。

### 3.2 credentials(API key,绝不进 settings / 硬编码 / 直接读 env)

API key 走 dsh 的 **credentials seam**(`ctx.credentials`),凭证引用名 `VOLCENGINE_TTS_API_KEY`:

- 配置载体只存**引用名**,不存值;运行时每次合成调用 `ctx.credentials.resolve(credentialRef('VOLCENGINE_TTS_API_KEY'))` 解析(对齐 llm-deepseek 的 per-operation resolve 语义)。
- 凭证值存 `$DSH_HOME/.credentials.yaml`(`0600`,owner-only 目录),由 `dsh-credentials-local` provider 托管:
  ```yaml
  # $DSH_HOME/.credentials.yaml
  VOLCENGINE_TTS_API_KEY: <value>
  ```
- credentials-local 的解析链:继承 process env(只读、最高)→ `.credentials.yaml`(可写)→ `<cwd>/.env` / `$DSH_HOME/.env`(回退)。所以凭证**可通过**环境变量 `.env` 覆盖,但插件代码不直接读 `process.env`——它只认 `ctx.credentials.resolve`,这样 `describe()` 能报告「从哪来、可写吗」、轮换凭证不碰配置、settings 文档不含秘密。
- 无 credentials seam 挂载的嵌入场景,才回退读 `process.env[VOLCENGINE_TTS_API_KEY]`(与 llm-deepseek 的 `credentials === undefined` 分支一致)。

> **安全提示**:API key(`X-Api-Key` 头)是敏感凭据。若已在任何对话/日志中暴露,须在 volcengine 控制台**立即轮换**。本插件实现与文档绝不硬编码 key。

## 4. 命令协议

`dsh-voice-tts` 提供 `ctx.commands` 命令(对齐 dsh-voice 的 `/voice`),handler 只读 `invocation.rawInput`。

### 4.1 查询某 provider 完整配置模板

```
/dsh-voice-tts config --template <provider>
```

返回该 provider 的**完整配置模板**:

- **不得省略任何参数**;
- 有默认值的参数**一并展示默认值**;
- 输出为 JSON(供用户复制修改)。

```json
{
  "provider": "volcengine",
  "config": {
    "voice_type":   { "type": "string", "required": true,  "default": null,                        "description": "音色 ID(speaker),值见 voices.md,如 zh_female_vv_uranus_bigtts" },
    "resource_id":  { "type": "string", "required": false, "default": "seed-tts-2.0",              "description": "模型版本;复刻音色用 seed-icl-2.0" },
    "model":        { "type": "string", "required": false, "default": "",                        "description": "req_params.model 显式覆盖(通常留空;仅旧版 1.0 音色需指定,如 seed-tts-1.1)" },
    "format":       { "type": "string", "required": false, "default": "mp3",                       "description": "音频格式 mp3/pcm/ogg_opus/wav(file/stream 落盘)" },
    "play_format":  { "type": "string", "required": false, "default": "wav",                       "description": "host_play 合成格式(跨平台播放器兼容,默认 wav)" },
    "sample_rate":  { "type": "number", "required": false, "default": 24000,                       "description": "采样率 Hz,可选 8000/16000/22050/24000/32000/44100/48000" },
    "speech_rate":  { "type": "number", "required": false, "default": 0,                           "description": "语速 [-50,100],100=2倍速,-50=0.5倍速" },
    "loudness_rate":{ "type": "number", "required": false, "default": 0,                           "description": "音量 [-50,100],100=2倍音量" },
    "pitch":        { "type": "number", "required": false, "default": 0,                           "description": "音调 [-12,12]" },
    "bilingual":    { "type": "string", "required": false, "default": "both", "enum": ["both","english_only","chinese_only"], "description": "双语播报模式;混合句永远整句读" },
    "voices":       { "type": "object", "required": false, "default": null,                        "description": "各语言类别音色覆盖 { zh, en, mixed },缺省回退 voice_type" }
  },
  "credentials": {
    "apiKeyRef": "VOLCENGINE_TTS_API_KEY"
  }
}
```

### 4.2 用户修改配置

```
/dsh-voice-tts config --json <json>
```

把 `<json>` 解析为配置并写入 settings。

### 4.3 其它子命令

```
/dsh-voice-tts status                 # 当前 provider / autoplay / 配置概览
/dsh-voice-tts list-voices [provider] # 列出可用音色(场景/音色名/voice_type/语言/是否支持指令)
/dsh-voice-tts config --json <json>   # 覆盖配置
```

## 5. JSON 转义探针结论(已定稿)

**结论:`rawInput` 是字面值(verbatim),无任何转义。** 证据来自 dsh 命令链的三处源码(只读,未改 dsh 代码):

1. **命令解析器** `packages/interaction/commands/src/index.ts:102-109` —— `parseCommand(line)` 用 `rawInput = line.slice(match[0].length)`,其中 `match[0]` = `/name`(尾随分隔符用 lookahead `(?=$|[\t\n\r ])` 不消费)。**纯切片,零转义**。测试 `commands.spec.ts:42-45` 直接断言换行/制表符原样保留(如 `/goal\ncreate the thing` → `rawInput: '\ncreate the thing'`)。
2. **浏览器客户端组装** `packages/client/ui-commands/src/client/service.ts:352-359` —— `leadingClaim` 用 `submit: (args) => execute(session, token + args)`,其中 `token = '/<name> '`,`args` 是用户在 composer 键入的原始文本,`+` 直接拼接。
3. **执行入口** `commands.execute(agent, line, signal)` —— `line` 原样传给 `parseCommand`,`rawInput = line.slice(match[0].length)`,全程无 JSON/引号/反斜杠处理。

**含义**:用户输入是 composer 文本,不经过 shell,不存在 shell 转义。`/dsh-voice-tts config --json {"a":1}` 到达 handler 时 `rawInput` 就是 ` config --json {"a":1}`(`{` 原样)。因此:

- **解析策略**:handler 里对 `rawInput.trim()` 做子命令分派,取 `--json` 之后的子串直接 `JSON.parse`,**无需逆转义**。
- 用户若手工写了 `{\"a\":1}`(带反斜杠),那反斜杠也是字面字符,`JSON.parse` 会失败——这是**正确的**行为(报错提示用户去掉转义),而非需要我们去转。

## 6. turn-final 交付(delivery)

`delivery` 决定每轮 turn 结束后如何交付最终回复的音频。四种模式:

| delivery | 行为 | 音频终点 | 现状 |
|---|---|---|---|
| `off` | 不处理 | — | ✅ |
| `file` | 合成完整 → 落盘 `dsh-voice-tts-turn-<n>.<format>` | 文件系统 | ✅ |
| `host_play` | 合成(`play_format`)→ 落盘 → 本机系统播放器播放 | host 进程所在机器的扬声器 | ✅ |
| `stream` | 流式合成(逐分片)→ 当前落盘;前端消费未来接 | 未来:浏览器 | 后端✅ / 前端待 dsh audio seam |

**触发**:监听 `session/event` 的 `turn/end`(`dsh-session` 公开事件,`agent-instructions` 同款接缝),提取该 turn 最后一条带可见文本的 `assistant/message`,按 `delivery` 交付。合成/交付失败仅 `logger.warn`,不阻断会话。全部纯插件实现,不入侵 dsh 源码。

**`host_play` 的语义边界**:它让「host 进程所在的机器」发声,不是「浏览器所在的设备」。个人 PC 上 `dsh web`(host=本机=浏览器)才能听见;远程/容器部署时 host 无扬声器,此模式无效——此时只有 `file`(下载后本地播)或未来 `stream`(前端播)有意义。

**`play_format` 默认 wav**:macOS `afplay`/Linux `aplay`/Windows `SoundPlayer` 三个系统播放器都能直接播 wav(未压缩 PCM),无需额外解码器。mp3/ogg_opus 在部分平台(如 `aplay`)不被原生支持。

**`stream` 的缺口(需改 dsh 源码,超出「不入侵」边界)**:dsh web 目前**没有音频播放接缝**——`@deepseek-ai/dsh-attachment` 明确仅支持 image(PNG/JPEG/WebP/GIF),其「Known Limitations」写明 audio/video 是 deferred;`packages/client` 内 `audio`/`play(` 零命中。`stream` 模式已实现后端流式合成(`ctx.tts.stream()` 返回 `AsyncIterable<TtsChunk>`),前端 `<audio>` 消费端待 dsh 上游补 audio seam 后再接。

## 7. 双语播报(bilingual)

`bilingual` 模式 + 多音色让「连续可识别的双语文本」按语言分句、按期望播报。

### 语义

1. **切分 + 判定**:文本先按段落/句末符切句,每句判定语言:
   - `zh` — 纯中文(无拉丁字母)
   - `en` — 纯英文(无 CJK 字符)
   - `mixed` — 同时含中英(中英混写)
   英文句界识别对常见缩写(`Mr.` `Dr.` `e.g.` `U.S.`)与小数(`3.14`)做了抑制,避免误切。
2. **过滤(`bilingual`)**:
   - `both` — 全读
   - `english_only` — 读英文句 + 混合句
   - `chinese_only` — 读中文句 + 混合句
   - **混合句永远整句读,不做过滤**——它无法干净地归入单一语言,故默认完整阅读。
3. **多音色(`voices`)**:每个语言类别可配独立音色,缺省回退 `voice_type`:
   - 中文句 → `voices.zh ?? voice_type`
   - 英文句 → `voices.en ?? voice_type`
   - 混合句 → `voices.mixed ?? voices.zh ?? voice_type`
4. **合成**:相邻同音色的句子合并为一次 API 调用(减少往返),按序拼接为最终音频。

### 触发面

- 当前:`/dsh-voice-tts speak <text>` 走双语管线。
- 将来:final-response 自动播报复用同一管线(纯函数 `planBilingualSpeech`,在 `bilingual.ts`)。

## 8. 音色数据

volcengine 音色列表已整理为权威参考:

- 权威来源:`docs/tech_stack/tts/volcengine/voices.md`(步骤 2 已下载整理)。
- 运行时:Provider 内置一份音色表,供 `list-voices` 查询与 config 校验。

音色四类(详见 `voices.md`「关键结论」):

| 家族后缀 | 类型 | 资源头 | 数量 |
|---|---|---|---|
| `uranus_bigtts` | 2.0 标准 / 多语种 | `seed-tts-2.0` | 93 + 137 |
| `_tob`(`ICL_uranus_*_tob`) | 声音复刻 | `seed-icl-2.0` | 200 |
| `mars/moon/wvae_bigtts` | 多情感(emotion) | `seed-tts-2.0` | 135 |

首版 provider 只支持 **`seed-tts-2.0` 标准 + 多语种**;声音复刻与多情感列为后续扩展(见 §10 非目标)。

## 9. 文档证据

- 技术文档:`docs/tech_stack/tts/volcengine/api-unidirectional-http.md`(接口/参数/鉴权)。
- 音色列表:`docs/tech_stack/tts/volcengine/voices.md`(场景/音色名/voice_type/语言)。
- **过期时间:D+90 天**。今天 2026-08-14 → 过期 2026-11-12。过期后需重新抓取核对。

## 10. 待定项(收敛结果)

研究 volcengine 文档后,可收敛的已收敛;依赖 dsh 代码库运行时行为的仍标注为实现首步待办。

1. ~~seam 三段式是否拆 3 个包~~ → **首版合包**(见 §2),日后再按需拆。
2. ~~volcengine 具体 config schema~~ → **已定**(见 §3.1 / §4.1),字段与取值范围来自 `api-unidirectional-http.md`。
3. ~~默认音色~~ → **`zh_female_vv_uranus_bigtts`(Vivi 2.0,2.0 标准首个通用女声)**。用户可改。
4. **浏览器发声(音频播放)**——仍待办:需 dsh 侧新建 audio seam(attachment 仅 image、client 无 audio),超出本 bundle「不入侵 dsh 源码」边界。已交付「turn 结束自动合成写文件」作为后端半程。
5. ~~JSON 转义探针结论~~ → **已定**:`rawInput` 字面值,直接 `JSON.parse`(见 §5)。
6. ~~是否提供 model-facing 的 TTS tool~~ → **首版仅人工命令触发**,不做 model tool(见 §10)。

## 11. 非目标(首版)

- 不做流式 TTS / 实时字幕对齐。
- 不做多 provider(先仅 volcengine)。
- 不做语音识别(ASR),只做 TTS。
- 不做声音复刻(`seed-icl-2.0`)与多情感(`mars/moon/wvae`)音色。
- 不做 `additions` 进阶参数(silence/markdown/emoji/dialect)、`context_texts` 语音指令、`section_id`、`tone_fidelity`、字幕、缓存。
- 不做 model-facing 的 TTS tool(仅人工命令)。
- 不做 `stream` 的前端 `<audio>` 播放(待 dsh 上游 audio seam)。
- 不硬编码 API key、不走环境变量注入 provider 普通配置。

## 12. 验收标准(AC)

1. `dsh plugin --profile <p> add @meomeo-dev/dsh-voice-tts` 可安装,`voice-tts` 插件挂载。
2. `/dsh-voice-tts config --template volcengine` 返回**完整**配置模板(不省略参数、含默认值),字段与 §4.1 一致(含 `play_format`)。
3. `/dsh-voice-tts config --json '<json>'` 可写回 settings,转义/非转义均正确解析(以 §5 探针结论为准)。
4. API key 从 credentials 解析(`X-Api-Key` 头),不进 settings / 不进 session log / 不进 process env。
5. `POST .../tts/unidirectional` 请求头带 `X-Api-Key` + `X-Api-Resource-Id` + `X-Api-Request-Id`(uuid),`speaker` = 配置的 `voice_type`。
6. `delivery` 四态可配置且热更新:`off` 不处理;`file` 落盘;`host_play` 落盘 + 本机播放(`play_format`);`stream` 流式合成落盘。
7. `/dsh-voice-tts list-voices volcengine` 列出音色(场景/音色名/voice_type/语言/是否支持指令)。
8. provider 选择、普通配置走 settings,热更新生效。
9. `/dsh-voice-tts speak <双语文本>` 按 §7 语义:切句→判定语言→`bilingual` 过滤(混合句永远读)→按 `voices` 分配音色→相邻同音色合并→拼接输出;`bilingual=english_only` 时纯中文句被跳过。
10. `speak [--delivery <mode>]` 支持交付覆盖,缺省用 `settings.delivery`。
11. `delivery≠off` 时,`turn/end` 触发:提取该 turn 最终可见 assistant 文本(跳过 tool-call-only 消息)→ 双语管线合成 → 按 delivery 交付;`delivery=off` 时不处理。
