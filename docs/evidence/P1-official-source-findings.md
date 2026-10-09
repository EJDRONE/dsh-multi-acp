# P1 证据：DSH Agent 契约（官方 TypeScript 源码）

> 来源：**`github.com/deepseek-ai/deepseek-harness`（公开，TypeScript，MIT）**
> 取法：blobless 稀疏克隆（避开 269 MB 全量）
> `git clone --depth 1 --filter=blob:none --sparse <repo>`
> `git sparse-checkout set packages/core packages/session packages/preset packages/acp packages/subagent packages/bundle docs`
> 本地副本：`<会话临时目录>/refs/harness`
> 执行日期：2026-10-07

**结论：`lib/acp-agent.js` 的三个阻塞点，两个已完全解决，一个已解决一半。**

---

## 0. 为什么用源码而不是文档

1. **官方仓库公开** —— 可读 TS 源码优于编译产物（`app.asar`）与二手文档
2. **npm 类型定义版本过旧** —— npm 上是 `@deepseek-ai/dsh-agent@0.1.0-rc.6`，本机是 `0.2.0-rc.2`
3. `docs/` 里有一整套官方文档（含中文版与 `upgrade-guide/v0.2.0-rc.2/`），关键线索是
   `docs/agent-lifecycle.zh.md` 的一句：**"确切的事件签名位于生成的 Cordis 目录中"**

---

## 1. ✅ `Agent` 的完整接口

### 1.1 基接口（`packages/core/agent/src/types.ts:14-18`）

```ts
/** Public live-agent handle; the runtime face augments its live capabilities. */
export interface Agent {
  /** Session-backed Agent identity. */
  readonly id: SessionId
}
```

**基接口只有 `id`。** 活的那些能力由"运行时面孔"通过 module augmentation 增补。

### 1.2 运行时面孔（`packages/core/agent/src/runtime-types.ts:163-260`）

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

```ts
export type AgentStatus = 'idle' | 'running'          // runtime-types.ts:109

export type InboxTarget = 'next-turn' | 'next-step'    // types.ts:39

export interface InboxState {                          // types.ts:42-45
  readonly 'next-turn': readonly UserMessage[]
  readonly 'next-step': readonly UserMessage[]
}
```

### 1.4 工厂（`packages/core/agent/src/index.ts:160-190`）

```ts
export interface AgentHandle { /* agent + dispose */ }

export interface AgentFactory {
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}
```

---

## 2. ✅ `Inbox` 的替代 —— 比预期简单

**关键认识：`inbox` 依然是 `Agent` 的一个属性**（`readonly inbox: Inbox`）。变的是它的**持久化实现**：

```ts
// types.ts:58-67 —— inbox 是一个 session projection
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { inbox: InboxState }
  interface SessionProjectionMap { inbox: InboxWireState }
}

// types.ts:89-103 —— 持久化事件
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * The session-projection registry applies the committed event before
     * `Session.append()` returns; Inbox live notifications follow that commit.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
    }
  }
}
```

**含义**：

- 宿主（`dsh-agent-loop`）通过 **session projection** 负责 inbox 的持久化与重建
- 本插件**不需要自己实现 inbox 存储**，只要正确实现 `send` / `followup` / `steer` / `inject` 的**语义**
- 📖 `dsh-grok-acp` 时代的 `new Inbox(session, {...})` 已不适用（模块搬到 `@deepseek-ai/dsh-agent-loop/inbox`）

---

## 3. 🟡 事件协议 —— 已解决一半

### 3.1 流式帧（`runtime-types.ts:127-161`）

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

### 3.2 其他状态（`runtime-types.ts`）

```ts
export type AgentCancelCause = /* … */
export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
export type RequestErrorAction = { kind: 'retry' } | undefined
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

// 事件：'agent/status'(payload: { agent, status })
```

### 3.3 仍缺：持久化事件的确切 payload

需要从 **`packages/session/src`** 的 `SessionEventMap` 取：

```
turn/start · step/start · system/message · user/message
request/header · request/context · assistant/attempt · assistant/message
tool/call · tool/result · step/end · turn/end
```

📖 `docs/agent-lifecycle.zh.md` 已给出语义概要（"确切的事件签名位于生成的 Cordis 目录中"）。

另有 `docs/event-producer-consumer.zh.md`（26.6 KB，已下载）与 `docs/persistence-catalog.md` + `persistence-schema.json`。

---

## 4. 附带收获

### 4.1 `TurnBoundaryProjection` 的定义（`types.ts:69-87`）

这正是 `agentPresets.select()` 用来判锁门的那个 projection：

```ts
export interface TurnBoundaryProjection {
  readonly openTurnStartSeq: OptionalSessionSeq   // 打开 turn 的 turn/start seq，turn 之间为 null
  readonly lastStepStartSeq: OptionalSessionSeq
  readonly lastStepBoundary: { kind: 'start' | 'end'; seq: SessionSeq } | null
  readonly lastTurn: number
}
```

**重要约定**（原文）：

> Reader contract: the key is registered by `dsh-agent-loop` and absent otherwise. **Without agent-loop no turn events exist**, so readers treat an absent key as "no open turn / no boundaries" — **capability absence, not a corrupt state**.

→ 对本插件的含义：**我们替代了 agent-loop，就必须自己注册并维护这个 projection**，否则依赖它的读者（包括 preset 的锁门判定）会认为"没有打开的 turn"。

### 4.2 官方文档清单（本地已下载或可拉）

```
docs/agent-lifecycle.zh.md           6 KB   ← Agent 生命周期
docs/event-producer-consumer.zh.md  27 KB   ← 事件产消者
docs/capability-seams.zh.md         61 KB   ← 扩展点/缝隙
docs/architecture.zh.md             19 KB
docs/glossary.zh.md
docs/upgrade-guide/v0.2.0-rc.2/            ← 正好我们的版本
    account-sign-in-errors · remove-runtime-invariants
    schedule-bundle-retired · subpath-plugin-display-manifest
```

### 4.3 源码包布局（稀疏克隆所得）

```
packages/core         156 files   ← Agent / AgentFactory / runtime-types / agent-loop
packages/session      315 files   ← SessionEventMap / SessionPreparation / projections
packages/preset        63 files   ← agentPresets 服务
packages/acp           27 files   ← DSH 自带的 ACP（服务端方向）
packages/subagent     175 files   ← 子代理（含 ACP 子代理）
packages/bundle        76 files
```

---

## 5. 对 P1 的影响

| 原阻塞点 | 状态 | 影响 |
| --- | --- | --- |
| #1 Agent 完整接口 | ✅ 已解决 | 可直接实现，接口清单明确 |
| #3 Inbox 替代用法 | ✅ 已解决 | **变简单了**——不需要自己实现 inbox 存储 |
| #2 事件协议 payload | 🟡 半解决 | 还差 `packages/session` 的 `SessionEventMap` |

**新增的必须项**：因为本插件**替代了 agent-loop**，必须自己注册并维护 `TurnBoundaryProjection`（§4.1），否则 preset 锁门判定会失效。
