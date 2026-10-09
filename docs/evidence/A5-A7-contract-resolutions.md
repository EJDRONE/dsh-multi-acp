# A5 / A6 / A7 · 契约定案（读源码即可定）

> 执行日期：2026-10-07
> **主源**：本地稀疏克隆 `refs/harness`（`github.com/deepseek-ai/deepseek-harness`，
> 当前 HEAD = tag `dsh-v0.2.1-alpha.1`，2026-10-03）。
> **复核源**：**本机实际运行的 `D:\Programs\Deepseek\resources\app.asar`（0.2.0-rc.2）**。
> 每一条结论都在两个源上分别核实过 —— 因为克隆的 HEAD 与目标宿主版本并不相同。
>
> 复核方法：`rg -a --byte-offset` 扫 asar + `probe/peek-asar.mjs` 看字节区间。

**结论：A5 / A6 / A7 全部定案；另发现一个会阻断所有 append 的 P0 前置缺陷（见 §4）。**

---

## A5 · `TurnEndReason` 的确切 union

**源码**：`packages/core/session/src/types.ts:201-232`

```ts
export interface TurnEndReasonMap {
  completed:    { kind: 'completed' }
  aborted:      { kind: 'aborted'; reason: TurnEndCancelCause }
  blocked:      { kind: 'blocked' }
  error:        { kind: 'error'; error: LlmFailure }
  'max-tokens': { kind: 'max-tokens' }
  interrupted:  { kind: 'interrupted' }
  forked:       { kind: 'forked' }
}
export type TurnEndReason = TurnEndReasonMap[keyof TurnEndReasonMap]
```

**0.2.0-rc.2 asar 逐字复核**（`kind:` 全在）：

```
interface TurnEndReasonMap {
  completed: { kind: 'completed' };
  aborted: { kind: 'aborted'; reason: TurnEndCancelCause };
  blocked: { kind: 'blocked' };
  error: { kind: 'error'; error: LlmFailure };
  'max-tokens': { kind: 'max-tokens' };
  interrupted: { kind: 'interrupted' };
  forked: { kind: 'forked' };
}
```

**相关类型**：

| 类型 | 定义 | 位置 |
| --- | --- | --- |
| `TurnEndCancelCause` | `AgentCancelCause \| { kind: 'legacy' }` | types.ts:196 |
| `AgentCancelCause` | `user` / `parent` / `hook(reason)` / `disposed` | types.ts:189-193 |
| `LlmFailure` | `{ message: string; code: string; status?; … }` | llm/llm/src/types.ts:41-59 |

**生产者如何选**（照 `agent-loop/src/agent.ts:310-389`）：

| 情形 | reason |
| --- | --- |
| 正常结束 | `{ kind: 'completed' }` |
| pre-step 拒绝 | `{ kind: 'blocked' }` |
| signal 已 abort | `{ kind: 'aborted', reason: <cause> }` |
| 其他失败 | `{ kind: 'error', error: { message: errorChain(e), code: 'UNKNOWN' } }` |
| step 触顶 | `{ kind: 'max-tokens' }`（sticky） |
| `interrupted` / `forked` | **loop 从不 live 发出**（崩溃孤儿 / fork 种子专用，不由 driver 产生） |

**本插件修复前的错误**：`{ kind: 'end-turn' }` —— 该值**不存在**。

---

## A6 · `UserMessage` 的实际结构

**源码**：`packages/llm/llm/src/message.ts:139-164`（0.2.0-rc.2 asar 复核一致）

```ts
interface MessageBase {
  /** Stable identity preserved across every representation boundary. */
  readonly id: MessageId          // ← 字段名是 `id`，不是 `messageId`
  /** Exact model-facing blocks. */
  readonly content: readonly ContentBlock[]
  /** Required source fields supplied by the producer. */
  readonly source: MessageSource
}
export interface UserMessage extends MessageBase {
  readonly role: 'user'
}
```

- **身份字段 = `id: MessageId`**。`messageId` 只出现在参数名（`Inbox.replace(messageId, …)`，runtime-types.ts:77）。
- **`content` = `readonly ContentBlock[]`**，文本块 `{ type: 'text'; text: string }`
  （types.ts:62-71；`ContentBlockMap` types.ts:137-150）。
- `source` 是 merge-extensible 联合：`user` / `model` / `tool` / `system-prompt`（message.ts:110-136）。
- 官方构造器 `createUserMessage({ content, source: { kind: 'user' } })`（message.ts:246-253）。

**对本插件的映射**：拼 ACP prompt 时**只取 `type === 'text'`** —— `reasoning`（同为 `{ text }` 形状！）、
`image`、`file`、`tool-*` 一律不得回灌给外部引擎。`extractText()` 已按此重写。

---

## A7 · `agentPresets.mount(ctx, id?)` 的签名

**源码**：`packages/preset/agent-preset-registry/src/index.ts:281`

```ts
/** Bind an unpublished Agent to the current preset revision.
 *  @param ctx Agent context from its setup callback.
 *  @param id Requested preset, or the default.
 *  @returns Bound preset identity. */
async mount(ctx: Context, id?: string): Promise<AgentPreset>
```

**0.2.0-rc.2 asar 复核**：声明逐字一致（`mount(ctx: Context, id?: string): Promise<AgentPreset>`）。

### ⚠️ 关键约束：`ctx` **必须是 scoped context**

`mount()` → `bind()`（index.ts:250-252）：

```ts
private async bind(ctx: Context, generation: Generation): Promise<void> {
  const key = scopeOf(ctx)
  if (key === undefined) throw new Error('Agent preset binding requires a scoped context')
  ...
}
```

**agent-loop 的正确做法**（`agent-loop/src/agent.ts:129-131`）：

```ts
this.dispatch = agentEvents(loopCtx, this)
this.scope = createScope(loopCtx, this)   // ← 用 agent 自身作 scope key
this.ctx = this.scope.ctx                  // ← agent.ctx 是 scoped 的
```

**本插件修复前**：把 `rootCtx`（unscoped）当 `agent.ctx` 传进去 → `mount()` 必抛
"requires a scoped context"（异常被 catch 成一条日志，静默丢失 preset）。

**同时补齐的宿主契约**（`core/agent/src/index.ts:100-118`、`AgentSetup:51-54`）：
factory **必须在发布前**用 scoped `agent.ctx` 调用 `options.setup`，并调用其可选同步
`commit()` —— 这是官方的组装点（装模型控制 / MCP / mount preset）。修复前本插件**完全没调用** `options.setup`。

---

## 4. 🔴 前置缺陷：`surfaceOp` 是硬要求（阻断所有 append）

与 A5/A6 同属"写会话事件"这条链，必须一并处理：

**`SurfaceEventType`**（session/src/types.ts:439-444）：

```ts
export type SurfaceEventType =
  | 'system/message' | 'developer/message' | 'user/message'
  | 'assistant/message' | 'tool/result'
```

**`Session.append` 会强制校验**（session/src/index.ts:718-748 → surface.ts:302-327）：

```ts
const op = raw.surfaceOp
if (op === undefined) {
  throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`)
}
```

**0.2.0-rc.2 asar 逐字复核**：

```
SURFACE_EVENT_TYPES = new Set([
    "system/message",
    "developer/message",
    "user/message",
    "assistant/message",
    "tool/result"
])
...
if (op === void 0) throw new Error(`session event "${event.type}" is surface-eligible and requires a surfaceOp marker`);
```

**修复前本插件**的 `session.append('user/message', message)` 与
`session.append('assistant/message', {…})` **都没有 surfaceOp** → 会在 append 处直接抛错。

**顺带确认的两处构造错误**（同一段代码）：

| 项 | 修复前 | 契约 |
| --- | --- | --- |
| assistant 组装 | `createAssistantMessage(text: string)` | `createAssistantMessage({ content, source: { provider, model } })`（message.ts:260-271） |
| `stream` 记录 | `{ text, time, kind }`（自定义形状） | `AssistantStreamRecord[]`，用官方 `AssistantStreamAccumulator` 生成（assistant-stream.ts:20-47 / 100-194） |

---

## 5. 对实现的落地（`lib/acp-agent.js`，v0.1.5）

| # | 改动 | 对应 |
| --- | --- | --- |
| 1 | `turn/end` reason：`completed` / `aborted(reason)` / `error(LlmFailure-ish)` | A5 |
| 2 | `cancel()` 记录 `_cancelCause`；`stop()` 缺省 `disposed` | A5 |
| 3 | `extractText()`：只取 `type === 'text'` 块 | A6 |
| 4 | inbox `replace`/`remove` 按 `message.id` 匹配 | A6 |
| 5 | `user/message` · `assistant/message` append 补 `{ surfaceOp: 'append' }` | §4 |
| 6 | `createScope(rootCtx, agent)` → scoped `agent.ctx`；发布链外显式 `scope.dispose()` | A7 |
| 7 | 发布前调用 `options.setup(agent.ctx, agent)` + `commit()`；未挂 preset 时后备 `mount(ctx, id?)` | A7 |
| 8 | `assistant/message` 用对象构造 + `AssistantStreamAccumulator` 生成合法 `stream` | §4 |
| 9 | `_runTurn` 的 `step` 改为按 turn 重置（恒为 1） | 附带（step 契约） |

**版本**：`0.1.4` → `0.1.5`。

---

## 6. 仍未定案（留给 A1 / A2 / A8）

- `tool/call` · `tool/result` 的桥接（A1）—— `tool/result` 同样是 surface event，需 surfaceOp。
- `session/request_permission` → DSH `approval`（A2）。
- 会话持久化是否需自管（A8）。
