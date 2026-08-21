# 文本切分/段落判定策略设计（定稿）

> 状态：**定稿（finalized）**，尚未实现。本文档描述提供给用户切换的文本切分策略、
> 各策略的行为语义、定案决策与改造面，作为实现的规格依据。
>
> 历史：2026-08-19 三路 review 与代码现状核对（结论见文末「§ 与代码现状的核对结果」，
> 为历史决策记录）；同日按「以当前代码为准」移除与代码冲突的设计（策略 4 的空行/
> 换行/Markdown 分段符、管线接线改法），并将待确认决策点定案（见「§ 定案决策」）。

## 背景与问题

`dsh-voice-tts` 的 `src/bilingual.ts` 目前是**句子级**判定：`sentence-splitter`
切句 → `classifySentence` 逐句判 `zh`/`en`/`mixed` → `bilingual` 模式过滤 →
按语言分配音色（`planBilingualSpeech`）。完整管线还包含 `voice_profiles`
（per-voice profile 整体替换，经 `effectiveVoices`，见 `src/bilingual.ts:144-150`）。

问题场景：一个中文段落里突然混入一句独立英文句。当前 `both` 模式下该句被判为
`en`，会被读出来，但用户期望“中文段落的夹杂英文不该读”。

“段落”是一个语义单元，无法用“句子连续性”（相邻关系）界定：中文段夹的英文句
与独立英文引用段，在连续性上不可区分。本文档给出可切换的策略集，交由用户选择。

## 策略集（可切换功能）

| # | 策略名 | 判定依据 | 用户看到的效果期望 | 优点 | 缺点/注意 |
|---|---|---|---|---|---|
| 1 | 关闭（不切分） | 无——整段文本当一个单元 | 整段全部读出，无任何语言抑制；英文句也用统一音色读出 | 零开销、行为绝对可预期 | 无语言切换、无夹杂抑制 |
| 2 | 按句子切分 | `sentence-splitter` 逐句分类 zh/en/mixed，按句选音色 | 每句按语言用对应音色；中文段夹的独立英文句也会被读（用 en 音色） | 现状行为、细粒度音色切换 | 无法抑制夹杂外文 |
| 3 | 按段落切（连续区段） | Unicode 脚本扫描 → 同脚本连续区段；短区段被异语言夹住 → 抑制/并主导，长区段保留 | 中文段夹的短英文句**不被读**；一整段独立英文引用仍会被读 | 不依赖任何分段符号，健壮、确定性、可测 | 阈值需调；中英混排同一句不受影响（仍按 mixed 读） |
| 4 | 按段落切（自然段落硬切） | 按用户自定义可见字符组合切窗口，段内判定主导语言抑制 | 按用户定义的分段字符做段内抑制 | 符号由用户显式指定，sanitize 后仍可见 | 依赖自定义符号命中；空行/换行/Markdown 结构在当前管线不可得；无结构文本需 fallback |

## 用户可感知效果示例

> 示例文本：大家好，今天我们来学习基础语法。The quick brown fox jumps. 接下来是重点，请记好笔记。

| 策略 | 那句英文的命运 | 播放结果 |
|---|---|---|
| 1 关闭 | 会读 | 整段一遍读完，英文句用统一音色 |
| 2 按句子 | 会读 | 中文句用 zh 音色，英文句切到 en 音色（若未配置 en 槽位则仍用统一 `voice_type`） |
| 3 连续区段 | 不读（短夹杂） | 中文全部读出，短英文句被跳过 |
| 4 自然段落 | 不读（若该段内主导为中文） | 中文段读出；若英文自成一段（且足够长）则读 |

## 各策略的判定细节

### 策略 1 · 关闭（不切分）

- 整段文本作为单一 `VoiceRun`，不做语言判定与抑制。
- 使用统一音色（`voice_type` 或配置的缺省槽位）合成整段。
- 等价于“关闭全部双语智能”，给确定每句都读的场景兜底。
- **实现状态**：全新，当前 `BilingualMode` 仅有 `both`/`english_only`/`chinese_only`
  三值（`src/types.ts:128`），无 off/不切分开关。

### 策略 2 · 按句子切分

- 现状行为：`sentence-splitter` 切句（换行不是句界），`classifySentence` 逐句判
  `zh`/`en`/`mixed`。
- `bilingual` 模式过滤：`both` 全读；`english_only`/`chinese_only` 过滤掉 mixed 与非目标语言句。
- 相邻同音色同参数句子合并为一个 `VoiceRun`（合并**不比较语言类别**：zh/en 解析到
  同一音色且同参数时会跨语言合并，合并后 `run.lang` 被当前句覆盖，`src/bilingual.ts:168-171`）。
- mixed 音色回退链：`voices.mixed → voices.zh → fallback`（`src/bilingual.ts:91`）。

### 策略 3 · 按段落切（连续区段）

- 判定依据：Unicode 脚本扫描（CJK 区 / Latin 区，复用 `[一-鿿]` 与 `[A-Za-z]`），
  连续同脚本字符聚成一个区段，空白与标点跳过但不打断区段。
- 阈值判定（**定案**）：区段长度 ≤ 5 字符，且该区段被异语言区段夹持（左右都有
  异语言字符）→ 视为夹杂，跳过；长度 > 5 字符的区段 → 独立语言区段，保留读。
- 与句子级分类分层：句级分类保留（决定读不读/用什么音色），脚本区段只做“夹杂判定”，
  不拆散 mixed 句。
- 优点：边界由脚本变化决定，与模型是否空行/换行无关。
- **实现状态**：全新。`CJK_RE`/`LATIN_RE`（`src/bilingual.ts:43-44`）目前仅用于
  `classifySentence` 逐句计数，无连续区段扫描、无阈值常量、无抑制逻辑。

### 策略 4 · 按段落切（自然段落硬切）

- 判定依据：用户自定义可见字符组合切分窗口，窗口内判定主导语言并抑制夹杂。
- 自定义可见字符组合：用户输入一个字符串作为分段符（如 `|` 或特定组合），
  任一命中即切窗口。
- 无结构文本时的 fallback（**定案**）：自定义分段符无命中时，退化为策略 2
  （句子级切分），不引入额外窗口。
- **以当前代码为准的约束**（sanitize 先行，`src/index.ts:1038 → 464`）：
  - 空行：`collapseWhitespace` 已把连续换行压成单个换行（`src/sanitize.ts:157-166`），不可得。
  - 单个换行：既有已测决策「换行不是句界」（`tests/bilingual.spec.ts:52-54`），不作分段符。
  - Markdown 标题/列表/引用/代码块：`stripInlineMarkdown` 已剥为纯文本（`src/sanitize.ts:133-155`），不可得。
  - 因此分段符号只提供「自定义可见字符组合」，不提供任何被 sanitize 剥除或与既有决策冲突的预置符号。
- **实现状态**：全新；无分段符号配置、无窗口切分逻辑。

## § 定案决策

1. **策略关系（策略 3 / 4）**：4 个策略**互斥单选**（用户选哪个用哪个，无“两层都开”）。
   策略 4 窗口内的“段内主导语言抑制”复用策略 3 的区段/阈值判定实现（同一组纯函数），
   减少重复逻辑。
2. **阈值默认值**：区段长度 ≤ 5 字符且被异语言区段夹持 → 夹杂跳过（见策略 3）。
   阈值做成配置字段（`segment_threshold`），默认 5。
3. **异语言片段行为**：只暴露 `skip`（跳过）。`dominant-voice`（用主导语言音色读）
   不在本期实现，文档保留该选项供后续扩展。
4. **与 bilingual 模式的关系（已定案）**：`english_only`/`chinese_only` 保持现有严格
   过滤（`src/bilingual.ts:77-80`、`tests/bilingual.spec.ts:65-88` 已锁定），新抑制
   逻辑只在 `both` 生效。
5. **配置形态（已定案）**：策略字段落在 `BilingualVoiceConfig`（`src/types.ts:203-212`），
   随 provider 走，与 `bilingual` 完全同构。

## § 改造面（实现规格）

| # | 位置 | 改造内容 | 策略 |
|---|---|---|---|
| 1 | `src/types.ts:124-128` | 新增 `SegmentStrategy` 枚举（`off`/`sentence`/`script-run`/`custom-separator`） | 全部 |
| 2 | `src/types.ts:203-212` `BilingualVoiceConfig` | 新增 `segment_strategy`（默认 `sentence`）、`segment_threshold`（默认 5）、`segment_separators`（默认空串） | 全部 |
| 3 | `src/bilingual.ts:43-44, 55-65` | 复用 `CJK_RE`/`LATIN_RE` 与 `classifySentence`；新增 `scriptRuns()`（连续同脚本区段扫描）与 `segmentBySeparators()`（自定义分段）纯函数 | 3、4 |
| 4 | `src/bilingual.ts:153-175` `planBilingualSpeech` | 按 `segment_strategy` 分支：`off`（整段单一 VoiceRun）；`script-run`（区段扫描 + 阈值夹杂跳过）；`custom-separator`（切窗口 + 段内复用区段/阈值判定）；`sentence`（现状路径不变） | 全部 |
| 5 | `src/index.ts:137-227` 各 provider schema | 每处新增策略三字段（默认值同 #2） | 全部 |
| 6 | `src/index.ts:232-331` `DEFAULT_SETTINGS` | 6 处 provider 默认配置补三字段默认值 | 全部 |
| 7 | `src/index.ts:367-400` `deliveryView` | 6 个 provider 分支（`:377, 381, 385, 389, 393, 397`）透传三字段 | 全部 |
| 8 | `src/volcengine.ts:76-86`、`siliconflow.ts:70-80`、`host.ts:51-62`、`openai.ts:70`、`minimax.ts:88-98`、`fish.ts:144-150` | 各 provider `config --template` 补三字段说明 | 全部 |
| 9 | `src/web-ui/panel/src/api.ts:55-60` | `BilingualFields` 类型镜像补三字段 | 全部 |
| 10 | `src/web-ui/panel/src/App.tsx:420-450` `BilingualFields` | bilingual 下拉旁新增“切分策略”下拉（`SEGMENT_STRATEGY_OPTIONS`，`App.tsx:14` 旁）；`custom-separator` 选中时条件渲染分段符输入框 | 全部 |
| 11 | `src/command.ts:156-187` `renderStatus` | 状态输出补 `segment_strategy:` 行 | 全部 |
| 12 | `tests/bilingual.spec.ts` | 新增策略 1/3/4 用例（off 单一 run、script-run 阈值夹杂、custom-separator 窗口）；现状 `sentence` 用例不动 | 全部 |
| 13 | `tests/ui.spec.ts:220-302` | settings 校验测试补三字段 | 全部 |
| 14 | `docs/design.md §7`（`:241-293`） | 实现后同步双语规划章节 | 全部 |

**明确不改**（以当前代码为准）：

- `src/sanitize.ts`（管线 `src/index.ts:1038 → 464` 之前）：策略 4 只作用于 sanitize
  后的纯文本，不改变管线输入源头。
- `src/bilingual.ts:73-80` `filterSentences`、`:88-92` `voiceForVoices`、VoiceRun
  合并规则（`:168-171`）、各 provider 合成逻辑。

## 非目标

- 不做词性/语义级分段（不引入 NLP 库）。
- 不改 `bilingual` 模式（`both`/`english_only`/`chinese_only`）的既有过滤语义。
- 不改各 provider 的音色分配与 VoiceRun 合并规则（策略选择只影响“切分/抑制”的输入）。

## § 与代码现状的核对结果（历史记录，2026-08-19 三路 review）

> 本节约束定稿内容：策略 4 的分段符号范围、策略 2 的行为描述均已按此核对结论修订。
> 以下仅作决策依据存档，不再单独维护。

### 已实现且与草稿一致

| 草稿表述 | 代码/测试证据 | 结论 |
|---|---|---|
| 现状为句子级管线（切句 → 判定 → 过滤 → 音色分配） | `src/bilingual.ts:158-160` | 一致 |
| both 全读；限定模式过滤 mixed 与非目标语言 | `src/bilingual.ts:77-80`、`tests/bilingual.spec.ts:65-88` | 一致 |
| 相邻同音色同参数合并 VoiceRun | `src/bilingual.ts:168-171`、`tests/bilingual.spec.ts:139-187` | 一致 |
| classifySentence 用 `[一-鿿]`/`[A-Za-z]` 判 zh/en/mixed | `src/bilingual.ts:43-44, 55-65`、`tests/bilingual.spec.ts:57-63` | 一致 |
| mixed 音色回退链 mixed→zh→fallback | `src/bilingual.ts:91`、`tests/bilingual.spec.ts:90-110` | 一致 |
| sentence-splitter 切句（换行不是句界） | `src/bilingual.ts:47-52`、`tests/bilingual.spec.ts:52-54` | 一致 |

### 草稿与代码现状不符 / 需修正的点

1. **策略 4「单个换行」作分段符 ↔ 既有已测决策「换行不是句界」直接冲突**：
   `docs/sentence-splitting-selection.md:63-68` 明确接受“换行不再是句界（对 TTS 更正确）”，
   `tests/bilingual.spec.ts:52-54` 已固化。**以当前代码为准**：策略 4 不提供换行分段。
2. **策略 4 依赖的 Markdown/空行结构在 sanitize 阶段已被剥除/压缩**：`sanitizeForSpeech`
   先于 `planBilingualSpeech`（`src/index.ts:1038 → 464`），Markdown 标题/列表/引用/
   代码块被剥为纯文本（`src/sanitize.ts:133-155`），连续换行被压成单个换行
   （`src/sanitize.ts:157-166`）。**以当前代码为准**：策略 4 不提供这些预置分段符，
   只保留「自定义可见字符组合」（sanitize 后仍可见）。
3. **策略 1 当前无 off 模式**：`BilingualMode` 仅三值（`src/types.ts:128`），
   “关闭”是全新枚举，草稿已注明实现状态。
4. **背景省略 `voice_profiles` 环节**：管线先经 `effectiveVoices` 做 per-voice profile
   整体替换（`src/bilingual.ts:144-150`），草稿已补充。
5. **VoiceRun 合并不比较语言类别**：zh/en 解析到同一音色且同参数时会跨语言合并，
   `run.lang` 被当前句覆盖（`src/bilingual.ts:168-171`），草稿策略 2 已补充该细节。
6. **策略 2 示例隐含“已配置 en 音色”前提**：缺省回退时英文句仍用统一 `voice_type`
   （`src/bilingual.ts:89-90`），示例表已加注。
7. **`docs/design.md:247`「文本先按段落/句末符切句」措辞过时**：代码无段落切分，
   与“换行不是句界”一致。以当前代码为准，本草稿不引入段落切分措辞；若后续策略 4 落地，
   仅作用于 sanitize 后的纯文本（自定义可见字符分段），不改变管线输入源头。

### 全新未实现（策略 1/3/4 及配套）

- 策略选择配置字段：`BilingualVoiceConfig`（`src/types.ts:203-212`）无 strategy/segment
  字段；6 个 provider schema、config template、`DEFAULT_SETTINGS`、面板 `BilingualFields`
  （`src/web-ui/panel/src/api.ts:55-60`）均无痕迹。
- 策略 3 的脚本区段扫描、阈值常量、夹杂抑制、主导语言判定：零痕迹。
- 策略 4 的分段符号配置、窗口切分、fallback：零痕迹。
- 异语言片段行为 `skip` / `dominant-voice`：两者均无对应配置或逻辑。
- 配套测试：`tests/bilingual.spec.ts`（195 行）仅覆盖策略 2 语义，无策略 1/3/4 用例。

### 配置落点倾向（review 结论，已定案于「§ 定案决策」5）

`bilingual` 是 `BilingualVoiceConfig` 的共享字段，逐 provider 挂 schema、面板每卡片一个
下拉、`deliveryView` 按当前 provider 取值——策略选择字段做成 `BilingualVoiceConfig`
的字段（`segment_strategy`）与之完全同构，是最自然的落点。