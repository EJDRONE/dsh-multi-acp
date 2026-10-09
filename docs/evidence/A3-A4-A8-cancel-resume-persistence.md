# A3 · A4 · A8 · 取消 / 恢复 / 持久化（会话生命周期）

> 执行日期：2026-10-08
> **证据源**：官方源码稀疏克隆 `refs/harness`（HEAD `dsh-v0.2.1-alpha.1`）。
> 三者在官方实现里本就耦合（`agent-loop/src/index.ts` 的 dispose / resume / prepare）。

---

## A3 · 取消语义

### 结论：DSH 0.2.x **没有** `agent/canceled` 事件

ROADMAP 原先写的 "`session/cancel` + `agent/canceled` 语义" 来自 grok/AionCore 的旧词汇。
在 `packages/core/agent/src/runtime-types.ts` 的 `AgentSubjectEventMap` 里，
取消相关的**事件**只有 inbox 三件套（`inserted` / `claimed` / `discarded`）与 `agent/status`、
`agent/disposed`。**没有** `agent/canceled`。

取消的**唯一**表达是三件事：

| 载体 | 内容 | 位置 |
| --- | --- | --- |
| `Agent.cancel(cause, { keepInbox })` | 中止活动 turn；`keepInbox` 时保留未开始的工作、且**不记** canceled splice | runtime-types.ts:37-45 |
| `turn/end` | `{ kind: 'aborted', reason: AgentCancelCause }` | types.ts:204（A5 已落） |
| `agent/inbox/spliced` | 被丢弃消息带 `outcome: 'canceled'` | agent/src/types.ts:96-102 |

### inbox 丢弃语义（`agent-loop/src/inbox.ts:197-243`）

```ts
const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' : undefined
session.append('agent/inbox/spliced', { target, start, removedCount?, inserted, outcome? })
if (discardRemoved) for (const m of removed) dispatch.emit('agent/inbox/discarded', { message: m })
for (const m of event.data.inserted) dispatch.emit('agent/inbox/inserted', { message: m })
```

- `discardRemoved=true`：`clear()` / `replace()` / `remove()` / 公共 `splice()`。
- `discardRemoved=false`：`claim()`（认领 = 消费，不是丢弃）。

### 本插件改动

- `createAcpInbox` 重写为带 `discardRemoved` 的 `mutate()`；`clear/replace/remove` 走 true，
  `append/prepend` 与新增的 `consume()` 走 false；插入消息发 `inserted`，丢弃消息发 `discarded`。
- `_claim` 由 `splice(...)` 改为 `consume(...)` —— **修复**：此前认领会把已认领消息误记为
  `outcome:'canceled'` 并发 `discarded`。
- `discarded`/`inserted` 通过 late-bound `inboxEmit` 接到 `agentEvents(rootCtx, agent)` 的 dispatch
  （inbox 先于 dispatch 创建，dispatch 依赖 agent）。

---

## A8 · 会话持久化（此前**完全没接**）

### 契约（`agent-loop/src/index.ts:652-706, 754-780`）

```ts
// create
using preparation = SessionPreparation.create(ctx.sessions.prepare(id, { meta }))
const stored = await this.createStoredSession(preparation.session)   // persistence.create(header)
... setup ...
await this.appendUnstoredSuffix(stored, preparation.session)        // 发布前补齐未存后缀
await prepared.publish('startup')                                    // enter + announce
// dispose: ... await handle.close()  ← close 会 drain
```

**关键**（index.ts:618-622 注释）：

> The mounted backend routes announced live events into the active write handle by session id;
> the loop only owns the handle itself.

⇒ agent 侧**不需要**逐条 `handle.append`；`sessions.announce(session)` 之后由持久化后端
按 sessionId 自动路由。agent 侧只需：create/open 句柄 → `appendUnstoredSuffix` → `close`。

服务：`SessionPersistence extends Service { super(ctx, 'sessionPersistence') }`，
`create(header, { inheritedEventCount, signal? })` / `open(id, 'read'|'write')` / `handle.read/append/flush/close`。

### 本插件改动

- 新增 `readPersistence(ctx)`（`ctx.get('sessionPersistence')`，缺失则降级）。
- create 路径：`persistence.create(session.header, { inheritedEventCount })` → `stored`。
- 发布前 `appendUnstoredSuffix(stored, session)`（`session.snapshotEvents(offset)`，
  照 index.ts:698-706）。
- 所有失败/销毁路径 `stored?.handle.close()`；`dispose()` 在最后 close（drain）。

---

## A4 · 会话恢复（发现**两个 bug**）

### bug 1 · 身份字段用错

```ts
// CreateAgentOptions        → readonly sessionId: SessionId
// ResumeAgentOptions        → readonly resumeSessionId: SessionId   （没有 sessionId！）
```

原代码 `const sessionId = options.sessionId` 在 resume 时恒为 `undefined` ⇒
`sessions.prepare(undefined)` ⇒ **偷偷新建了一个会话**，"恢复"从未发生。

### bug 2 · 没有 seed（不读持久化日志）

原 resume 只 `sessions.prepare(sessionId, { seed: options.seed })`，而 `ResumeAgentOptions`
没有 `seed` ⇒ 恢复出来是**空会话**。

### 官方 resume（`agent-loop/src/index.ts:807-890`）

```ts
const handle = await persistence.open(id, 'write', { signal })
const coldRead = await handle.read(0)
const persisted = coldRead.events
const closers = interruptedTurnClosers(persisted)          // 崩溃孤儿 turn 的合成收尾
if (closers.length > 0) await handle.append(closers)
preparation = SessionPreparation.create(ctx.sessions.prepare(id, {
  seed: [...persisted, ...closers],
  meta: structuredClone(handle.header),
  inheritedEventCount: handle.inheritedEventCount,
  eventState: coldRead.eventState,
}))
stored = { handle, storedCount: persisted.length + closers.length }
await this.appendUnstoredSuffix(stored, preparation.session)
```

`interruptedTurnClosers` 由 `@deepseek-ai/dsh-session` 导出（index.ts:32，实现 repair.ts:209）。

### ACP sessionId 映射（本插件特有）

DSH 的 `resumeSessionId` 是 **DSH** 会话 id；ACP `session/load` 需要的是**引擎侧** id。
二者不同，且引擎进程重启后其内存映射也没了 ⇒ 必须持久化映射。

- 新增 `lib/session-map.js`：`<stateDir>/sessions.json`，
  `{ sessions: { <dshSessionId>: { engineId, acpSessionId, cwd, updatedAt } } }`；先写 `.tmp` 再 rename。
- create / resume 成功后 `writeSessionMap(...)`。
- resume：`readSessionMap(...)` 取 `acpSessionId` → `host.resumeSession()` → `client.loadSession()`。
- **映射缺失或 `load` 失败 ⇒ 退回新建 ACP 会话并告警**，**不**让工厂降级到官方 loop
  （否则会静默把引擎换掉 —— 正是 0.1.4 附注的教训）。

---

## 验证清单（运行时待做）

1. **A3**：长任务中途点停止 → 会话里出现 `turn/end { kind:'aborted' }`；被丢弃的待处理消息
   出现 `agent/inbox/spliced { outcome:'canceled' }`。
2. **A4**：创建一个 ACP 会话跑一轮 → 重启 DSH → 重新打开该会话 → 历史仍在，
   且引擎侧上下文续上（引擎收到 `session/load`，我们侧 `sessions.json` 命中）。
3. **A8**：`<DSH_HOME>\sessions\**.jsonl.zstd` 有该会话；`sessionPersistence.list()` 能列出。
