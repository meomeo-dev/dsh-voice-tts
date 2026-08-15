# dsh-voice-tts

DeepSeek Harness 的 **TTS 语音合成** bundle:文本 → 语音。独立于 [dsh-voice](https://github.com/meomeo-dev/dsh-voice),只做「语音合成」,不管「文本口吻」。

## 状态

**首版已实现(可运行)**:capability seam 三段式 + volcengine provider + `/dsh-voice-tts` 命令 + bilingual 双语播报 + **turn-final 交付**(`delivery: off|file|host_play|stream`)。

**`stream` 的前端 `<audio>` 播放尚未实现**:dsh web 无 audio 接缝(attachment 仅 image、client 无 audio),需 dsh 本体新增,超出本 bundle「不入侵 dsh 源码」边界。`stream` 的后端流式合成已就绪。见 [docs/design.md §6](docs/design.md)。

## 定位

- 独立 npm bundle(`@meomeo-dev/dsh-voice-tts`),与 dsh-voice 平级。
- capability seam 三段式:Service Definition(`ctx.tts`)/ Provider(`volcengine-tts`)/ Consumer(`/dsh-voice-tts` 命令)。
- 首个 provider 仅支持 **volcengine**(`seed-tts-2.0` 标准 + 多语种音色)。
- 普通配置走 settings,API key 走 credentials(绝不硬编码 / 环境变量)。

## 已实现

- **服务**:`ctx.tts` 注册表(provider 注册/委托合成/流式合成/查音色)。
- **provider**:volcengine 单向流式 HTTP 合成(`POST .../tts/unidirectional`),NDJSON 流式响应解析 + 逐分片流式合成。
- **命令** `/dsh-voice-tts`:
  - `status` — 当前 provider / delivery / 配置概览
  - `list-voices [provider] [query]` — 列出音色(可按 voice_type/名称/场景/语种过滤)
  - `config --template [provider]` — 输出完整配置模板(JSON)
  - `config --json <json>` — 覆盖 provider 配置
  - `speak [--delivery <mode>] <text>` — 合成文本并按 delivery 交付(缺省读 settings.delivery)
- **bilingual 双语播报**:按句切分判定 `zh`/`en`/`mixed`,按 `bilingual=both|english_only|chinese_only` 过滤(混合句永远整句读),`voices:{zh,en,mixed}` 多音色。
- **turn-final 交付**:`delivery≠off` 时,监听 `session/event` 的 `turn/end`,每轮结束提取最终 assistant 文本按 delivery 交付(纯插件,不改 dsh 源码)。

## 配置

```yaml
voice-tts:
  delivery: off              # turn-final 交付:off / file / host_play / stream
  provider: volcengine
  providers:
    volcengine:
      voice_type: zh_female_vv_uranus_bigtts
      resource_id: seed-tts-2.0       # seed-tts-2.0 / seed-icl-2.0
      model: ""                       # 显式覆盖;通常留空(由 resource_id 决定)
      format: mp3                     # file/stream 落盘格式
      play_format: wav                # host_play 合成格式(默认 wav,跨平台播放器兼容)
      sample_rate: 24000
      speech_rate: 0
      loudness_rate: 0
      pitch: 0
      bilingual: both                 # both / english_only / chinese_only
      voices:                         # 各语言类别音色,缺省回退 voice_type
        zh: zh_female_vv_uranus_bigtts
        en: en_male_alex_uranus_bigtts
        mixed: zh_female_vv_uranus_bigtts
```

> `host_play` 让「host 进程所在的机器」发声(个人 PC 上 `dsh web` 才能听见),不是「浏览器所在设备」;远程/容器部署时此模式无效。

完整配置语义与验收标准见 [docs/design.md](docs/design.md)。

## 凭据

API key 存 `$DSH_HOME/.credentials.yaml`(0600),引用名 `VOLCENGINE_TTS_API_KEY`,不进 settings / 环境变量 / session log。

## 文档证据

技术文档与音色列表在 `docs/tech_stack/tts/volcengine/`,**过期 D+90 天**(2026-08-14 → 2026-11-12)。
