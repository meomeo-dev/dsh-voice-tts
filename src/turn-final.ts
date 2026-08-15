/**
 * turn-final 播报的后端提取(纯函数,不 import cordis)。
 * 从会话事件里取出某个 turn 最后一条带可见文本的 assistant 消息。
 * @module dsh-voice-tts/turn-final
 */

/** 会话事件的最小结构形状(便于单测与解耦,无需 dsh 运行时)。 */
export interface TurnEventLike {
  readonly type: string
  readonly data?: {
    readonly turn?: number
    readonly step?: number
    readonly message?: {
      readonly content?: readonly {
        readonly type?: string
        readonly text?: string
      }[]
    }
  }
}

/** 从一条 assistant 消息的 content 里提取可见文本(空则返回 undefined)。 */
function visibleText(message: NonNullable<TurnEventLike['data']>['message']): string | undefined {
  const text = (message?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
  return text.length > 0 ? text : undefined
}

/**
 * 提取某 turn 最后一条带可见文本的 assistant 消息文本。
 * 倒序遍历,跳过无文本的 tool-call-only 消息,返回最后一条可见回复。
 * @param events - 会话事件(按 seq 升序)。
 * @param turn - 目标 turn 号。
 * @returns 最终回复文本;无可见回复则返回 undefined。
 */
export function finalAssistantText(events: readonly TurnEventLike[], turn: number): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'assistant/message' || event.data?.turn !== turn) continue
    const text = visibleText(event.data.message)
    if (text !== undefined) return text
  }
  return undefined
}
