# 设计：音频落盘目录、catalog 与统一播放权威（audio-storage-and-playback）

> 状态：设计（实现前定稿）。本文取代 `docs/turn-tail-player.md` 里的「内存注册表 + session cwd 落盘」方案，把音频文件与 turn 的绑定、存储目录、播放状态做成持久、可管理、跨 host_play / stream / UI 播放三模式统一的基础设施。dsh-memory 的 `lmemory/` + `catalog.json` + `registry.json` 模型是本文的直接参照。

## 1. 背景与缺陷

上一版（turn-tail 播放控制器）有四处基础性缺陷，皆源于「音频文件写在 session cwd、turn→文件映射只在进程内存里、播放状态只活在浏览器 React 组件里」：

1. **音频文件与 turn 无持久绑定**：落盘在 `session.header.cwd`（当前是 `~/Downloads/deepseek_sandbox/`），turn→文件映射是 `Map<string, TurnAudioEntry>`，进程重启即失忆——刷新/重启后浏览器无法回放、`regenerate` 只能靠 live session 重建。
2. **无统一存储目录、无 catalog**：文件散落在各会话 cwd；没有像 dsh-memory 那样「user 默认 / 仓库 / 会话自定义（可配置）」的目录层级，也没有可重建的 catalog 索引。
3. **播放状态不持久**：host_play 用 `afplay` 子进程在 host 发声，但该状态只被 `PlayerQueue.isPlaying()` 粗略暴露，且无「哪个 turn 在播、进度多少、能否停」的单一真相源；页面刷新后 UI 完全看不到也停不掉正在响的 host_play。
4. **三模式播放状态未统一**：host_play（host afplay）、未来 stream（流式）、UI 播放文件（浏览器 `<audio>`）三套播放状态互不相通，导致 turn-tail 处只有 ▶、看不到暂停/进度。

## 2. 目标

- 音频落盘进入**统一存储目录**，层级 = 用户默认 / 仓库 / 会话自定义（可配置）。
- dsh-voice-tts **自动管理 catalog**：turn→音频文件的持久、可重建索引，重启后仍能定位每个 turn 的音频。
- 引入 host 侧**单一播放权威**（PlaybackController），host_play / stream / UI 播放三模式统一向它上报、从它读取；页面刷新后仍能读取并停止 host_play。
- turn-tail 控制器按「当前谁在播」渲染正确的播放/暂停/进度，而非固定只显示 ▶。

## 3. 存储层（`storage.ts` + `catalog.ts`，纯 node 逻辑，不 import cordis）

### 3.1 目录层级（镜像 dsh-memory `memory-file.ts`）

| 层级 | 路径 | 触发 |
|---|---|---|
| 用户默认 | `~/.dsh/voice-tts/` | 默认（`storage.scope='user'` 或无项目根） |
| 仓库（project） | `<repo>/.dsh/voice-tts/` | `storage.scope='project'` 且 session cwd 在 git 仓库内（`findProjectRoot` 以 `.git` 标记） |
| 会话自定义 | settings `storage.dir`（绝对路径） | 用户显式配置，优先级最高 |

解析函数 `storageRootFor(cwd, storage)`：`storage.dir` 非空 → 直接用；否则 `storage.scope === 'project'` → `<findProjectRoot(cwd)>/.dsh/voice-tts`（非仓库回退 user），`'user'`（默认）→ `~/.dsh/voice-tts`。`~/.dsh` 解析支持 `DSH_HOME` 覆盖（与 dsh-memory `dshHome()` 同构）。

> 默认用户级：每个仓库要「存仓库本地」才设 `scope='project'`。因为 `findProjectRoot` 按 `.git` 定位，各仓库落在**各自**的 `.dsh/voice-tts/`，天然互不影响、互不串音。「repo A 走 project、repo B 走 user」的逐仓库粒度需 per-workspace 设置覆盖（dsh-settings 当前只有 namespace 的 user 层 + composition base，无 workspace/session scope），本轮以 `storage.dir` 显式覆盖兜底，逐仓库粒度记为后续扩展。

> 说明：dsh-voice 已占用 `~/.dsh/voice/`（音色库），TTS 音频用 `~/.dsh/voice-tts/`，二者不冲突。

### 3.2 文件布局

```
<root>/<sessionId>/turn-<n>[-<i>].<format>
```

- 按 sessionId 建子目录：避免多会话同名覆盖；也让 catalog 的磁盘重建可被 session 前缀定位。
- 多 run（双语分片不同音色）保持 `-0`/`-1`/… 序号；单 run 不带序号。

### 3.3 catalog（派生索引，真相源 = 磁盘音频文件）

每根目录一个 `catalog.json`（formatVersion=1，全量重写、可重建）：

```json
{
  "formatVersion": 1,
  "entries": [
    {
      "sessionId": "session-…",
      "turn": 3,
      "files": [{ "file": "session-…/turn-3-0.aiff", "format": "aiff", "bytes": 76772, "durationMs": 4200 }],
      "createdAt": 1786000000000,
      "provider": "host",
      "delivery": "file"
    }
  ]
}
```

- 真相源是磁盘音频文件；`catalog.json` 是可重建的快速索引。定位一个 turn = `catalog.lookup(sessionId, turn)` → `files[]`。
- **重建**（`rebuildCatalog(root)`）：扫描 `<root>/<sessionId>/turn-*.{wav,aiff,mp3,opus,pcm}` 正则回填 entries；`format` 从扩展名、`durationMs` 从容器头（WAV/AIFF 可解析；mp3/opus/pcm 记 null，由浏览器 `<audio>` 或 afinfo 补）。每次写盘后增量 upsert 该 entry 并重写 catalog（与 dsh-memory「jsonl 是真相源、catalog 全量重写」一致）。
- **`durationMs` 解析**：`audioDurationMs(bytes, format)` 纯函数——WAV（RIFF/fmt/data）与 AIFF（FORM/COMM）从采样率 + 帧数算时长；其余格式返回 null。host provider 产物恒为 AIFF，故 host_play 的进度时长可精确。

### 3.4 迁移与清理

- 旧散落文件（session cwd 下的 `dsh-voice-tts-session-*-turn-*.{wav,aiff}`）**不自动迁移**：它们没有统一根、无法可靠归属。提供 `/dsh-voice-tts catalog rebuild` 与手动清理说明；新合成一律写新根。
- 非目标：不做 `memory/`→`lmemory/` 式的旧目录 rename（TTS 音频无此历史包袱）。

## 4. 播放权威（`playback.ts` + 路由）

### 4.1 单一真相源 `PlaybackController`

host 侧内存单例，记录「当前谁在播、播到哪、什么模式、能否停」：

```ts
interface PlaybackState {
  active: boolean                 // 是否有正在进行的播放
  mode: 'host' | 'ui' | null      // host = host_play 子进程；ui = 浏览器 <audio>
  sessionId?: string
  turn?: number
  segmentIndex?: number           // 多 run 时当前段
  segmentCount?: number
  status: 'playing' | 'paused'    // active 时的子状态
  positionMs?: number             // 已播位置（host 为近似值）
  durationMs?: number             // 总时长（段级；多段由 UI 累计）
  startedAt?: number
}
```

- **三模式统一上报**：
  - `host_play`：`PlayerQueue` 在起播/播完/被杀时回调 `PlaybackController`，写入 `{ mode:'host', sessionId, turn, segmentIndex, status }`；`positionMs` = `Date.now() - startedAt`（近似），`durationMs` 来自 catalog 的容器头解析。stop 由 controller 转发 `PlayerQueue.stop()` 并清态。
  - `stream`（未来）：流式 provider 把「哪段在推」写进 controller，UI 轮询渲染进度；本轮只留上报口，不做流实现。
  - `ui`（浏览器 `<audio>`）：turn-tail 组件用 `<audio>` 播放，但把「我在播 turn N」`POST /voice-tts/playback/claim` 到 controller（`mode:'ui'`），便于「同一时刻只让一个播放器出声」的互斥与跨组件可见；进度仍由 `<audio>` 自身 `timeupdate` 驱动，不依赖 host 往返。

### 4.2 host 播放器后端（可暂停 / 可 seek）

`afplay` 无 pause/seek 原语，替换为**可插拔后端**，默认按可用性探测：

- **ffplay**（默认，探测 `/opt/homebrew/bin/ffplay` 等）：`ffplay -nodisp -autoexit -loglevel quiet -ss <startMs/1000> <path>`，stdin 管道发 `' '`（暂停/恢复）、`'q'`（退出）；`seek(ms)` = 记位 + 退出 + 以 `-ss ms/1000` 重启；`position()` 由 host 侧累计已播时长（我控制 pause/resume 事件，无需播放器上报）；`duration()` 来自 catalog 容器头。
- **afplay**（回退）：仅 stop（kill），position 墙钟近似。无 ffplay 时兜底。
- 后端接口 `AudioPlayer`：`start(path, startMs?)` / `pause()` / `resume()` / `seek(ms)` / `stop()` / `position()` / `duration()` / `onEnded` / `onError`。`player.command` 设置项覆盖命令路径（`''` = 自动探测 ffplay → afplay）。
- 说明：mpv 有 JSON IPC（精确 position + pause/seek），但本机未装；ffplay 已装且满足「可暂停/可 seek」，定为默认。mpv 后端留作后续扩展（后端接口已隔离）。

### 4.3 路由（loopback-only，沿用 `readJsonBody`/`writeJson` + `127.0.0.1` fail-loud）

| 路由 | 方法 | 载荷 | 返回 |
|---|---|---|---|
| `/voice-tts/playback` | POST | `{}` | `PlaybackState`（当前播放状态） |
| `/voice-tts/playback/stop` | POST | `{}` | `PlaybackState`（停止后） |
| `/voice-tts/playback/pause` | POST | `{}` | `PlaybackState`（暂停后，host_play 用） |
| `/voice-tts/playback/resume` | POST | `{}` | `PlaybackState`（恢复后，host_play 用） |
| `/voice-tts/playback/seek` | POST | `{ ms }` | `PlaybackState`（seek 后，host_play 用） |
| `/voice-tts/playback/claim` | POST | `{ sessionId, turn }` | `PlaybackState`（UI 宣称开始/结束播放某 turn） |

- 页面刷新后 UI 重新 mount → `POST /voice-tts/playback` 读到「host_play 正在播 turn N」→ 正确渲染暂停/停止/进度；「停止/暂停」→ 对应路由，与浏览器是否刷新无关（ffplay 是 host 子进程）。
- host_play 的 pause/seek 由 ffplay 后端支撑（`position` 为 host 累计、`seek` 重启到 `-ss`，功能正确、有重启解码延迟）；浏览器 `<audio>` 面仍是全精度。

## 5. 交付路径改造（`index.ts` `deliverSpeech`）

- 落盘目录从 `session.header.cwd` 改为 `storageRootFor(session.header.cwd, settings.storage)` 下的 `<sessionId>/` 子目录；`baseName` 改为 `turn-<n>`（session 子目录已含 sessionId，文件名不再重复）。
- 写盘成功后：① `catalog.upsert(root, entry)`（含 durationMs）；② 若 `host_play`，`PlayerQueue.enqueue` 并让起播/结束回调进 `PlaybackController`。
- `regenerateTurn` 从「live session 提取文本 + 现算」不变，但落盘/登记走同一 `deliverSpeech` 路径，`delivery=off` 时强制 `file`。

## 6. 前端变更（`src/client/TurnTailPlayer.tsx` + `api.ts`）

- **mount 即读 `playback` 状态**（一次请求，非轮询），若「host_play 正在播本 turn」→ 渲染停止按钮 + 近似进度（poll `playback` 每 1s 更新 position）；否则渲染 ▶。
- **点 ▶ 分派**：
  - delivery 允许浏览器播（file/off/stream 的文件回放）→ 走 `/voice-tts/audio` + `<audio>`（完整播放/暂停/进度/seek），并 `claim` 到 controller。
  - 无缓存 → 弹「重新生成」模态（同前）。
- **停止** → 若本组件在浏览器播，停 `<audio>`；若 host_play 在播本 turn，`playback/stop`。
- 多段顺序播放累计时点/时长口径不变（`<audio>` 元数据 + catalog `durationMs` 兜底）。

## 7. settings schema 变更

`voice-tts` 命名空间新增顶层 `storage`：

```ts
storage: {
  scope: z.union(['user', 'project']).default('user'),  // 无 dir 时选层级（默认用户）
  dir: z.string().default(''),                          // 会话自定义绝对路径，优先级最高
}
player: {
  command: z.string().default(''),                      // 播放器命令路径，空 = 自动探测 ffplay → afplay
}
```

- `DEFAULT_SETTINGS`、`SCHEMA`、`types.ts` 的 `VoiceTtsSettings` 同步。
- 面板（`web-ui/panel`）与 `/dsh-voice-tts config` 模板补 `storage` 两个字段。

## 8. 验收标准（AC）

1. 合成后音频写入 `<root>/<sessionId>/turn-<n>[-<i>].<format>`，`<root>` 按 `storage.dir` → `storage.scope`（project 回退 user）解析；`storage.dir` 自定义、`scope` 切 user/project 均生效。
2. 每根目录 `catalog.json` 记录 `sessionId:turn → files[]`（含 format/bytes/durationMs），重启后 `audio-status` 依 catalog 定位音频、不依赖内存。
3. `catalog rebuild` 能从磁盘音频重建索引；`durationMs` 对 wav/aiff 精确、其余为 null。
4. host_play 起播/结束写进 `PlaybackController`；`GET playback` 返回 `{ mode:'host', sessionId, turn, status, positionMs, durationMs }`；`playback/stop` 杀掉 afplay 并清态。
5. 页面刷新后，turn-tail 读 `playback` 仍能看到并停止正在播的 host_play；UI 播放文件时 `claim` 到 controller，互斥生效。
6. turn-tail 在「host_play 播本 turn」「浏览器播本 turn」「空闲」三态各渲染正确按钮/进度。
7. `pnpm test` + `pnpm typecheck` + `pnpm build` 全绿；非 loopback fail-loud 不变。

## 9. 非目标（本轮不做）

- stream 的流式前端消费（本轮只留 `PlaybackController` 上报口）。
- mpv 播放器后端（JSON IPC，精确 position + 原生 seek；ffplay 已满足，后端接口已隔离）。
- 旧散落音频文件的自动迁移（提供 catalog rebuild + 手动清理说明）。
- 跨根全局 `registry.json`（dsh-memory 的「有哪些记忆根」）。当前音频只需「当前会话 cwd 决定一个写根」；多根登记/合并是后续扩展，`storage.dir` 已覆盖「自定义根」的显式场景。
- 逐仓库的 project/user 粒度切换（需 per-workspace settings 覆盖，dsh-settings 当前无此 scope）。

## 10. 改造面（文件清单）

| 文件 | 动作 |
|---|---|
| `src/storage.ts` | 新增：`storageRootFor` / `dshHome` / `findProjectRoot` / 文件布局常量 |
| `src/catalog.ts` | 新增：`Catalog` / `lookup` / `upsert` / `rebuild` / `audioDurationMs`（纯逻辑） |
| `src/playback.ts` | 新增：`PlaybackController`（状态 + 上报/停止/暂停/恢复/seek） |
| `src/player.ts` | 改：拆出 `AudioPlayer` 后端接口 + `FfplayPlayer` / `AfplayPlayer`；`PlayerQueue` 接起播/结束/暂停回调进 controller |
| `src/index.ts` | 改：`deliverSpeech` 写新根 + catalog 登记 + playback 上报；`regenerateTurn` 同路径；路由挂 playback |
| `src/slot-routes.ts` | 改：`/voice-tts/playback`、`/stop`、`/pause`、`/resume`、`/seek`、`/claim`；`audio-status`/`audio` 改读 catalog |
| `src/types.ts` | 改：`VoiceTtsSettings` 增 `storage`、`player` |
| `src/client/api.ts` | 改：`getPlayback` / `stopPlayback` / `claimPlayback` |
| `src/client/TurnTailPlayer.tsx` | 改：mount 读 playback、三态渲染、停止/claim 分派 |
| `src/web-ui/panel/*` | 改：storage 配置控件 |
| `tests/{storage,catalog,playback}.spec.ts` | 新增 |
| `docs/audio-storage-and-playback.md` | 本文 |

## 11. 讨论 / 风险

- **ffplay 的 `position` 是 host 累计、`seek` 是重启**：ffplay 不主动上报位置，我靠 pause/resume 事件累计已播时长，`seek` = 记位 + 退出 + `-ss` 重启（有解码延迟，但功能正确）。要原生位置/seek 需 mpv（JSON IPC），留作后续后端。
- **`durationMs` 解析覆盖**：只保证 wav/aiff（含 host 的默认 AIFF）；mp3/opus/pcm 记 null，浏览器播放时用 `<audio>` 元数据补。若未来要 host_play 精确 mp3 时长，再加 afinfo/ffprobe 探测（按需，非默认）。
- **互斥**：`claim` 让「同一时刻单一播放器」成为可能，但浏览器 `<audio>` 的 pause 不是强制的（多组件并发仍是浏览器行为）；本轮以「单组件 + host 互斥」为界，不做全局强停 UI 面。
- **写根一致性**：`storage.dir`/`storage.scope` 变更后，旧根的 catalog 仍在原地；`audio-status` 只查「当前解析根」的 catalog，跨根历史需未来 `registry` 支持（非本轮）。
