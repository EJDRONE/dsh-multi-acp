# P0 · Step 0 证据：DSH 0.2.0-rc.2 内部槽位静态检索

> 对应 [VERIFICATION.md](../VERIFICATION.md) 的 Step 0 / 1 / 2（R1 / R2）
> 方法：**纯静态检索**，用 `asar-find.mjs` 扫描 `D:\Programs\Deepseek\resources\app.asar`（115.7 MB）
> 零副作用：未安装、未修改、未启动任何东西
> 执行日期：2026-10-07

**结论：R1 ✅ 通过 · R2 ✅ 通过（但需改用新 API）**

---

## 1. R1 · `agents.factory` 槽位 —— ✅ 通过

### 1.1 接口定义（offset ≈ 59939930）

```ts
export interface AgentFactory {
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>;
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>;
}
export interface AgentHandle { agent: Agent; dispose(): Promise<void>; }
export interface Agent { readonly id: SessionId; }
```

### 1.2 **实际实现**（offset ≈ 14849095，`@deepseek-ai/dsh-agent`）

```js
setFactory(factory) {
  return this.ctx.effect(() => {
    if (this.factory !== void 0) throw new Error("an agent factory is already registered");
    const target = factory[symbols.original] ?? factory;
    this.factory = { target };            // ← 形状：{ target }
    return () => { this.factory = void 0; };
  }, "agents.setFactory()");
}

/** Return the active creation factory. */
requireFactory() {
  if (this.factory === void 0) throw new Error(NO_FACTORY_MESSAGE);
  return this.factory;                     // ← 消费方读的就是这个 { target }
}
```

其他常量：

```js
const NO_FACTORY_MESSAGE = "no agent factory registered (load an agent-loop plugin)";
const NO_INITIATOR_MESSAGE = "no initiating agent is active";
const DISPOSED_INITIATOR_MESSAGE = "agent initiator scope is disposed";
```

服务文档注释（offset ≈ 14843904）：

> Agent service (`ctx.agents`): tracks live agents and carries the initiating Agent through one process-local asynchronous driver chain. Agent *creation* is provided by whichever plugin implements the `AgentFactory` (`@deepseek-ai/dsh-agent-loop`), registered via `setFactory`.

### 1.3 判定

| 问题 | 答案 |
| --- | --- |
| `AgentFactory` 接口还在吗？ | ✅ 在 |
| `agents.factory` 属性还在吗？ | ✅ 在，**普通实例属性** |
| 形状是 `{ target }` 吗？ | ✅ **完全一致**——`setFactory` 内部就是这么赋值的 |
| grok 的 `agents.factory = { target: router }` 还成立吗？ | ✅ **成立**——消费方 `requireFactory()` 返回对象、读 `.target`；`setFactory` 的"已注册就抛错"守卫**拦不住直接属性赋值** |
| ⚠️ 新细节 | `factory[symbols.original] ?? factory` —— 有 **Cordis traced service 解包**。保存 fallback 时，`target` 可能是 traced service 而非裸函数，**调用的 `this` 绑定仍需实测**（对应 VERIFICATION §4） |

---

## 2. R2 · `agentPresets` —— ✅ 通过（API 变了，且更好）

### 2.1 服务存在（`@deepseek-ai/dsh-agent-preset-registry`，offset ≈ 14537511）

```js
static inject = ["loader", "sessionProjections"];
static Config = z.object({ default: z.string().required(), selectedDefault: z.string().volatile() });
// 内部状态
definitions = new Map();
generations = new Map();
bindings = new WeakMap();
switches = new Map();
constructor(ctx, config) { super(ctx, "agentPresets"); ... }
ctx.on("session/event", (session, event) => {
  if (event.type === "agent-preset/selected") ctx.emit("agent-preset/selected", session.id, event.data.agentPreset);
});
```

**公开方法**（由 TYPERT invocations 确认）：`agentPresets/list` · `agentPresets/read` · `agentPresets/select`

### 2.2 ❌ `resolvedRoots` 已不存在（命中 0 次）

grok 靠 `presets.resolvedRoots = [grokRoot, ...originalRoots]` 注册自带 preset 目录 —— **该接口已移除**。

### 2.3 ✅ 替代方案 1：**程序化注册**（offset ≈ 14538727）

```js
/**
 * ...ter activation or its diagnostic settles; the declaring plugin owns it.
 */
async register(definition) {
  const context = this.ctx;
  if (!definition.id.trim()) throw new Error("Preset id must not be empty");
  if (this.definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
  const record = { config: definition, context, ready: Promise.resolve() };
  this.definitions.set(definition.id, record);
  let disposed = false;
  const unregister = async () => { /* 清理 + collect */ };
  record.ready = this.activate(record);
  await record.ready;
  return unregister;                       // ← 返回 disposer，所有权归声明方
}
```

**→ 插件可在 `apply()` 里直接注册 preset，无需改配置文件。这消除了原 D2 与"preset 必须进 cordis 配置"的冲突。**

### 2.4 ✅ 替代方案 2：**官方 `select()`**（offset ≈ 14547764）

```js
/** Select a preset before a session starts its first turn. */
async select(agent, agentPreset) {
  return (this.switches.get(agent.id) ?? Promise.resolve()).then(async () => {
    const boundary = this.owner.sessionProjections.stateOf(agent.session, "turnBoundary");
    if (boundary !== void 0 && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0))
      throw new RemoteError("agent-preset/locked", "This session has already started",
        { sessionId: agent.id, agentPreset });
    const preset = await this.recompose(agent.ctx, agentPreset);
    agent.session.append("agent-preset/selected", { agentPreset: preset.id });
    return preset.id;
  });
}
```

`recompose` 也在（offset ≈ 14546880）：

```js
/** Rebind a blank Agent; the caller owns the blank-session check. */
async recompose(ctx, id) {
  const preset = await this.mount(ctx, id);
  try { this.owner.emit("tools/change"); } catch (error) { ... }
  return preset;
}
```

**结论**：grok 手写的三件事 —— `sessionBlank()` 自查 + `recompose()` + `session.append("agent-preset/selected")` —— **全部被官方 `select()` 覆盖**，且：

- 锁门判定用 **`turnBoundary` projection**（`openTurnStartSeq !== null || lastTurn > 0`），比 `sessionBlank()` 更精确
- 抛 `RemoteError("agent-preset/locked", "This session has already started")` —— **可直接透传给 UI**
- `switches` Map 提供 **per-agent 串行化**，并发安全由宿主保证

### 2.5 ⚠️ 隔离域是**强制审计**的（offset ≈ 14581887）

```
`preset "${mount.presetId}" published process-global service(s) [${leaked.join(", ")}] after its mount was audited ...
 a preset service must sit behind an `isolate` realm or move to the host composition`
```

以及：

```
agent "${agent.id}" addressed a model without joining any agent preset while a roster is composed;
its tools, prompt sections, and skill catalog resolve against the empty global layer
```

→ **preset 内的服务行必须放在带 `isolate` realm 的组里**，否则挂载后会被审计拒绝。这印证了 `agent.cordis.yml` 里的注释。

---

## 3. 🚨 附带发现：用户现有 preset 很可能已失效

`@deepseek-ai/dsh-agent-preset` 包自带迁移文档（offset ≈ 14772607）：

> ## Migrate a legacy preset
> Before **declaration rows**, a user preset was a directory `$DSH_HOME/.agent-presets/<id>/` holding `preset.yml` … and `agent.cordis.yml` … **Nothing reads that directory any more.** To migrate one, create a **bundle** whose **declaration** takes `id` from the directory name, `name`/`description`/`order` from `preset.yml`, and `plugins` from `agent.cordis.yml` verbatim.

**且**：`profiles\desktop\cordis.patch.yml` 与 `cordis.yml` 中 **grep `preset` 均为 0 匹配**。

→ 本机 `D:\Ecode\.dsh\.agent-presets\{router-standard, crew, liangshen}\` 三个目录式 preset **在 0.2.0-rc.2 下很可能已不被读取**。需向用户确认（可能表现为这几个 preset 在 UI 里消失或选了无效）。

### 3.1 `cordis.yml` 的权威说明

```
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

---

## 4. 对设计的修订建议

| 原设计 | 修订 |
| --- | --- |
| **D2**：引擎配置放插件自管文件，绝不写 `cordis.patch.yml` | **不变，且现在更有底气**——preset 可用 `agentPresets.register()` 程序化注册，**根本不需要碰配置文件** |
| **D4**：每个引擎物化一个 preset 目录，注册为 `resolvedRoots` | **改为**：在插件 `apply()` 中为每个引擎调 **`agentPresets.register({ id, name, description, order, plugins })`**，保存返回的 `unregister` 作清理 |
| **D5**：沿用 `sessionBlank` 闸门 | **改为**：直接用官方 **`agentPresets.select(agent, presetId)`**，由宿主负责锁门与并发 |
| **R1** 🔴 | ✅ **消除** |
| **R2** 🔴 | ✅ **消除**（改用 `register` / `select`） |

---

## 5. 仍未验证（Step 0 未覆盖）

| 项 | 说明 |
| --- | --- |
| `factory.target` 的 `this` 绑定 | 它可能是 Cordis traced service，调用 `target.createAgent(...)` 时是否需要绑定 |
| `register(definition)` 的 `definition` 完整 schema | 目前只确认有 `id`；`name`/`description`/`order`/`plugins` 的具体字段名需从 `@deepseek-ai/dsh-agent-preset` 的类型确认 |
| 替换 `agents.factory` 的时机 | 必须在 agent-loop 注册之后；先注册会被守卫/覆盖行为影响 |
| `symbols.original` 的语义 | traced service 解包规则 |
| 已存在会话是否受 factory 替换影响 | VERIFICATION §4 原待验项 |
