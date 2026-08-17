# 设计：dsh-voice-tts 的 Web UI 入口（slot 化 + 与 dsh-voice 共存）

> 状态：设计（实现前定稿）。本文是 `docs/design.md` 的增量补充，只覆盖「给 dsh-voice-tts 加一个 Web GUI 入口、并与 dsh-voice 的 🎙️ 入口共存」这一件事。

## 1. 背景与目标

- dsh-voice-tts 目前只有 **path B 独立页**：`/voice-tts`（须 `?ac_token=`）+ `/voice-tts-api` RPC channel，无 slot 化 UI 入口；用户要「打开设置」得靠 `/dsh-voice-tts ui` 命令输出 URL。
- dsh-voice 上一轮已往 `conversation.session.header.actions` 注册了 🎙️ 入口（id `voice-setting`，order 20），点开是「🎙️设置会话Voice」。
- 目标：给 dsh-voice-tts 也加一个**会话标题栏**入口，点开后一个下拉菜单含三个选项：
  1. **Set voice tts** —— 弹模态框，配置范围与 `/voice-tts` 独立页一致。
  2. **Turn [on|off] voice tts** —— 切换 TTS 开关，副标题显示当前状态与点击后状态。
  3. **Stop Current Host Play** —— 停止 host 后台播放，副标题显示「播放中 | 未播放」。

## 2. 关键调研结论（两个社区插件如何共用同一 UI 入口）

### 2.1 slot 是「list」，每个插件各注册自己的条目，天然并存

`conversation.session.header.actions` 是 **`list` slot**（`scope: session`，additive）。它的契约（`packages/client/ui-conversation/src/client/contract/slots.ts`）写明：entries 按 `order` 升序渲染；负值保留给静态会话上下文；owner 不传任何东西，控件所需全部来自框架 session kit + 注册者自己的 inject 脸。

**多个社区插件各自 `ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name, id, order, ... }, Component))` 注册自己的条目，互不感知、互不 import，渲染时并排出现。** 这正是官方支持的共存方式——现役占座者：`ui-subagent`（id `subagent-catalog`，order 10）、`ui-agent-preset`、`ui-jobs`、以及 dsh-voice（id `voice-setting`，order 20）。

### 2.2 为什么不能「合并成同一个 🎙️ 按钮」

slot 纪律明文禁止跨包 import 别人的符号（「Cross-package imports of another plugin's symbols are in principle forbidden」）。dsh-voice 的按钮组件属于 dsh-voice 包，dsh-voice-tts 无法在它里面追加菜单项。**正确的做法是 dsh-voice-tts 自己再注册一个独立条目（自己的触发按钮 + 自己的下拉），两者并排。** 用户心智里的「一个 🎙️ 出两个选项」落到 dsh 原生机制上 = 「标题栏两个按钮并排，各自弹出自己的下拉」。

- dsh-voice：🎙️ → 「🎙️设置会话Voice」（已存在，不改）。
- dsh-voice-tts：🔊 → 「Set voice tts / Turn on|off / Stop host play」（本次新增）。

为与 🎙️（voice 人设）区分，dsh-voice-tts 用 **🔊**（speaker）作为触发图标，`order: 30`（排在 🎙️ 之后）。

### 2.3 host↔browser 桥 = 自有 loopback 路由

与 dsh-voice 同款：browser half 无法直达 host service，走 `ctx.webServer.register({ kind: 'exact', path, handler })` 挂 loopback-only 路由，browser half 同源 `fetch`。非 `127.0.0.1` host 时 fail-loud。

## 3. 三个选项的实现

### 3.1 选项一「Set voice tts」→ iframe 模态

配置范围与 `/voice-tts` 完全一致，**直接复用现有面板**：模态框内嵌 `<iframe src="/voice-tts?ac_token=...">`。

- 理由：现有面板（`src/web-ui/panel/`）已是完整配置 UI（provider 卡片、音色搜索选择器、槽位可调参数、per-region 保存、凭证管理）。把它原样搬进 modal 是重复造轮子；iframe 让「配置范围 = 独立页」**字面成立**。
- 模态框用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal` 包 iframe，给合适尺寸与关闭按钮（「适配模态弹窗」= 给独立页加一个模态 chrome）。
- 面板 token：host 已每进程生成 `panelToken`；新增 `POST /voice-tts/panel-url` 返回 `{ url }`，browser half 据此渲染 iframe。token 仍三层校验（页面/静态资源/RPC），iframe 同源加载不受影响。

### 3.2 选项二「Turn [on|off] voice tts」→ 切 `delivery`

- 开关语义：`delivery === 'off'` = 关，其余（`file`/`host_play`/`stream`）= 开。
- 切换：
  - 关 → 开：恢复 `lastOnDelivery`（模块级变量，默认 `host_play`，随 `scope.watch` 在非 off 时更新），保证「关掉 file 再开回来还是 file」。
  - 开 → 关：记住当前非 off 值到 `lastOnDelivery`，写 `delivery = 'off'`。
- 副标题（小字）：「当前状态: 开启/关闭，点击后关闭/开启」，随当前 `delivery` 实时渲染。

### 3.3 选项三「Stop Current Host Play」→ `PlayerQueue.stop()`

- `PlayerQueue` 目前只串行排队，无停止能力。新增：
  - `isPlaying(): boolean` —— 当前是否有正在播放的子进程。
  - `stop(): void` —— 杀当前子进程 + 用 epoch 计数器使队列里未开始的项作废。
- 副标题：「播放中 | 未播放」，随 `isPlaying()` 状态渲染。仅 `host_play` 有意义；非 host_play 时该选项仍显示但 stop 是 no-op（无害）。

## 4. host 侧新增路由（loopback-only）

| 路由 | 载荷 | 返回 |
|---|---|---|
| `POST /voice-tts/state` | `{}` | `{ delivery, on, playing }` |
| `POST /voice-tts/toggle` | `{}` | `{ delivery, on }` |
| `POST /voice-tts/stop` | `{}` | `{ playing: false }` |
| `POST /voice-tts/panel-url` | `{}` | `{ url }`（无 panel 时 `{ url: null }`） |

- 全部 `ctx.webServer.host !== '127.0.0.1'` 时 fail-loud；JSON body（content-type 校验 + 体积上限，dsh-compass 同款 `readJsonBody`）。
- `toggle` 经 `activeScope.update({ delivery })`（settings 未挂载时返回 `{ on: false, error }`）。

## 5. 架构：保持 tsc 编译 node，新增 tsdown 编译 client

dsh-voice-tts 的 node half 已是 `tsc`（NodeNext + `.js` 后缀 emit）+ vite 面板。**不推倒重来**，只在旁边加一条 client 构建链：

```
src/client/           # 新增 browser half（slot 注册 + 下拉 + iframe 模态）
  index.ts            # ctx.slots.register('conversation.session.header.actions', ...)
  VoiceTtsAction.tsx  # 🔊 触发 + 下拉 3 项
  VoiceTtsDialog.tsx  # iframe 模态
  api.ts              # routeFetch
  locales.ts          # zh / en
tsdown.config.ts      # 新增：client-only（CJS closure），tsconfig: './tsconfig.client.json'
tsconfig.client.json  # 新增：jsx + DOM + bundler + paths（指向 ../deepseek-harness）
package.json          # + dsh.client + exports["./client"] + tsdown dev dep
```

- 根 `tsconfig.json`（node，NodeNext）不变，仅 `exclude` 里追加 `src/client`。
- tsdown 支持每 config 一个 `tsconfig` 字段（`tsconfig?: string | boolean`），client config 指向 `tsconfig.client.json`，与 node 的 NodeNext 上下文解耦。
- 构建链：`clean → tsc（node）→ tsdown（client）→ vite（panel）`。

## 6. 非目标

- 不改 dsh 源码、不改 `conversation.session.header` 组件本身。
- 不把整套面板组件 port 进 client bundle（用 iframe 复用）。
- 不新增 provider、不改合成/双语逻辑。
- 不改 dsh-voice 的 🎙️ 入口（它维持原样，两者并排）。

## 7. 验收标准（AC）

1. 会话标题栏出现 🔊（在 🎙️ 之后）；点开下拉出现三个选项：Set voice tts / Turn [on|off] voice tts / Stop Current Host Play。
2. 「Set voice tts」打开模态框，内含 `/voice-tts` 面板（iframe），配置范围与独立页一致，改动即时生效。
3. 「Turn [on|off] voice tts」副标题正确反映当前状态；点击后 `delivery` 在 off 与上次非 off 值之间切换，`/dsh-voice-tts status` 同步。
4. 「Stop Current Host Play」副标题反映「播放中|未播放」；host_play 播放中点击可停掉当前与排队中的播放。
5. 非 loopback host 时 fail-loud，不暴露 `/voice-tts/*`。
6. `pnpm test` + `pnpm typecheck` + `pnpm build` 全绿；`dsh --dump-config` 仍只见一个 `dsh-voice-tts` row；client bundle 以 `window.__ModuleLoader__.load({ id: "@meomeo-dev/dsh-voice-tts" })` 注册。

## 8. 改造面（文件清单）

| 文件 | 动作 |
|---|---|
| `src/player.ts` | 改：`PlayerQueue` 加 `stop()` / `isPlaying()` + epoch 计数 |
| `src/index.ts` | 改：`registerSlotRoutes(ctx, deps)` 挂 4 条 loopback 路由；toggle 经 activeScope |
| `src/client/{index,VoiceTtsAction,VoiceTtsDialog,api,locales}.ts` + CSS | 新增 |
| `tsdown.config.ts` / `tsconfig.client.json` / `src/css-modules.d.ts` | 新增 |
| `package.json` | 改：`dsh.client` + `exports["./client"]` + tsdown/lightningcss dev dep + 脚本 |
| `tests/player.spec.ts` | 改：补 `stop()` / `isPlaying()` 单测 |
| `docs/voice-tts-slot-ui.md` | 本文 |

## 9. 讨论 / 风险

- **iframe 的 CSP**：面板 HTML 壳自带 `default-src 'none'` + 本源 connect/script，iframe 同源嵌入无额外风险；token 仍三层校验，iframe 内 RPC 走同一 loopback channel。
- **两个 🔊/🎙️ 并排**：这是 list slot 的既定形态。若用户坚持「合并成一个按钮」，需二选一：dsh-voice 把菜单项让渡给一个共享 slot（改动 dsh-voice），或接受并排。本期按「并排」交付，不引入跨包耦合。
- **toggle 的「开」值**：恢复 `lastOnDelivery`（默认 `host_play`），避免把 `file`/`stream` 误改回 `host_play`；跨重启 `lastOnDelivery` 重置为 `host_play`（可接受，因 `delivery=off` 的关状态本身持久在 settings）。
- **Stop 与队列**：`stop()` 用 epoch 作废未开始项，已开始项 `child.kill()`；`deliverSpeech` 的 `enqueue` promise 会 reject，但已有 `.catch` 兜底，不冒泡。

## 10. 新建会话 hero 屏 🔊 回落（与 dsh-voice 共存）

### 10.1 背景

header 的 🔊 与 🎙️ 都挂在 `conversation.session.header.actions`，但空白阶段的 hero 屏隐藏整个 header，新建会话时无从用 TTS。harness 在 hero 工作区行暴露了一个 `conversation.hero.voice` **list slot**（`scope: root`），本插件与 dsh-voice 各注册一个条目。

### 10.2 与 dsh-voice 的组合关系（回落 + 注入，同 header）

- **注入**：本插件把 TTS 菜单项注入 dsh-voice 声明的 root 宿主槽 `voice.hero.menu`（id `voice-tts-hero`），与「设置会话Voice」共用 hero 🎙️ 下拉。
- **回落**：本插件再注册一个 🔊 触发器进 `conversation.hero.voice`（id `voice-tts-hero-fallback`）。`VoiceTtsHeroAction` 经 `hooks.voiceHeroMenuDeclared`（`ctx.slots.spec('voice.hero.menu') !== undefined` 的响应式快照）判断：**有 dsh-voice 时返回 null**（交给 `voice.hero.menu` 合并渲染，避免重复图标）；**无 dsh-voice 时**渲染 🔊 + 内嵌 `VoiceTtsMenu`（Set voice tts / Turn on-off / Stop host play 三项）。这与 header 的 `VoiceTtsHeaderAction` 检测 `voice.menu` 是同一套「宿主声明存在与否」逻辑。

### 10.3 关闭 delivery 时停播放

`Turn off voice tts`（`toggleDelivery` 的 off 分支）会同步 `playback.stop()`，清掉暂停中/播放中的 host_play 残留态——否则 delivery 已 off、新消息不再合成，而旧的暂停态仍滞留，turn-tail 的 ▶ 会去恢复「关闭前」的旧音频。
