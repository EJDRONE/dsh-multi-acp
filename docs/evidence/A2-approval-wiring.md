# A2 · 权限请求接线（ACP `session/request_permission` → DSH `approval`）

> 执行日期：2026-10-08
> **证据源**：本机 `D:\Programs\Deepseek\resources\app.asar`（DSH Desktop 0.2.0-rc.2）
> + 官方源码 `github.com/deepseek-ai/deepseek-harness`（本地稀疏克隆，HEAD `dsh-v0.2.1-alpha.1`）
> 取法：`rg -a --byte-offset` 扫 asar + `probe/peek-asar.mjs` 看字节区间。

---

## 1. 问题（修复前）

- `AcpClient.createCallbackSink()` 的 `requestPermission` 默认返回
  `{ outcome: { outcome: 'cancelled' } }`（**一律拒绝**）。
- `AcpHost.ensureStarted()` 里写的是 `onPermission: (params) => this._onPermission?.(params)`，
  而 `this._onPermission` **从未被赋值** → 实际永远是默认拒绝。
- 后果：外部引擎的写操作**静默失败**（引擎侧只看到"被拒绝"，用户看不到任何提示）。

## 2. 宿主契约（asar 逐字核实）

### 2.1 服务名与方法 —— `@deepseek-ai/dsh-user-approval`

```
class ApprovalService extends Service {
  static Config = z.object({ policy: z.union(["ask","never"]).default("ask") });
  constructor(ctx, config) { super(ctx, "approval"); ... }

  async request(req) {                     // req = { agent, toolName, callId?, reason?, signal? }
    const session = req.agent.session;
    if (!hasOpenTurn(session)) throw new Error('approval.request() outside an open turn: ...');
    const id = ApprovalRequestId(randomUUID());
    session.append("approval/asked",  { id, toolName, ...callId, ...reason });
    const outcome = await this.decide(req, session);
    session.append("approval/decided", { id, outcome });
    return outcome;
  }
}
```

**outcome 词汇**（由源码 doc + ACP 桥测试共同确认）：
`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`。
`'allowed-once'` 是唯一的"放行"。

### 2.2 硬前置：必须在已打开的 turn 内

```
function hasOpenTurn(session) {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const type = session.eventAt(SessionSeq(seq))?.type;
    if (type === "turn/start") return true;
    if (type === "turn/end")   return false;
  }
  return false;
}
```

→ 权限请求发生在 prompt 期间：此时本驱动已 append `turn/start`、尚未 `turn/end` ⇒ 满足前置。

### 2.3 fail-closed 语义（`decide()`）

| 情况 | outcome |
| --- | --- |
| `req.signal` 已 abort | `'cancelled'` |
| session 策略 = `'never'` | `'rejected'`（在派发任何 listener 之前决定） |
| 无 answerer / answerer 抛错 / 返回非词汇值 | `'unavailable'` |

### 2.4 参照：官方 ACP 桥的**反向**映射（`packages/acp/acp/src/index.ts:155-173`）

```
ctx.on('approval/request', (request, next) => {
  ...
  const params = { sessionId, toolCall: { toolCallId: callId }, options: [
    { optionId: 'allow-once',  name: 'Allow once', kind: 'allow_once'  },
    { optionId: 'reject-once', name: 'Reject',     kind: 'reject_once' },
  ]}
  return conn.request(client.session.requestPermission, params)
}).then(({ outcome }) => {
  if (outcome.outcome === 'cancelled') return 'cancelled'
  return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
})
```

我们的方向相反（引擎问我们），故映射取逆：`ApprovalOutcome` → ACP `RequestPermissionResponse`。

## 3. ACP 侧（`@agentclientprotocol/sdk` 0.25.1，本插件依赖）

```ts
RequestPermissionRequest  = { sessionId, toolCall: ToolCallUpdate, options: PermissionOption[] }
PermissionOption          = { optionId, name, kind }   // kind ∈ allow_once|allow_always|reject_once|reject_always
RequestPermissionResponse = { outcome: { outcome:'cancelled' } | { outcome:'selected', optionId } }
ToolCallUpdate            = { toolCallId, title?, kind?, status?, content?, rawInput?, ... }
```

## 4. 本插件的映射（`lib/acp-agent.js` · `mapApprovalToAcp`）

| `ApprovalOutcome` | ACP 响应 |
| --- | --- |
| `allowed-once` | 选中引擎给的 **allow** 选项（优先 `allow_once`，其次 `allow_always`，再退前缀 `allow*`）；无则 `cancelled` |
| `rejected` / `unavailable` | 选中 **reject** 选项（优先 `reject_once`，其次 `reject_always`，再退前缀 `reject*`）；无则 `cancelled` |
| `cancelled` / 未知 | `{ outcome: { outcome: 'cancelled' } }` |

**原则**：DSH 只给一次性授权 ⇒ **绝不替用户选 `allow_always`**。

## 5. 路由（关键：ACP 进程按引擎共享）

`AcpHost` 一个引擎一个进程、多会话复用，因此 `session/request_permission` 必须
**按 `params.sessionId`** 路由（与 `session/update` 同一套 `handlers`）：

```
onPermission: (params) => this._dispatchPermission(params)
  → handlers.get(params.sessionId).onAcpPermission(params)
  → 找不到 / 抛错 ⇒ { outcome: 'cancelled' }（fail closed，并记日志）
```

## 6. 未决 / 风险

- **宿主是否挂了 answerer**：DSH Desktop 的审批 UI 由客户端插件
  `@deepseek-ai/dsh-client-ui-approval` 提供。若当前 profile 未挂到 `approval/request`
  的 answerer 上，`request()` 会返回 `'unavailable'` → 我们的策略是**拒绝**并记日志
  （仍是 fail closed；不会静默放行）。**需一次真实写操作验证是否有提示弹出。**
- 权限请求**不可**在 turn 之外调用；若引擎在 prompt 之外发请求，`approval.request` 会抛，
  我们 catch 成 `cancelled`。
