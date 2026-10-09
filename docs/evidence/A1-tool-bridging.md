# A1 · 工具调用桥接（ACP `tool_call` → DSH `tool/call` · `tool/result`）

> 执行日期：2026-10-08
> **证据源**：官方源码稀疏克隆 `refs/harness`（HEAD `dsh-v0.2.1-alpha.1`）
> + 本机 `app.asar`（0.2.0-rc.2）+ ACP SDK `@agentclientprotocol/sdk`（本插件依赖 0.25.1）。

---

## 1. 问题（修复前）

```js
// lib/acp-agent.js · onAcpUpdate（修复前）
case 'tool_call':
  this._pendingToolCalls = this._pendingToolCalls ?? new Map()
  this._pendingToolCalls.set(update.toolCallId, update)
  break
case 'tool_call_update':
  this._pendingToolCalls?.set(...)
  break
```

只把 ACP 的工具更新塞进内存 Map，**从不写会话事件** → 日志里没有 `tool/call` / `tool/result`。
P1 里"看到工具调用"，那是**引擎侧**的行为；**不是经我们桥接**的副作用。

## 2. 契约（`packages/core/session/src/types.ts:361-385`）

```ts
'tool/call':   { turn: number; step: number; callId: ToolCallId; name: string; arguments: string }
'tool/result': {
  turn: number; step: number
  message: ToolResultMessage
  error?: { name: string; code: string; reason?: string }   // 仅当 message.isError === true
  meta?: JsonValue                                          // 必须 JSON 可序列化
}
```

- **`tool/call` 是 log-only**（不在 `SurfaceEventType` 里）→ **不带 surfaceOp**。
- **`tool/result` 是 surface event**（`SurfaceEventType`，types.ts:444）→ **必须带
  `{ surfaceOp: 'append' }`**，否则 `Session.append` 抛
  `"… requires a surfaceOp marker"`（surface.ts:302-327）。这是 A6 那条同源约束的延续。

## 3. 字段对应（取反自官方 ACP 桥 `packages/acp/acp/src/updates.ts:52-85`）

官方桥是 **DSH → ACP**；我们反向 **ACP → DSH**：

| DSH（官方桥产物） | ACP（ACP SDK `ToolCall`/`ToolCallUpdate`） |
| --- | --- |
| `toolCallId: callId` | `toolCallId` |
| `title: name` | `title: string`（人类可读；ACP 无独立 toolName） |
| `kind: 'other'` | `kind: ToolKind`（read/edit/execute/…） |
| `rawInput: JSON.parse(arguments)` | `rawInput: unknown` |
| `status: isError ? 'failed' : 'completed'` | `status: pending/in_progress/completed/failed` |
| `content: [{type:'content', content: <block>}]` | `content: ToolCallContent[]` |

⇒ 我们的映射：

| ACP | DSH |
| --- | --- |
| `update.toolCallId` | `tool/call.callId` 与 `tool/result.message.toolCallId` |
| `update.title ?? update.kind ?? 'acp-tool'` | `tool/call.name` |
| `JSON.stringify(update.rawInput)`（失败→`'{}'`） | `tool/call.arguments`（**必须是字符串**） |
| `status === 'failed'` | `ToolResultMessage.isError = true` |
| `content[]`（`content` 文本 / `diff` / `image`） | `ToolResultMessage.content: ContentBlock[]`（文本块；image 降级占位） |
| `rawOutput`（无 content 时回退） | 文本块 |

## 4. 关键设计：**缓冲落盘**（顺序正确性）

DSH 的规范顺序是 `assistant/message`（发起工具调用）**在前**，`tool/call` · `tool/result` 在后。
但 ACP 的 tool 更新是在 `session/prompt` **期间**陆续到达的，而我们的 `assistant/message`
要到 prompt **返回时**才组装。

若边到边落盘，日志会变成 `tool/result → assistant/message`（surface 上"结果先于发起"），
语义错乱。因此：

```
turn/start → user/message → step/start
            ↘ 期间：tool 更新只进 _toolEvents buffer
              _promptOnce 结束 → assistant/message 落盘
              → _flushToolEvents()（tool/call* · tool/result*）
              → step/end → turn/end
```

- 每 turn 重置 `_toolCalls` / `_toolEvents`；`_bridging` 仅在 prompt 期间为 true。
- `_flushToolEvents()` 幂等（落完清空），在 step 结束前与 turn 结束前各调一次（后者为兜底）。
- 每个 `callId`：`tool/call` 落且仅落一次；终态 `tool/result` 落且仅落一次；
  未见过的 callId 先补 `tool/call`，保证 result 必有配对 call。

## 5. 验证方法（**决定性副作用**）

`tool/call` 落盘是**只有我们的桥接路径才会产生的副作用** —— 官方 factory 走 agent-loop，
其 tool 事件来自 DSH 自己的工具，形状/来源不同。

```powershell
# 1) 触发一次必然产生工具调用的 ACP 会话（如让它读/写一个文件）
# 2) 检查该会话日志里出现 tool/call：
#    <DSH_HOME>\sessions\**.jsonl.zstd 解压后 grep '"type":"tool/call"'
#    或在 DSH 轨迹里看到工具卡片
```

对照 CHANGELOG 0.1.4 的教训：**不能只看最终输出**，必须找到"只有我们的路径才会产生的副作用"。

## 6. 未决 / 风险

- 若引擎**不发** `session/update` 的 tool 更新（只在 `prompt` 结果里带），则无事件可桥接 ——
  目前按 ACP 标准假定会发。omp / opencode 的 probe 记录里均有 `tool_call` 更新（见 `probe-*.json`）。
- 迟到的 tool 更新（`turn/end` 之后）会被丢弃（`_bridging === false`），记 debug 日志。
