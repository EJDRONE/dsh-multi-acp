# ADR-0006 · 路线 B：替换宿主的 private factory 槽位

- **状态**：已接受（2026-10-10）
- **证据等级**：实测
- **相关**：`lib/index.impl.js`（`② 替换 agent factory`）、`lib/dsh-imports.js`、`test/plugin-smoke.test.mjs`

## 背景

本插件的核心命题是「让外部 ACP CLI 作为**根 agent**驱动 DSH 会话」——
即真的换掉"谁在驱动会话"，而不是把外部 CLI 当模型供应商或子代理。

宿主的接入点是 `ctx.agents` 的 factory 槽位。但实测（`@deepseek-ai/dsh-agent@0.2.0-rc.2`
的 `lib/types/index.d.ts`）：

```ts
export declare class AgentRegistry extends Service {
    private store;
    private factory;          // ← 宿主类型把它声明为 **private**
    ...
    /**
     * Register the agent-creation factory (the loop calls this on construction,
     * effect-scoped). …
     * **Throws if a factory is already registered.** Returns the disposer; on
     * dispose the factory slot is cleared.
     */
    setFactory(factory: AgentFactory): () => void;
}
```

两个事实同时成立：

1. 官方入口 `setFactory()` **拒绝二次注册**（"Throws if a factory is already registered"），
   而官方 agent loop 构造时已经占用它 —— 所以**没有官方路径**可以替换。
2. 运行时该槽位的形状是 Cordis 的 traced-service 代理：`{ target: <AgentFactory> }`，
   读与写都通过 `.target`。

`tsc --checkJs` 对此的判断是 **`TS2341: Property 'factory' is private`** ——
也就是说：这不是"写得糙"，而是**这条路必须越过类型的边界**。

## 决定

**继续走路线 B，但把越界显式化并加护栏。** 具体：

1. **保留直接赋值** `agents.factory = { target: new MultiAcpFactory(...) }`，
   并保存官方 factory 作为**回落**（未声明引擎的会话仍走原生 loop）。
2. **写作前先验形状**：官方类型里 `AgentFactory` 是**带 `createAgent` / `resume` 方法的对象，
   不是函数**。早先写成 `typeof target !== 'function'` 会把完全正常的情况误判成异常，
   进而走到一个会崩的日志分支（见第 3 条）。
3. **绝不 `JSON.stringify` 可能是 traced proxy 的值**：Cordis 对未声明 inject 的属性读取
   **直接抛错**，而 `JSON.stringify` 会去读 `.toJSON` ——
   结果是"防御性错误信息自身崩溃"，真故障被完全掩盖。用 `describeShape()`
   （只读自有属性名与 `typeof`）。
4. **形状不对时明确报错且不替换**（不静默降级），并 `trace` 记录形状。
5. **把越界与风险写下来**：本 ADR + `lib/index.impl.js` 的现场注释。
6. **`inject` 必须覆盖官方 agent-loop 的全部条目**
   （`agents`/`sessions`/`llm`/`tools`/`systemPrompt`）—— 因为 `createScope` 造出的
   `agent.ctx` **继承本插件的 inject 列表**。实测事故：漏声明后，
   `dsh-experimental-tool-agent-team` 访问 `agent.ctx.systemPrompt` 抛
   `cannot get property "systemPrompt" without inject`，**把宿主进程打死**。

## 后果

**正面**

- 核心能力成立，且不破坏默认行为（官方 factory 始终可回落）。
- 越界的**位置、原因、代价、以及 DSH 升级后的检查方法**都有文字记录，
  不再是"读注释才知道"的隐性知识。

**负面 / 已知代价（这是本插件最大的结构性风险）**

- **依赖一个 private 成员与一个内部代理形状**。一次 DSH 升级可以在不改变任何公开契约的
  情况下静默打断它。**缓解**：
  - 启动自检 + `describeShape` 运行时护栏（形状变了会明确报错，不会静默走错分支）；
  - `factory.*` 全链路有 `trace` 事件（`install.factory-installed` / `factory-bad-shape` /
    `factory-restored`），升级后看 trace 即可判断；
  - 清点成本低：只需确认 `AgentRegistry` 是否仍暴露该槽位、`AgentFactory` 是否仍是对象形状。
- `tsc --checkJs` 会在这行报 `TS2341`。**它应当被保留为可见的信号**，而不是被
  `@ts-expect-error` 抹平 —— 具体抑制策略留到类型基线清零那一轮一并决定（见 ADR-0002）。

## 替代方案与为何不选

| 方案 | 为何不选 |
| --- | --- |
| 用官方 `setFactory()` | 实测语义是"已注册即抛错"；官方 loop 先占用，我们没有窗口。 |
| 走 preset 的 `isolate` realm 另起一套 loop | 会让"换引擎"退化成"换一整套 loop 配置"，与"引擎是数据行"的设计目标冲突；且仍未验证能表达"根 agent 由外部进程驱动"。 |
| 只做 provider 路线（外部 CLI 当大脑，loop 仍属 DSH） | 那是**另一个产品**：它不改变"谁在驱动会话"，已有其他插件在做（官方也明说不要重复造）。 |
| 做官方 `dsh-subagent-acp` 式的子代理 | 官方已有；且子代理不满足"根 agent"的语义。 |
| 打进宿主补丁 / fork 宿主 | 超出插件边界，且用户无法维护。 |
