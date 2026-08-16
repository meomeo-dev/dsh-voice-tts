# 设计：turn 末尾吸附的播放控制器（turn-tail player）

> 状态：设计（实现前定稿）。本文是 `docs/voice-tts-slot-ui.md` 的增量补充，只覆盖「在每个 turn 结束的 final 消息下方吸附一个简洁的播放控制器」这一件事。

## 1. 背景与目标

- dsh-voice-tts 的 `turn/end` 处理器已经按 `delivery` 模式把每轮最终回复合成成音频文件（host 侧落盘在 `session.header.cwd`，文件名 `dsh-voice-tts-<sessionId>-turn-<n>[-<i>].<format>`）。但这些音频只走 `host_play` 本机播放，Web UI 里没有任何「回放这一轮」的入口。
- 目标：在 Web UI 每个 turn 结束的 final 消息下方，吸附一个**紧凑**的播放控制器，支持：
  1. **播放**——若该 turn 已有缓存音频则直接播；**无缓存则弹模态窗**询问是否重新生成 TTS。
  2. **停止**——停掉浏览器侧正在进行的回放。
  3. **播放进度**——显示当前「时点 / 时长」（流式播放时实时刷新；时长由浏览器 `<audio>` 元数据给出，host 不解析时长）。
- 约束：不改 dsh 源码；纯第三方社区插件方式接入（靠 dsh 声明的 slot + loopback 路由）。

## 2. 关键调研结论（dsh 是否支持第三方实现）

### 2.1 落点：`conversation.chat.turnTail`（chain slot）

`packages/client/ui-conversation/src/client/contract/slots.ts` 声明：

```ts
'conversation.chat.turnTail': { kind: 'chain'; scope: 'session'; owner: TurnTailOwnerProps }
```

owner 币（`TurnTailOwnerProps`）：

```ts
interface TurnTailOwnerProps {
  turn: TurnLocation      // turn.turn: number —— 直接映射音频文件名里的 turn 号
  seq: number
  openFile: (path: string) => void
}
```

渲染点（`TurnTailNodeView.tsx`）在 turn-tail 节点上 `renderSlotChain('conversation.chat.turnTail', owner)`，位于该 Node 的 `IconActions` 之前——正是「吸附在消息 turnTail 下方」的位置。

- 这是 **chain** 类 slot：每个贡献者注册时带 `select(owner)` 路由选择器 + `priority`，首个非空返回当选并把结果作为组件的 `matched` prop。`scope: 'session'` 意味着组件额外拿到框架 session kit（含 `sessionId`）。
- 结论：**dsh 原生支持第三方社区插件在此落 UI，无需改 agent-loop 或 conversation 组件。**

### 2.2 `sessionId` 从哪来：框架 session kit

`SessionStandardProps`（由 `@deepseek-ai/dsh-client-runtime/client` 合并进 `@deepseek-ai/dsh-client-ui-slots`）给每个 `scope: 'session'` 的 slot 组件注入 `sessionId: SessionId` 与 `useSession`。于是组件的 `PropsRuntime<'conversation.chat.turnTail'>` = `{ turn, seq, openFile, sessionId, useSession, useInput, inputActions, … }`。`sessionId`（client 侧）与 host 侧 `session.id` 是同一个会话标识，二者拼出音频文件名。

### 2.3 host↔browser 桥：自有 loopback 路由（沿用既有模式）

browser half 无法直达 host service；dsh-voice-tts 已挂 `/voice-tts/*` loopback-only 路由（`slot-routes.ts`）。本功能在**同一条链**上新增 3 条路由即可，无需新机制。

## 3. 数据与定位模型

### 3.1 内存音频注册表（source of truth）

`turn/end` 处理器 `deliverSpeech` 成功后，把本次交付结果登记进一个模块级 `Map`：

```
key = `${sessionId}:${turn}`
value = { paths: string[]; format: string }
```

- `paths` 是本次交付逐 run 的绝对路径（1 run = 1 段；多 run = 多段 `-0`/`-1`/…）。
- `format` 是交付所用格式（决定 `audio` 路由的 Content-Type 与 `<audio>` 兼容性）。

这就是 `audio-status` 与 `audio` 两个路由的唯一定位来源——不需要从裸 `sessionId` 反查 session cwd 或猜扩展名。

**重启语义**：注册表是内存态，进程重启后为空 → `audio-status` 报 `exists:false` → 前端按「无缓存」弹「重新生成」模态。此时重新生成仍能工作（见 3.3），所以重启不丢功能，只是需要一次显式重生成。落盘文件仍在磁盘上（供 `host_play`/`file` 本机使用），但浏览器回放只在内存注册表命中时直接提供；这一限制在「非目标 / 已知限制」中说明。

### 3.2 定位与格式

- `audio-status` 只查注册表；`exists` = 该 key 是否在表中。
- `audio` 按 `sessionId` + `turn` + `index`（0-based，`paths[index]`）直接读注册表里的绝对路径，`fs.createReadStream` 流式写回，带 `Content-Length` 与正确 `Content-Type`，让 `<audio>` 元数据可解析时长、可 seek。
- `index` 越界 → 404。

### 3.3 重新生成（regenerate）

从 live session 重新提取文本再合成，不依赖注册表是否命中：

1. `ctx.sessions.get(SessionId(sessionId))` 拿 live session（`ctx.sessions` 是 dsh-session 的 `SessionStore`，声明于 `@deepseek-ai/cordis` Context）。
2. `finalAssistantText(session.events, turn)` + `sanitizeForSpeech` 提取净化的最终回复文本；为空 → 报「该 turn 无可朗读文本」。
3. 复用 `deliverSpeech`，`delivery` 取当前设置；若当前 `delivery === 'off'` 则强制 `'file'`（用户显式点了「重新生成」，必须产出可播放文件；host_play 时仍会本机播放）。
4. 成功后登记进注册表，返回与 `audio-status` 同构的新状态，前端据此直接播放。

> `finalAssistantText` / `sanitizeForSpeech` 与 `turn/end` 处理器同源，保证「重生成」与「自动生成」产出同一文本。

## 4. 前端交互（TurnTailPlayer 组件）

### 4.1 状态机（懒加载，挂载零请求）

```
[▶]（idle）──点击──▶ audio-status
                        ├─ exists ──▶ 播放（fetch /audio?index=0，顺序播多段）
                        └─ !exists ──▶ 弹模态「重新生成?」[重新生成][取消]
                                        └─ 重新生成 ──▶ regenerate ──▶ 播放新音频
[■]（playing）＋「时点/时长」文本，timeupdate 实时刷新；■ 停止=暂停+归零
```

- 挂载时**不发**请求，避免长会话下每个 turn 各发一次 `audio-status` 的请求风暴；只在用户点击 ▶ 时才查。
- 单 turn 多段（双语分片不同音色 → 多个 run）时顺序播放：一段 `ended` 后切到下一段，`时长` 取各段 `loadedmetadata` 时长的累加，`时点` = 已完成段时长之和 + 当前段 `currentTime`。

### 4.2 紧凑视觉

- 一行小控件：播放/停止按钮 + `m:ss / m:ss` 文本（+ 细进度条），字号小、贴左对齐、无边框包裹，吸附在 `IconActions` 上方。
- 停止后回到 ▶，进度归零，保留已加载的段时长（下次播直接续）。

### 4.3 停止语义

停止只停**本控制器**的 `<audio>`（pause + currentTime=0）。不触碰 `POST /voice-tts/stop`（那是 host_play 本机播放队列的停止，与浏览器回放无关）。

## 5. host 侧新增路由（loopback-only，沿用 `readJsonBody` / `writeJson` 与 `127.0.0.1` fail-loud）

| 路由 | 方法 | 载荷 | 返回 |
|---|---|---|---|
| `/voice-tts/audio-status` | POST | `{ sessionId, turn }` | `{ exists, segments, format }` |
| `/voice-tts/audio` | GET | query `?sessionId=&turn=&index=` | 音频字节流（`Content-Type`/`Content-Length`），404 当未命中 |
| `/voice-tts/regenerate` | POST | `{ sessionId, turn }` | `{ exists, segments, format }`（重生成后） |

- `audio` 用 GET 是因为 `<audio src>` 走 GET；其余沿用 POST JSON（与既有 `/voice-tts/*` 一致）。
- `audio` 只从注册表读绝对路径，无路径拼接、无穿越面。
- `regenerate` 仅对 live session 的日志提取文本，无外部文本注入面；session 不存在或文本为空报 400。

### 5.1 音讯格式 → Content-Type

| format | Content-Type |
|---|---|
| `mp3` | `audio/mpeg` |
| `wav` | `audio/wav` |
| `aiff` | `audio/aiff` |
| `ogg_opus` / `opus` | `audio/ogg` |
| `pcm` | `audio/L16` |

`pcm`（裸 PCM）浏览器 `<audio>` 通常不能播——见「已知限制」。

## 6. 架构增量（沿用既有 tsc node + tsdown client 双链）

- **node half**：`slot-routes.ts` 扩 `SlotRoutesDeps` + 3 条路由；`index.ts` 加注册表 + `turn/end` 登记 + 组装 deps 闭包 + `ctx.sessions.get`。
- **client half**：`src/client/` 加 `TurnTailPlayer.tsx`（+ `.module.css`）、`api.ts` 加 `audioStatus` / `regenerate` / `audioUrl`、`locales.ts` 加新词条、`index.ts` 注册 chain slot。

## 7. 非目标

- 不改 dsh 源码、不改 `TurnTailNodeView` / conversation 组件本身。
- 不做 WebSocket/SSE 流式推音频（`stream` 交付暂不接前端流；本次播放基于完整落盘文件）。
- 不解析音频时长（交给 `<audio>` 元数据）。
- 不做「同一时刻只允许一个控制器出声」的全局互斥（见已知限制）。
- 不做跨重启的磁盘扫描回退（见 3.1 重启语义）。

## 8. 验收标准（AC）

1. Web UI 每个 turn 的 final 消息下方出现一个紧凑播放控制器（吸附在 IconActions 上方）。
2. 点 ▶：该 turn 有缓存音频时直接浏览器播放；无缓存时弹出「是否重新生成 TTS」模态，确认后合成并可播放，取消则关闭。
3. 播放中显示「时点 / 时长」并随播放实时刷新；点停止回到 ▶ 且进度归零。
4. 双语多 run 时顺序播放多段，时长/时点按累计口径正确。
5. 非 loopback host 时 fail-loud，不暴露新路由。
6. `pnpm test` + `pnpm typecheck` + `pnpm build` 全绿；client bundle 以 `window.__ModuleLoader__.load({ id: "@meomeo-dev/dsh-voice-tts" })` 注册，chain slot 以 `select` + `priority` 注入 `conversation.chat.turnTail`。

## 9. 改造面（文件清单）

| 文件 | 动作 |
|---|---|
| `src/slot-routes.ts` | 改：`SlotRoutesDeps` 增 audio-status/audio/regenerate 依赖 + 3 条路由 |
| `src/index.ts` | 改：音频注册表 + `turn/end` 登记 + deps 组装 + `ctx.sessions.get` 重生成 |
| `src/client/api.ts` | 改：`audioStatus` / `regenerate` / `audioUrl` |
| `src/client/TurnTailPlayer.tsx` + `.module.css` | 新增 |
| `src/client/index.ts` | 改：注册 `conversation.chat.turnTail` chain slot |
| `src/client/locales.ts` | 改：播放/停止/重生成模态词条 |
| `docs/turn-tail-player.md` | 本文 |

## 10. 讨论 / 风险

- **请求风暴**：用懒加载规避（点击才查）。若未来要「渲染即知道该 turn 有无音频」，可加一个 `POST /voice-tts/audio-status-batch`（一次返回全部 turn 状态），本期不做。
- **多控制器并发出声**：两个 turn 的控制器同时播会叠加。本期接受；后续可加模块级「唯一活跃音频」单例，新播放前 pause 旧者。
- **`pcm` 格式**：裸 PCM 无容器头，浏览器 `<audio>` 无法播。默认 `play_format` 是 `wav`、host 是 `aiff`，均有容器头；仅当用户显式选 `pcm` 时才会遇到，记为已知限制。
- **重启后无缓存**：内存注册表清空，点 ▶ 走「重新生成」模态；因重生成从 live session 提取文本，重启后仍可用，只是多一步确认。
- **重生成的 token 成本**：volcengine/siliconflow 重生成会再调一次云端 API。确认弹窗已让用户显式同意，风险可接受。
