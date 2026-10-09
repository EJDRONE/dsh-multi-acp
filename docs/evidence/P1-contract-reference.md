# P1 契约参考（DSH 0.2.0-rc.2）

> **权威来源**：`github.com/deepseek-ai/deepseek-harness` 的 TypeScript 源码（公开，MIT）
> 本地稀疏克隆：`<会话临时目录>/refs/harness`
> 全篇所有签名均**逐字摘自源码**，附 `文件:行号`。执行日期：2026-10-07

**状态：三个阻塞点全部清零。** 本文档是 `lib/acp-agent.js` 的实现依据。

---

## 1. `Agent` 接口

### 1.1 基接口 —— `packages/core/agent/src/types.ts:14-18`

```ts
/** Public live-agent handle; the runtime face augments its live capabilities. */
export interface Agent {
  /** Session-backed Agent identity. */
  readonly id: SessionId
}
```

### 1.2 运行时面孔 —— `packages/core/agent/src/runtime-types.ts:163-260`

```ts
declare module './types.ts' {
  interface Agent {
    /** The provider route and model this agent's requests use. */
    readonly options: AgentOptions
    /** The live session this agent drives; its log is the durable source of truth. */
    readonly session: Session
    /** Agent-owned access to durable pending work. */
    readonly inbox: Inbox
    /** The current lifecycle state, mirrored on every `agent/status` transition. */
    readonly status: AgentStatus
    /** Agent-scoped context; its contributions are agent-local, unwind on disposal. */
    readonly ctx: Context

    cancel(cause: AgentCancelCause, options?: CancelOptions): void
    whenIdle(): Promise<void>
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
    send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
    followup(message: UserMessage): void
    steer(message: UserMessage): void
    inject(message: UserMessage): void
  }
}
```

### 1.3 相关类型

| 类型 | 定义 | 位置 |
| --- | --- | --- |
| `AgentStatus` | `'idle' \| 'running'` | runtime-types.ts:109 |
| `InboxTarget` | `'next-turn' \| 'next-step'` | types.ts:39 |
| `InboxState` | `{ 'next-turn': readonly UserMessage[]; 'next-step': readonly UserMessage[] }` | types.ts:42-45 |
| `SessionStartSource` | `'startup' \| 'resume' \| 'clear' \| 'compact'` | runtime-types.ts |
| `AssistantStreamFrame` | `start` / `chunk` / `end` 三态 | runtime-types.ts:127-161 |

### 1.4 `AssistantStreamFrame`（流式帧）

```ts
export type AssistantStreamFrame =
  | { readonly type: 'start'; readonly attemptId: LlmAttemptId; readonly revision: number
      readonly turn: number; readonly step: number }
  | { readonly type: 'chunk'; readonly attemptId: LlmAttemptId; readonly revision: number
      readonly index: number; readonly time: number; readonly chunk: StreamChunk }
  | { readonly type: 'end';   readonly attemptId: LlmAttemptId; readonly revision: number
      readonly index: number
      readonly outcome:
        | { readonly kind: 'committed'; readonly eventType: 'assistant/message' | 'assistant/attempt'
            readonly seq: SessionSeq }
        | { readonly kind: 'abandoned' } }
```

---

## 2. `SessionEventMap` —— `packages/core/session/src/types.ts:281-400+`

**这是持久化的真源**（append-only、可回放、损失无损）。消息历史由它派生。

```ts
'turn/start':        { turn: number }
'turn/end':          { turn: number; reason: TurnEndReason }
'step/start':        { turn: number; step: number }
'step/end':          { turn: number; step: number }
'user/message':      UserMessage
'developer/message': { turn: number; step: number; message: DeveloperMessage; headerSeq?: SessionSeq }
'system/message':    { turn: number; step: number; message: SystemMessage }
'assistant/message': {
  turn: number; step: number
  message: AssistantMessage
  /** Exact timed model stream, compacted without joining delta boundaries. */
  stream: AssistantStreamRecord[]
  usage?: TokenUsage
  interrupted?: true
}
'assistant/attempt': { turn: number; step: number; stream: AssistantStreamRecord[] }
'tool/call':         { turn: number; step: number; callId: ToolCallId; name: string; arguments: string }
'tool/result': {
  turn: number; step: number
  message: ToolResultMessage
  error?: { name: string; code: string; reason?: string }   // 仅当 message.isError === true
  meta?: JsonValue                                          // 工具私有，必须 JSON 可序列化
}
'request/header':    { header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true }
'agent/inbox/spliced': {
  target: InboxTarget; start: number; removedCount?: number
  inserted: UserMessage[]; outcome?: 'canceled'
}
```

### 2.1 关键语义（原文摘录）

- `turn/start`：**"Opens turn `turn` before the loop claims queued input or runs pre-step."** 拒绝/空输入/取消可能在没有 step 的情况下关闭它
- `turn/end`：**"A turn with no entered step has no `step/start` or `step/end`."**
- `step/start/end`：**"one model call plus the tool executions it requested"** —— **step = 一次模型调用 + 它请求的工具执行**
- `assistant/message`：**"Assembled assistant message for one step (derived history uses this)."** 携带该 step 的 `usage`；**"there is no separate usage record"**
  - 中途取消的 turn 会把已投递的文本/推理前缀定型为这个事件，带 `interrupted: true`
- `system/message`：loop 在 step 的第一个 `user/message` 之前，把首个系统提示作为 **surface node 0** 追加
- `agent/inbox/spliced`：**"The session-projection registry applies the committed event before `Session.append()` returns; Inbox live notifications follow that commit."**

### 2.2 对本插件的映射（ACP → 会话事件）

| ACP 侧 | DSH 会话事件 |
| --- | --- |
| 收到用户输入（inbox claim） | `turn/start` → `user/message` |
| 开始一次 `session/prompt` | `step/start` |
| `session/update` assistant/thought chunk | **瞬态** `agent/assistant-stream` 帧（不进 log） |
| prompt 返回（`stopReason`） | `assistant/message`（组装后的消息 + `stream` + `usage`） |
| ACP tool call | `tool/call` |
| ACP tool result | `tool/result` |
| 本次 prompt 结束 | `step/end` |
| 无更多待处理工作 | `turn/end` |

---

## 3. 服务签名

### 3.1 `AgentRegistry` —— `packages/core/agent/src/index.ts:245`

```ts
register(agent: Agent): ReturnType<Context['effect']>       // :437
enter(agent: Agent, owner: Agent | undefined): () => void   // :459
get(id: SessionId): Agent | undefined                       // :566
list(): Agent[]                                             // :586
```

**`register` 的实现**（:437-442）——**普通调用者的路径**：

```ts
register(agent: Agent): ReturnType<Context['effect']> {
  return this.ctx.effect(async function* (this: AgentRegistry) {
    yield this.enter(agent, undefined)
    await this.announce(agent, 'startup')
  }.bind(this), 'agents.register()')
}
```

**`enter` 的硬不变量**（:459-477）：

```ts
enter(agent: Agent, owner: Agent | undefined): () => void {
  const id = agent.id
  if (id !== agent.session.id) {
    throw new Error(`agent id "${id}" does not match session id "${agent.session.id}"`)
  }
  const carrier = scopeTarget(agent, agent)
  // This is the authoritative collision boundary.
  if (this.store.has(id)) throw new Error(`agent "${id}" is already registered`)
  ...
}
```

### 3.2 `SessionStore` —— `packages/core/session/src/index.ts:921`

```ts
prepare(id?: SessionId, options?: PrepareSessionOptions): Session   // :1014
enter(session: Session): () => void                                 // :1081
announce(session: Session): void                                    // :1136
```

### 3.3 `agentPresets` —— 见 `docs/evidence/P0-step0-asar-findings.md` §2

```ts
register(definition): Promise<unregister>          // 程序化注册
select(agent, agentPreset): Promise<PresetId>      // 官方锁门
recompose(ctx, id): Promise<preset>                // 重绑空白 agent
mount(ctx, id)                                     // 挂载
```

---

## 4. ⚠️ 三条必须遵守的硬约束

### 4.1 `agent.id === agent.session.id`

`AgentRegistry.enter()` 第 461 行强制检查，不等就抛错。

### 4.2 effect 的 teardown 顺序是**承重**的

`register()` 的注释（:425-436）原文：

> Exact identity is load-bearing: a composite (generator) effect that owns a teardown ORDER — the agent factory's lifecycle chain — must yield THIS function so Cordis nests the unregistration at that yield position; **yielding a wrapper would leave it disposing as a concurrent sibling on owner unload, unregistering the agent (and emitting `agent/disposed`) while its final turn is still draining.**

→ 我们作为 factory 实现，**必须照 agent-loop 的 `setupAndPublish` 模式**：先建 agent（未发布）→ 跑 setup → `enter()` → `announce()`，且把 `enter()` 返回的 detach 闭包**按精确身份**yield 进复合 effect。

### 4.3 `TurnBoundaryProjection` —— ⚠️ **已修正**（早先判断有误）

**早先的判断（错）**：以为我们要自己注册 `TurnBoundaryProjection`。

**实际（源码证实）**：`agent-loop` 插件自己在 `apply` 里注册（`agent-loop/src/index.ts:364-365`）：

```ts
ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
ctx.sessionProjections.register(inboxProjectionDefinition)
```

而它是对会话事件的**纯 fold**（`agent-loop/src/index.ts:57-95`）：

```ts
export const turnBoundaryProjectionDefinition = {
  key: 'turnBoundary',
  stateVersion: 2,
  init: () => ({ openTurnStartSeq: null, lastStepStartSeq: null, lastStepBoundary: null, lastTurn: 0 }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start': return { ...state, openTurnStartSeq: event.seq, lastTurn: event.data.turn }
      case 'turn/end':   return { ...state, openTurnStartSeq: null }
      case 'step/start': return { ...state, lastStepStartSeq: event.seq, lastStepBoundary: { kind: 'start', seq: event.seq } }
      case 'step/end':   return { ...state, lastStepBoundary: { kind: 'end', seq: event.seq } }
      default: return state
    }
  },
} satisfies ProjectionDefinition<'turnBoundary', TurnBoundaryProjection>
```

**结论**：本插件替换的只是 **factory 入口**，`agent-loop` 插件仍然加载 → **projection 已经就绪**。

**我们唯一要做的**：**按正确顺序 append** `turn/start` · `step/start` · `step/end` · `turn/end` 四个事件。锁门语义（`agentPresets.select()` 检查 `openTurnStartSeq !== null || lastTurn > 0`）就自动成立。

> 原 Reader contract 说的 "Without agent-loop no turn events exist" 依然成立 ——
> 它指的是"没有 agent-loop 就没有 turn 事件"，而不是"我们要自己注册 projection"。

### 4.3-bis `Inbox` 是 interface，存储归 driver

`runtime-types.ts:47` 原文：

> **Agent-owned access to pending work; concrete storage belongs to the driver.**
> This is the interface the agent exposes; **the driver implements the storage.**

我们就是 driver → 由我们实现，后端是 `agent/inbox/spliced` 会话事件 + `inbox` projection。已在 `lib/acp-agent.js` 的 `createAcpInbox()` 实现。

`types.ts:69-87` 的 Reader contract 原文：

> the key is registered by **`dsh-agent-loop`** and absent otherwise. **Without agent-loop no turn events exist**, so readers treat an absent key as "no open turn / no boundaries" — **capability absence, not a corrupt state**.

→ 本插件替代了 agent-loop。**不注册它，`agentPresets.select()` 的锁门判定就永远认为"会话未开始"** —— 会话开始后还能换引擎，正好破坏 DESIGN §7 D5。

```ts
export interface TurnBoundaryProjection {
  readonly openTurnStartSeq: OptionalSessionSeq
  readonly lastStepStartSeq: OptionalSessionSeq
  readonly lastStepBoundary: { kind: 'start' | 'end'; seq: SessionSeq } | null
  readonly lastTurn: number
}
```

---

## 5. agent-loop 的参考发布流程（`packages/core/agent-loop/src/index.ts:714-800`）

```ts
async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
  const preparation = SessionPreparation.create(this.runtime.ctx.sessions.prepare(options.sessionId, {
    ...options.seed === undefined ? {} : { seed: options.seed },
    ...options.meta === undefined ? {} : { meta: options.meta },
    ...options.inheritedEventCount === undefined ? {} : { inheritedEventCount: options.inheritedEventCount },
  }))
  const published = (async () => {
    let stored: StoredSession | undefined
    try {
      stored = options.signal === undefined
        ? await this.createStoredSession(preparation.session)
        : await raceAbortCall(...)
    } catch (error) {
      preparation[Symbol.dispose]()
      throw error
    }
    return this.setupAndPublish(ownerCtx, options.sessionId, preparation,
      options.agentOptions ?? {}, options.setup, options.signal, 'startup', stored, options.parentAgent)
  })()
  this.ownership.trackWrapper(published)
  return published
}
```

**`setupAndPublish`**（:754-780）的模式：

```
using ownedPreparation = preparation
  session = ownedPreparation.session
  prepared = this.prepare(ownerCtx, id, agentOptions, session, signal, stored?.handle, parentAgent)
  return this.initializeAgent(prepared, async () => {
    const setupCommit = await raceAbort(setup?.(prepared.agent.ctx, prepared.agent), prepared.signal, id)
    setupCommit?.commit()
    await this.appendUnstoredSuffix(stored, session)
    return await prepared.publish(source)
  })
```

`initializeAgent`（:782-799）用 `agent.runMaintenance(...)` 包裹，失败时：
```ts
prepared.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
// 外层失败：await prepared.dispose().catch(() => {})
```

**注意**：agent-loop 还做**会话持久化**（`createStoredSession` / `StoredSession` / `appendUnstoredSuffix`）。本插件的 ACP agent 是否需要自己管持久化，取决于 `dsh-session-persistence` 是否由 profile 的 bundle 提供 —— **待验证**（P1 实现时确认）。

---

## 6. 实现清单（`lib/acp-agent.js`）

| # | 项 | 状态 |
| --- | --- | --- |
| 1 | `MultiAcpFactory`（按 preset 路由，保留官方 fallback） | ✅ 已写 |
| 2 | `Agent` 对象（基接口 + 运行时面孔） | 待写 · 契约已备 |
| 3 | 会话准备 `sessions.prepare()` + `SessionPreparation.create()` | 待写 · 契约已备 |
| 4 | 发布流程 `enter()` → `announce()`，effect 顺序精确 | 待写 · 契约已备 |
| 5 | `TurnBoundaryProjection` 注册 | 待写 · 契约已备 |
| 6 | Turn 循环（inbox → turn/step → ACP prompt → 事件桥） | 待写 · 契约已备 |
| 7 | ACP `session/update` → 瞬态流帧 + 持久化事件 | 待写 · 契约已备 |
| 8 | 取消 / dispose / inbox 语义 | 待写 · 契约已备 |
| 9 | 会话持久化是否需要自管 | ❓ **待验证** |
| 10 | `agentPresets.mount()` 签名 | ❓ **待验证** |
