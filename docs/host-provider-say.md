# host provider — 本地命令行 TTS(macOS `say`)

## 背景

dsh-voice-tts 现有两个云 TTS provider(volcengine、siliconflow-cn),都走 HTTP API + API key。
本设计新增一个 **host provider**:不联网,由 host 进程调用本机命令行工具合成语音。
当前只验证 **macOS + `/usr/bin/say`** 一个选项;用户选中 `host` 后,可配置命令路径(默认
`/usr/bin/say`)、音色名与语速,之后 `speak` / turn-final 交付走本地合成。

## 机制

`host` 是第三个 `TtsProvider` 实现,接入既有 capability seam(`ctx.tts` 注册表),不新增
角色:

- **合成**:`say` 从 stdin 读文本、把音频写到 `-o` 指定文件。provider 在临时目录
  `mkdtemp` 出一个输出文件、spawn `say`(文本走 stdin,规避 ARG_MAX 与 shell 转义),
  退出码 0 后读回字节、清理临时目录,返回 `TtsResult { audio, format: 'aiff', textWords: 0 }`。
- **音色**:`voice_type` 即 `say -v <voice>` 的音色名(空 = 系统默认)。`listVoices()` 用
  `say -v '?'` 同步列出本机音色(失败/非 macOS 回退空表)。
- **双语/映射**:`HostConfig` 仍继承 `BilingualVoiceConfig`——`bilingual` 过滤、
  `voices`(按语言)、`voice_profiles`(按 dsh-voice id)与另两个 provider 完全一致,
  复用 `planBilingualSpeech` 的既有管线;未配置时全部回退 `voice_type`。
- **无凭证**:本地命令无需 API key,`apiKeyRef` 缺席;`dsh-voice-tts-key` 对 `host` 报错。
- **交付**:复用 `file` / `host_play` / `stream` 三种交付。`host_play` 用既有
  `PlayerQueue`(`afplay` 播放 AIFF);`stream` 退化为「合成一次、单分片」(say 不流式)。

## 配置形状

```yaml
voice-tts:
  provider: host
  providers:
    host:
      command: /usr/bin/say   # 本地 TTS 命令绝对路径
      voice_type: ''          # say 音色名(空 = 系统默认)
      rate: 175               # 语速 words per minute(-r)
      bilingual: both
      voices: {}              # { zh?, en?, mixed? },槽位 { voice_type }
      voice_profiles: {}      # { <voice-id>: { zh?, en?, mixed? } }
```

无 `apiKeyRef`、无 `format`/`play_format`(say 恒输出 AIFF,`afplay` 原生播放)。

## 文件清单

- `src/host.ts` — 纯逻辑:`HOST_CONFIG_TEMPLATE`、`buildSayArgs`、`synthesizeSay`、
  `parseSayVoices`、`resolveHostConfig`、常量。
- `src/provider-host.ts` — `HostTtsProvider`(`TtsProvider` 实现)。
- `src/types.ts` — 新增 `HostConfig`;`VoiceTtsSettings.providers` 增 `host`。
- `src/index.ts` — SCHEMA / DEFAULT_SETTINGS / `deliveryView` / `synthConfig` /
  `apiKeyRefOf` / 注册 provider。
- `src/command.ts` — `renderConfigTemplate` / `renderStatus` 增 `host` 分支;USAGE 更新。
- `src/web-ui/panel/src/api.ts` + `App.tsx` — 面板增 `host` 选项与配置卡片。
- `tests/host.spec.ts` — `parseSayVoices` / `buildSayArgs` / `resolveHostConfig` / `synthesizeSay`(fake spawn)。

## 验收标准(AC)

1. `/dsh-voice-tts use host` 切换后,`status` 显示 `provider: host` 与 host 配置(command / voice_type / rate)。
2. `/dsh-voice-tts config --template host` 输出含 `command` / `voice_type` / `rate` 的模板。
3. `/dsh-voice-tts speak hello` 在 host provider 下用 `say` 合成 AIFF 并交付(host_play 用 afplay 播放)。
4. turn-final 交付(非 off)在 host provider 下走本地 say 合成。
5. `/dsh-voice-tts list-voices host` 列出本机 `say -v '?'` 的音色;非 macOS / 无 say 回退空表不抛错。
6. `config --json '{"command":"/usr/bin/say","rate":200}'` 能改命令路径与语速。
7. `dsh-voice-tts-key` 对 host 报「无 API key」,不崩溃。

## 非目标

- 不做 Windows / Linux 本地 TTS 适配(当前仅 macOS `say`)。
- 不做 `say` 的流式输出(say 不流式,`stream` 交付退化为单分片)。
- 不做 say 音色的网络下载 / 管理(只列出本机已装音色)。
- 不改 volcengine / siliconflow 的既有行为。
