/**
 * ACP 会话的 Inbox —— **由我们（driver）自己实现存储**。
 *
 * 后端是 `agent/inbox/spliced` 事件（契约：`runtime-types.ts:47-100`）。
 * 抽成独立模块的理由：它只依赖注入进来的 `session` / `projections` / `logger` / `emit`，
 * 不闭包 `acp-agent.js` 里的任何状态；而"谁拥有待处理输入"与"怎么装配 agent"是两件事。
 *
 * ⚠️ 两条契约细节都在下面注释里，别当样式改掉：
 *   · `discardRemoved=true`（clear / replace / remove / splice）⇒ 被移除的消息记
 *     `outcome: 'canceled'` 并发 `agent/inbox/discarded`；
 *   · `discardRemoved=false`（driver 认领）⇒ 只 splice，不记 outcome、不发 discarded。
 *
 * @module dsh-multi-acp/acp-inbox
 */

/* ═══════════════════════════════════════════════════════════════════════
 * Inbox —— 由我们（driver）实现存储，后端是 `agent/inbox/spliced` 事件
 * 契约：runtime-types.ts:47-100
 * ═══════════════════════════════════════════════════════════════════════ */

export function createAcpInbox({ session, projections, logger, emit }) {
  const stateOf = () =>
    projections?.stateOf?.(session, 'inbox') ?? { 'next-turn': [], 'next-step': [] }

  const listOf = (target) => stateOf()[target] ?? []

  /**
   * 唯一的写入口：append 一个 `agent/inbox/spliced` 事件。
   *
   * A3 契约（agent-loop/src/inbox.ts:197-243）：
   *   - `discardRemoved=true`（clear / replace / remove / 公共 splice）⇒
   *     被移除的消息标记 `outcome: 'canceled'` 并发 `agent/inbox/discarded`。
   *   - `discardRemoved=false`（claim 认领）⇒ 只 splice，不记 outcome、不发 discarded。
   *   - 插入的消息一律发 `agent/inbox/inserted`。
   */
  const mutate = (target, start, deleteCount, inserted, discardRemoved) => {
    const current = listOf(target)
    const removed = current.slice(start, start + deleteCount)
    const outcome = discardRemoved && removed.length > 0 ? 'canceled' : undefined
    const event = session.append('agent/inbox/spliced', {
      target,
      start,
      ...(removed.length === 0 ? {} : { removedCount: removed.length }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    })
    if (discardRemoved) {
      for (const message of removed) emit?.('agent/inbox/discarded', { message })
    }
    for (const message of event.data.inserted) emit?.('agent/inbox/inserted', { message })
    return removed
  }

  return {
    get nextTurn() {
      return listOf('next-turn')
    },
    get nextStep() {
      return listOf('next-step')
    },
    clear() {
      // 契约要求：先清 next-step，再清 next-turn；清空即"丢弃"（outcome canceled）
      for (const target of ['next-step', 'next-turn']) {
        const items = listOf(target)
        if (items.length) mutate(target, 0, items.length, [], true)
      }
    },
    append(target, message) {
      mutate(target, listOf(target).length, 0, [message], false)
    },
    prepend(target, message) {
      mutate(target, 0, 0, [message], false)
    },
    replace(messageId, newMessage) {
      for (const target of ['next-step', 'next-turn']) {
        const items = listOf(target)
        // A6：UserMessage 的身份字段是 `id: MessageId`（不是 `messageId`）——
        // 见 llm/llm/src/message.ts:139-148（MessageBase）。
        const idx = items.findIndex((m) => m?.id === messageId)
        if (idx >= 0) {
          mutate(target, idx, 1, [newMessage], true)
          logger?.debug?.(`acp-inbox: replaced ${String(messageId)}`)
          return true
        }
      }
      return false
    },
    remove(messageId) {
      for (const target of ['next-step', 'next-turn']) {
        const items = listOf(target)
        const idx = items.findIndex((m) => m?.id === messageId)
        if (idx >= 0) {
          mutate(target, idx, 1, [], true)
          return true
        }
      }
      return false
    },
    /** 非丢弃式认领（driver 用）：不记 `outcome`、不发 `discarded`（照 agent-loop claim）。 */
    consume(target, count) {
      return mutate(target, 0, count, [], false)
    },
    splice(target, start, deleteCount, inserted) {
      return mutate(target, start, deleteCount, inserted, true)
    },
  }
}
