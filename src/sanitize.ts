/**
 * 把模型返回的 markdown/HTML/代码块净化为「适合朗读的纯文本」(纯函数,不 import cordis)。
 *
 * 规则(对齐产品需求):
 * - HTML 标签剥离(script/style 整段丢弃),仅保留可读文本。
 * - 代码块(fenced ```...``` / ~~~...~~~ 与缩进代码块)**不朗读**,替换为「相关代码块可查看消息」。
 * - 行内代码 `code` **可朗读**,仅去掉反引号保留内容。
 * - 整条回复就是代码 / JSON / SQL / YAML 时,整条替换为「消息返回了代码原文…」,不逐字念。
 * - 常规 inline markdown(标题/列表/引用/链接/强调/删除线/表格)剥为纯文本。
 * @module dsh-voice-tts/sanitize
 */

/** 整条回复是代码/JSON/SQL/YAML 时的替代语。 */
export const CODE_ONLY_PHRASE = '消息返回了代码原文，建议你阅读消息，我就不一一念出来了'

/** 正文中的代码块(非行内)被替换为该短语。 */
export const CODE_BLOCK_PHRASE = '相关代码块可查看消息'

/** 分片:prose(可朗读正文)或 code(代码块,不朗读)。 */
interface Segment {
  readonly kind: 'prose' | 'code'
  readonly text: string
}

/** 去掉 HTML 标签;script/style 整段丢弃;块级标签换行;解码常见实体。 */
function stripHtml(input: string): string {
  let out = input.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  out = out.replace(/<\/(p|div|li|h[1-6]|pre|blockquote|tr|table)\b[^>]*>/gi, '\n')
  out = out.replace(/<br\s*\/?\s*>/gi, '\n')
  out = out.replace(/<[^>]*>/g, ' ')
  return out
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
}

/**
 * 把文本按 fenced 代码块切分为 prose/code 分片。fence 是行首 ``` 或 ~~~(≥3 个),
 * 开启行可带语言标识;关闭行是同一字符、长度 ≥ 开启的裸行。
 */
function splitFenced(text: string): Segment[] {
  const lines = text.split('\n')
  const segments: Segment[] = []
  let prose = ''
  let code: string[] | null = null
  let fenceChar = ''
  let fenceLen = 0

  const flushProse = (): void => {
    if (prose.length > 0) {
      segments.push({ kind: 'prose', text: prose })
      prose = ''
    }
  }

  for (const line of lines) {
    if (code === null) {
      const open = /^\s*(`{3,}|~{3,})/.exec(line)
      if (open !== null) {
        flushProse()
        fenceChar = open[1]![0]!
        fenceLen = open[1]!.length
        code = []
      } else {
        prose += `${line}\n`
      }
    } else {
      const close = new RegExp(`^\\s*${escape(fenceChar)}{${fenceLen},}\\s*$`).exec(line)
      if (close !== null) {
        segments.push({ kind: 'code', text: code.join('\n') })
        code = null
      } else {
        code.push(line)
      }
    }
  }
  if (code !== null) {
    // 未闭合 fence:剩余内容整体当作代码块。
    segments.push({ kind: 'code', text: code.join('\n') })
  } else {
    flushProse()
  }
  return segments
}

/** 转义正则特殊字符(此处仅 fence 字符 ` 或 ~)。 */
function escape(ch: string): string {
  return ch === '`' ? '`' : '~'
}

/** 是否整条文本是「代码原文」(JSON / SQL / YAML / 缩进代码),不该逐字朗读。 */
function looksLikeRawCode(text: string): boolean {
  const t = text.trim()
  if (t.length === 0) return false
  const lines = t.split('\n').map(line => line.trimEnd()).filter(line => line.trim().length > 0)
  if (lines.length < 2) return false
  // 含句子终止符的通常是自然语言,不算「代码原文」。
  if (/[。！？.!?]/.test(t)) return false
  const head = lines[0]!.trim()
  // SQL 动词开头。
  if (/^(select|insert|update|delete|create|alter|drop|with|from|where|merge|grant|revoke)\b/i.test(head)) return true
  // YAML:`key:` 或 `- item` 的连续行(允许前导空白)。
  if (lines.every(line => /^\s*[\w./-]+:\s?/.test(line) || /^\s*- /.test(line))) return true
  // 每行以分号结尾(典型代码行)。
  return lines.every(line => /;\s*$/.test(line))
}

/** 是否整条回复就是代码:单个 fenced 块 / JSON / 缩进代码 / 原始 SQL·YAML。 */
function isEntirelyCode(text: string): boolean {
  const t = text.trim()
  if (t.length === 0) return false
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      JSON.parse(t)
      return true
    } catch {
      // 不是合法 JSON,继续后续判定。
    }
  }
  const segments = splitFenced(t)
  const proseOnly = segments.filter(segment => segment.kind === 'prose').map(segment => segment.text).join('').trim()
  if (segments.some(segment => segment.kind === 'code') && proseOnly.length === 0) return true
  // 整段缩进代码(每行 ≥4 空格或 tab)。
  const lines = t.split('\n').filter(line => line.trim().length > 0)
  if (lines.length > 0 && lines.every(line => /^( {4}|\t)/.test(line))) return true
  return looksLikeRawCode(t)
}

/** 剥离常规 inline markdown(标题/列表/引用/链接/强调/删除线/行内代码/表格)。 */
function stripInlineMarkdown(text: string): string {
  let out = text
  // 图片 → alt 文本;链接 → 链接文字。
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 行级标记:标题、引用、无序/有序列表、分隔线。
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '')
  out = out.replace(/^\s{0,3}>\s?/gm, '')
  out = out.replace(/^\s{0,3}[-*+]\s+/gm, '')
  out = out.replace(/^\s{0,3}\d+[.)]\s+/gm, '')
  out = out.replace(/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/gm, '')
  // 表格:分隔行(仅 | - : 空白)删除,普通行去掉竖线。
  out = out.replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
  out = out.replace(/\|/g, ' ')
  // 强调/删除线/行内代码。
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1')
  out = out.replace(/__([^_]+)__/g, '$1')
  out = out.replace(/~~([^~]+)~~/g, '$1')
  out = out.replace(/`([^`\n]+)`/g, '$1')
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
  out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2')
  return out
}

/** 折叠空白:空格/制表符压成单空格,连续换行压成单个换行,首尾去空。 */
function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .join('\n')
}

/**
 * 把缩进代码块(行首 ≥4 空格或 tab 的连续行,且不含句子终止符)替换为占位语。
 * 仅替换「无句子终止符」的缩进段,避免把缩进的正文/列表续行误判为代码。
 */
function replaceIndentedCodeBlocks(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let block: string[] = []
  const flush = (): void => {
    if (block.length === 0) return
    const isCode = block.every(line => !/[。！？.!?]/.test(line))
    if (isCode) out.push(CODE_BLOCK_PHRASE)
    else out.push(...block)
    block = []
  }
  for (const line of lines) {
    if (/^( {4}|\t)/.test(line)) block.push(line)
    else {
      flush()
      out.push(line)
    }
  }
  flush()
  return out.join('\n')
}

/**
 * 把模型返回的 markdown/HTML 净化为可朗读文本。
 * @param markdown - 模型原始返回(可能含 markdown / HTML / 代码块)。
 * @returns 可朗读纯文本;整段是代码时返回 {@link CODE_ONLY_PHRASE},无内容时返回空串。
 */
export function sanitizeForSpeech(markdown: string): string {
  const text = stripHtml(markdown)
  if (text.trim().length === 0) return ''
  if (isEntirelyCode(text)) return CODE_ONLY_PHRASE

  const segments = splitFenced(text)
  const parts: string[] = []
  let hasProse = false
  for (const segment of segments) {
    if (segment.kind === 'code') {
      parts.push(CODE_BLOCK_PHRASE)
      continue
    }
    const cleaned = collapseWhitespace(stripInlineMarkdown(replaceIndentedCodeBlocks(segment.text)))
    if (cleaned.length > 0) {
      hasProse = true
      parts.push(cleaned)
    }
  }
  if (!hasProse) return CODE_ONLY_PHRASE
  return parts.join('\n')
}
