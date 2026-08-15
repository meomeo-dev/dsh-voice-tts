import { describe, expect, it } from 'vitest'
import { finalAssistantText } from '../src/turn-final.js'
import type { TurnEventLike } from '../src/turn-final.js'

function assistant(turn: number, text: string): TurnEventLike {
  return {
    type: 'assistant/message',
    data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
  }
}

function toolCallOnly(turn: number): TurnEventLike {
  return {
    type: 'assistant/message',
    data: { turn, step: 2, message: { content: [{ type: 'tool_call' }] } },
  }
}

function turnEnd(turn: number): TurnEventLike {
  return { type: 'turn/end', data: { turn } }
}

describe('finalAssistantText', () => {
  it('extracts the last visible assistant text for a turn', () => {
    const events: TurnEventLike[] = [
      assistant(1, '这是回复。'),
      turnEnd(1),
      assistant(2, 'second reply'),
      turnEnd(2),
    ]
    expect(finalAssistantText(events, 2)).toBe('second reply')
  })

  it('skips tool-call-only messages and returns the last visible text', () => {
    const events: TurnEventLike[] = [
      assistant(1, 'tool loop start'),
      toolCallOnly(1),
      assistant(1, 'final visible reply'),
      turnEnd(1),
    ]
    expect(finalAssistantText(events, 1)).toBe('final visible reply')
  })

  it('concatenates multiple text blocks', () => {
    const events: TurnEventLike[] = [{
      type: 'assistant/message',
      data: {
        turn: 1,
        message: { content: [{ type: 'text', text: '第一段 ' }, { type: 'text', text: '第二段' }] },
      },
    }]
    expect(finalAssistantText(events, 1)).toBe('第一段 第二段')
  })

  it('ignores reasoning blocks and non-target turns', () => {
    const events: TurnEventLike[] = [
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: '可见' }] } } },
      assistant(2, 'other turn'),
    ]
    expect(finalAssistantText(events, 1)).toBe('可见')
  })

  it('returns undefined when no visible assistant message exists', () => {
    expect(finalAssistantText([toolCallOnly(1)], 1)).toBeUndefined()
    expect(finalAssistantText([turnEnd(1)], 1)).toBeUndefined()
    expect(finalAssistantText([], 1)).toBeUndefined()
  })
})
