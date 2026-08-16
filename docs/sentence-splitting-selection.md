# 中英双语分句库选型评估

## 背景

`dsh-voice-tts` 的 `src/bilingual.ts` 目前用手写启发式切句：`segmentSentences`
先按空行分段、段内按句末符 `。！？；!?` 切，英文 `.` 再过一个手写缩写白名单
`EN_ABBREV`(24 词)与小数/省略号判定。这套逻辑对中英双语场景偏弱——英文表外缩写、
引号/括号后的句界、编号列表等都会漏判或误判。

本次选型目标是找一个**成熟、同时正确处理中文与英文句界**的分句库,替换手写实现。

## 候选与元信息

| 候选 | 最新版 | 最后更新 | License | 依赖 | 备注 |
|---|---|---|---|---|---|
| `Intl.Segmenter`(内置) | — | 随 Node/ICU | 内置 | 无 | UAX #29,零依赖 |
| `sentence-splitter` | 5.0.1 | 2026-04 | MIT | `@textlint/ast-node-types`、`structured-source` | textlint 生态,明确支持多语言 |
| `sbd` | 1.0.19 | 2022-06 | MIT | 无 | 斯坦福规则移植,英文专用 |
| `compromise` | 14.16.0 | 2026-07 | MIT | 若干 | 全功能 NLP,偏重 |

## 评估方法

在临时目录 `npm install` 上述四个实现,跑同一组 13 条中英双语难点用例(英文缩写、
小数/版本、引号、括号、e.g.、中文标准、中文无标点、中英混合、中英同行、换行、编号
列表、省略号、LLM 典型输出),对比切分结果。

## 结果(关键差异)

| 场景 | 结果 |
|---|---|
| 英文缩写 `Mr.` / `Dr.` / `e.g.` | **Intl.Segmenter 破句**(把 `Mr.`、`Dr.`、`e.g.` 当句尾);其余三者正确 |
| 编号列表 `1. 第一点` | Intl.Segmenter 把 `1.` 当句尾;sentence-splitter 有 `2.` 边缘瑕疵;其余正确 |
| 中文 `。？！` | **sbd / compromise 完全不切中文**;Intl.Segmenter 与 sentence-splitter 正确 |
| 中英混合/同行 | sentence-splitter 与 Intl.Segmenter 正确;sbd / compromise 中文部分不切 |
| 引号句 `He said "I am fine." Then he left.` | Intl.Segmenter / sbd 正确切;compromise / sentence-splitter 未切 `Then he left.` |

结论:四个实现里,**只有 `sentence-splitter` 同时正确切中英文**。Intl.Segmenter 的
UAX #29 句界规则对英文缩写处理差(TTS 会读出破碎短句),sbd / compromise 缺少中文
句末符规则。

## 最终选型:`sentence-splitter`

理由:

1. **中英双语正确性最好**:内置庞大的英文缩写表 + 中文句末符规则,是唯一两全的实现。
2. **活跃维护**:textlint 生态核心组件,2026-04 仍在发版(对比 `sbd` 停更 4 年)。
3. **工程友好**:MIT、纯 JS 无二进制、有 `.d.ts` 类型、ESM `module` 入口、依赖仅两个
   textlint 小包,可被 tsdown 打进 client closure bundle。
4. **删除自有代码**:替换掉手写的 `segmentSentences` + `isTerminal` + `isAbbrevPeriod`
   + `EN_ABBREV` 约 60 行及对应测试,符合仓库「prefer maintained deps over hand-rolling」政策。

`classifySentence`(按 CJK/Latin 判定 `zh`/`en`/`mixed`)是项目独有的语言归类,库不覆盖,保留。

## 接入方案

- `src/bilingual.ts`:`analyzeBilingual` 改为 `split(text)` → 过滤 `type === 'Sentence'`
  节点取 `raw`;删除手写切句函数;`classifySentence` 及后续 `filterSentences` /
  `planBilingualSpeech` 不变。
- `tests/bilingual.spec.ts`:`segmentSentences` 的 describe 改为覆盖库行为(缩写/小数/
  中英混合仍成立),换行用例语义变更(见下)。
- `package.json`:新增 `sentence-splitter` 依赖。

### 行为差异(需接受)

1. **换行不再是句界**:手写实现把 `\n` 当段界(`'第一行\n第二行。'` → 两句),库只按
   句末标点切(`'第一行\n第二行。'` → 一句)。对 TTS 更正确(换行不是句界)。
2. **编号列表边缘 case**:`'1. 第一点。2. 第二点。'` 中 `2.` 会被单独切成一句。
   与手写实现对 `1.`/`2.` 的处理各有瑕疵,可接受。

## 非目标

- 不做 `classifySentence` 之外的词性/语义分析(不需要 compromise 那样的 NLP)。
- 不做 sentence-splitter 的 AST(`splitAST`)消费,只用 `split` 的句子文本。
- 不改 `filterSentences` / `planBilingualSpeech` 的既有音色分配与合并逻辑。
