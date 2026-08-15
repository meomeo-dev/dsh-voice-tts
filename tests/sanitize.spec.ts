import { describe, expect, it } from 'vitest'
import { CODE_BLOCK_PHRASE, CODE_ONLY_PHRASE, sanitizeForSpeech } from '../src/sanitize.js'

describe('sanitizeForSpeech', () => {
  it('strips heading/list/quote/emphasis markers from prose', () => {
    const text = sanitizeForSpeech('# 标题\n\n- 第一点\n- 第二点\n\n> 引用一句')
    expect(text).toBe('标题\n第一点\n第二点\n引用一句')
  })

  it('reads inline code and links text', () => {
    const text = sanitizeForSpeech('用 `npm install` 安装,详见 [官网](https://x.com)。')
    expect(text).toContain('用 npm install 安装')
    expect(text).toContain('官网')
    expect(text).not.toContain('`')
    expect(text).not.toContain('https://x.com')
  })

  it('replaces a fenced code block with the code-block phrase', () => {
    const text = sanitizeForSpeech('这是正文。\n```js\nconst x = 1\n```\n这是结尾。')
    expect(text).toContain('这是正文。')
    expect(text).toContain(CODE_BLOCK_PHRASE)
    expect(text).toContain('这是结尾。')
    expect(text).not.toContain('const x')
  })

  it('returns the code-only phrase for a whole fenced block', () => {
    expect(sanitizeForSpeech('```js\nconst x = 1\n```')).toBe(CODE_ONLY_PHRASE)
  })

  it('returns the code-only phrase for a whole JSON reply', () => {
    expect(sanitizeForSpeech('{"a": 1, "b": [1,2,3]}')).toBe(CODE_ONLY_PHRASE)
  })

  it('returns the code-only phrase for a whole SQL reply', () => {
    expect(sanitizeForSpeech('SELECT id, name FROM users;\nWHERE age > 18;')).toBe(CODE_ONLY_PHRASE)
  })

  it('returns the code-only phrase for a whole YAML reply', () => {
    expect(sanitizeForSpeech('name: demo\nversion: 1\nitems:\n  - a\n  - b')).toBe(CODE_ONLY_PHRASE)
  })

  it('strips HTML tags and drops script/style bodies', () => {
    const text = sanitizeForSpeech('<p>你好</p><script>alert(1)</script><style>body{}</style>世界')
    expect(text).toContain('你好')
    expect(text).toContain('世界')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('<p>')
  })

  it('keeps prose but omits an indented code block', () => {
    const text = sanitizeForSpeech('说明如下:\n\n    const x = 1\n    const y = 2\n\n以上。')
    expect(text).toContain('说明如下')
    expect(text).toContain('以上')
    expect(text).not.toContain('const x')
  })

  it('returns an empty string for whitespace-only input', () => {
    expect(sanitizeForSpeech('   \n  ')).toBe('')
  })
})
