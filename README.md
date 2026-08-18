# dsh-voice-tts

DeepSeek Harness 的 **TTS 语音合成** bundle:文本 → 语音。独立于 [dsh-voice](https://github.com/meomeo-dev/dsh-voice),只做「语音合成」,不管「文本口吻」。

## 状态

**已实现(可运行)**:capability seam 三段式 + **多 provider**(volcengine + siliconflow-cn)+ `/dsh-voice-tts` 命令 + Web 配置面板 + bilingual 双语播报 + **turn-final 交付**(`delivery: off|file|host_play|stream`)。

**`stream` 的前端 `<audio>` 播放尚未实现**:dsh web 无 audio 接缝(attachment 仅 image、client 无 audio),需 dsh 本体新增,超出本 bundle「不入侵 dsh 源码」边界。`stream` 的后端流式合成已就绪。见 [docs/design.md §6](docs/design.md)。

## 定位

- 独立 npm bundle(`@meomeo-dev/dsh-voice-tts`),与 dsh-voice 平级。
- capability seam 三段式:Service Definition(`ctx.tts`)/ Provider(`volcengine-tts`、`siliconflow-tts`)/ Consumer(`/dsh-voice-tts` 命令 + Web 面板)。
- 普通配置走 settings(按 provider 各一份),API key 走 credentials(每 provider 一个 KEY NAME,绝不硬编码)。

## 已实现

- **服务**:`ctx.tts` 注册表(provider 注册/委托合成/流式合成/查音色)。
- **providers**:
  - **volcengine**:单向流式 HTTP 合成(`POST .../tts/unidirectional`),NDJSON 流式响应解析 + 逐分片流式合成。
  - **siliconflow-cn**:Bearer 鉴权 + 二进制/流式响应(`POST .../v1/audio/speech`),CosyVoice2-0.5B 8 个预设音色。
  - **host**:本地命令行合成(`macOS say`),输出 AIFF,无需 API key。
  - **openai**:OpenAI 兼容 `POST /v1/audio/speech`(tts-1 / tts-1-hd),经 vendor 表解析 baseUrl + key。
  - **minimax**:DashScope 风格 `POST /minimaxi/v1/t2a_v2`(speech-2.8-turbo),hex 音频 + SSE 流式,经 vendor 表解析 baseUrl + key。
- **命令** `/dsh-voice-tts`:
  - `status` — 当前 provider / delivery / 各 provider 配置概览
  - `use <provider>` — 切换当前 provider
  - `list-voices [provider] [query]` — 列出音色(可按 voice_type/名称/场景/语种过滤)
  - `config --template [provider]` — 输出完整配置模板(JSON)
  - `config --json <json>` — 覆盖「当前 provider」配置
  - `speak [--delivery <mode>] <text>` — 合成文本并按 delivery 交付(缺省读 settings.delivery)
  - `ui` — 打印 Web 配置面板 URL
- **Web 配置面板**(`/voice-tts`):active provider 选择 + 每 provider 一张卡片(含 KEY NAME 下拉 + 值掩码管理)+ voice_profiles 行编辑器。
- **bilingual 双语播报**:按句切分判定 `zh`/`en`/`mixed`,`both` 播报全部类别,`english_only` 仅播报纯英文句,`chinese_only` 仅播报纯中文句,`voices:{zh,en,mixed}` 多音色。
- **per-voice 音色映射**(`voice_profiles`):软读 dsh-voice 当前口吻 id(`voice.tone`),按 id 命中整套 `voices` 覆盖,未命中回退全局 `voices`。
- **槽位可调参数**:`voices`/`voice_profiles` 的每个语言槽位是 `{ voice_type, ...可调参数 }`,槽位未写的参数回退 provider 顶层字段(volcengine:`pitch`/`speech_rate`/`loudness_rate`;siliconflow-cn:`speed`/`gain`),用于补偿不同音色之间的响度/语速差异。
- **turn-final 交付**:`delivery≠off` 时,监听 `session/event` 的 `turn/end`,每轮结束提取最终 assistant 文本按 delivery 交付(纯插件,不改 dsh 源码)。
- **Web UI 入口**(slot 化,与 dsh-voice 共存):header 的 🔊 下拉(Set voice tts / Turn on-off / Stop host play)挂在 `conversation.session.header.actions`;新建会话 hero 屏的 🔊 回落挂在 `conversation.hero.voice`,并把 TTS 条目注入 dsh-voice 的 `voice.hero.menu`(有 dsh-voice 时回落返回 null 不重复图标)。
- **turn-tail 播放控制器**:吸附在每条回复末尾,三态(空闲 / 浏览器 `<audio>` 播放 / host 播放)渲染播放/暂停/停止 + 进度;host_play 暂停/恢复/seek 由 ffplay 后端支撑,页面刷新后仍可读到并停掉 host 播放。
- **API key 命令** `/dsh-voice-tts-key set|unset|status [provider]`:收敛到 credentials seam,`recordInput:false`,按 provider 的 KEY NAME 管理,`status` 不回显值。

## 配置

```yaml
voice-tts:
  delivery: off              # turn-final 交付:off / file / host_play / stream
  provider: volcengine       # 当前 provider
  providers:
    volcengine:
      apiKeyRef: VOLCENGINE_TTS_API_KEY   # KEY NAME(凭证引用名,值在 credentials)
      voice_type: zh_female_vv_uranus_bigtts
      resource_id: seed-tts-2.0       # seed-tts-2.0 / seed-icl-2.0
      model: ""                       # 显式覆盖;通常留空(由 resource_id 决定)
      format: mp3                     # file/stream 落盘格式
      play_format: wav                # host_play 合成格式(默认 wav)
      sample_rate: 24000
      speech_rate: 0
      loudness_rate: 0
      pitch: 0
      bilingual: both                 # both / english_only / chinese_only
      voices:                         # 各语言类别槽位(缺省回退 voice_type);每槽可带可调参数
        en: { voice_type: en_male_alex_uranus_bigtts, loudness_rate: 40 }
      voice_profiles: {}              # 按 dsh-voice id 映射整套 voices(槽位形状同 voices)
    siliconflow-cn:
      apiKeyRef: SILICONFLOW_API_KEY  # KEY NAME
      voice_type: FunAudioLLM/CosyVoice2-0.5B:alex
      model: FunAudioLLM/CosyVoice2-0.5B
      format: mp3                     # mp3 / opus / wav / pcm
      play_format: wav
      sample_rate: 32000
      speed: 1                        # [0.25, 4.0]
      gain: 0                         # dB [-10, 10]
      bilingual: both
      voices: {}                      # 槽位形状同 volcengine,可调参数为 speed/gain
      voice_profiles: {}
```

> `host_play` 让「host 进程所在的机器」发声(个人 PC 上 `dsh web` 才能听见),不是「浏览器所在设备」;远程/容器部署时此模式无效。

完整配置语义与验收标准见 [docs/design.md](docs/design.md)。

## 凭据

API key 走 dsh 的 **credentials seam**,每个 provider 配置里只存 **KEY NAME(`apiKeyRef`)**,值存 `$DSH_HOME/.credentials.yaml`(0600):

```yaml
VOLCENGINE_TTS_API_KEY: <value>
SILICONFLOW_API_KEY: <value>
```

不进 settings / session log / 不硬编码。credentials-local 会回退到 process env / `.env`,但插件代码不直接读 `process.env`。

可用命令按 provider 管理 key(`recordInput:false`,`set` 的 value 不进 session log):

```
/dsh-voice-tts-key set [provider] <value>   # 写 .credentials.yaml,缺省当前 provider
/dsh-voice-tts-key unset [provider]         # 删除
/dsh-voice-tts-key status [provider]        # 只报 KEY NAME / configured/source,不回显值
```

## 文档证据

volcengine 技术文档在 `docs/tech_stack/tts/volcengine/`,**过期 D+90 天**(2026-08-14 → 2026-11-12);siliconflow 见 https://api-docs.siliconflow.cn/docs/api/audio-speech-post 与 https://api-docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech。
