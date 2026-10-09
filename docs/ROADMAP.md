# 路线图：A（加固）/ B（引擎管理 UI）/ C（补齐 opencode 验证）

> P1 已端到端跑通（见 [CHANGELOG.md](../CHANGELOG.md) 0.1.4）。
> 本文把后续工作拆成可独立执行的条目，避免细节在长对话中丢失。
> 每完成一条：**升版本号 + 写 CHANGELOG**（用户约定）。

---

## A · 加固 P1 —— 对齐 7 项运行时未验证契约

P1 跑通的是"最小可用路径"。下面 7 项在更复杂的场景（工具、权限、取消、恢复）里会暴露偏差。
**逐条验证 + 偏差就修**，每修一条升一次版本。

| # | 契约 | 现状 | 验证方法 |
| --- | --- | --- | --- |
| A1 | **工具调用桥接** `tool/call` · `tool/result` | 🟡 **已接线**（v0.1.7），待运行时验证 | 让引擎执行一个必然产生工具调用的任务，检查会话事件里是否有 `tool/call` 落盘 |
| A2 | **权限请求** `session/request_permission` → DSH `approval` 服务 | 🟡 **已接线**（v0.1.6），待运行时验证 | 让引擎尝试写文件，看是否弹出 DSH 权限提示 |
| A3 | **取消** `session/cancel` 语义（DSH 0.2.x **无** `agent/canceled` 事件） | ✅ **已对齐**（v0.1.8）：`cancel()` + inbox `outcome:'canceled'` + `agent/inbox/discarded` | 长任务中途点停止 |
| A4 | **会话恢复** `session/resume`（`host.resumeSession`） | ✅ **已实现**（v0.1.8）：读持久化日志为 seed + `sessions.json` 映射 + `session/load` | 重启后能否继续同一会话 |
| A5 | **`TurnEndReason` 的确切 union** | ✅ **已定案 + 已修**（v0.1.5） | 读 `packages/core/session/src/types.ts` |
| A6 | **`UserMessage` 实际结构**（`messageId` 字段名 / content 形状） | ✅ **已定案 + 已修**（v0.1.5） | 读 `packages/core/session/src/types.ts` + 观察真实消息 |
| A7 | **`agentPresets.mount(agentCtx, presetId)` 签名** | ✅ **已定案 + 已修**（v0.1.5） | 读 `packages/preset` 源码 |
| A8 | **会话持久化是否需自管** | ✅ **已接入**（v0.1.8）：`sessionPersistence.create/open` + `appendUnstoredSuffix` + `handle.close` | 重启后检查会话是否完整 |

**✅ A5/A6/A7 已完成（v0.1.5）** —— 完整结论与 `文件:行号` 见
[`docs/evidence/A5-A7-contract-resolutions.md`](evidence/A5-A7-contract-resolutions.md)。
关键点（**两个源分别核实**：克隆源码 `dsh-v0.2.1-alpha.1` + 本机 asar `0.2.0-rc.2`）：

- **A5**：`TurnEndReason` = `completed` / `aborted(reason)` / `blocked` / `error(error)` /
  `max-tokens` / `interrupted` / `forked`。**不存在 `end-turn`**。
- **A6**：`UserMessage` 的身份字段是 **`id: MessageId`**（不是 `messageId`）；
  `content` 是 `ContentBlock[]`，文本块 `{ type:'text', text }`。
- **A7**：`mount(ctx: Context, id?: string): Promise<AgentPreset>`；
  ⚠️ **`ctx` 必须是 scoped context** —— 已照 agent-loop 用 `createScope()` 重建 `agent.ctx`，
  并补齐此前**完全没调用**的 `options.setup(agent.ctx, agent)`。

**🔴 顺带发现（同链，已修）**：`user/message` / `assistant/message` / `tool/result` 属于
`SurfaceEventType`，`Session.append` **强制要求 `surfaceOp`**，否则抛
`"requires a surfaceOp marker"`（已在本机 asar 逐字核实）。修复前这两处 append 都没传 →
正常 ACP turn 会在 append 处直接失败。

**优先顺序（更新）**：A5/A6/A7 已清零；接下来 **A2** 是**最可能有真实缺陷**的
（默认拒绝权限 → 引擎的写操作会静默失败）；A1 的答案会影响后续设计（`tool/result` 同样是
surface event，需 surfaceOp）。

**注意**：A1 的结论要以"**只有我们的路径才会产生的副作用**"为准 ——
本次 P1 验收就差点把"降级到官方 factory 的结果"误判为成功（详见 CHANGELOG 0.1.4 附注）。

---

## B · 引擎管理 UI（`docs/UI-DESIGN.md` 已就绪）

后端已能挂（插件加载正常），不再是空壳。分四期：

| 期 | 内容 | 前置 |
| --- | --- | --- |
| **B0** | 读 `packages/client/ui-slots` + `docs/subsystems/web-client.zh.md` + `experts-management/client/*`，确认：可用 slot、`ctx.webServer` 路由签名、esbuild 打包的外部依赖约定 | ✅ **已完成**（v0.1.9）——见 `docs/evidence/B0-ui-contract-findings.md` |
| **B1** | **引擎四态探测**（无 UI）：`available` / `not-installed` / `unavailable` / `disabled`。<br>当前 `lib/engines.js` 是**手写 3 条**，缺 PATH 探测层 | ✅ **已完成**（v0.1.9）：`detectExecutable` / `engineState` / `describeEngines` |
| **B2** | 宿主侧 HTTP 路由：`GET /multi-acp/engines`（列表+三态+能力徽章）、`POST /:id/test`（试连）、`PUT /:id`（env/overrides/enabled/sortOrder）、`GET /:id/bound-experts`（反向索引） | ✅ **已实现**（v0.1.10）· ⚠️ bound-experts 无数据源（见 B0 §4） |
| **B3** | 客户端半边：`lib/client.js`（`__ModuleLoader__.load` 包裹，需 esbuild）+ `package.json` 加 `dsh.client` | ✅ **已实现 + 已目视验证**（v0.1.11/0.1.12）：手写 bundle（免 esbuild）+ `settings.section` 分区；截图确认三引擎「可用」 |
| **B4** | **对齐 AionUi 的两处 UI 偏差**（用户 2026-10-08 复核，见下 §B.1）：① 可执行体路径当前只读，补「启动方式可覆盖」编辑；② 环境变量编辑器从「单 textarea 每行 KEY=VALUE」改为「键值两栏行 + 👁 显示 + 🗑 删除 + ＋添加变量」 | ✅ **已实现**（v0.1.15）· 验收 `tmp/verify-ui.mjs` **38/38**（自带 mini-React，真点真改真保存）；顺带做了四态过滤桶 + 搜索 + 默认引擎徽章 + **握手诊断行** + 启用/停用 + MCP 策略下拉 |
| **B5** | **preset 原生工具组合 + resume 回落 + MCP 注入 + C1 回显**（用户 2026-10-09 的四条，见 `evidence/A10-preset-tools-mcp-2026-10-09.md`） | ✅ **代码已落地**（v0.1.15）· 静态验收 `tmp/verify-preset-mcp.mjs` **21/21**；**运行时闭环仍待一次真实引擎会话**（ISSUE-06） |

### B.1 · B4 的两处偏差（实现 vs AionUi 参照）

> 参照：用户提供的两张 AionUi 截图（详情页 env 编辑器 + 引擎管理列表）。
> 结论：**两处都不是设计缺失，而是 `client.js` 偏离了 UI-DESIGN 已写明的设计**，B4 是把实现拉回设计并对齐参照。

**① CLI 路径不可编辑**
- 现状：`client.js` 把可执行体渲染成只读文本（`可执行体: ${row.executable}`，[client.js:235](../lib/client.js)），无编辑入口。
- 后端**已支持**：`PUT /multi-acp/engines/:id` 的 `mergeEnginePatch` 接受 `resolvedCommand` / `args` / `cwdPolicy`（[routes.js:94-98](../lib/routes.js)）。
- 设计**已含**：UI-DESIGN §4.2 的「启动方式（可覆盖）」块 —— 对应 `EngineSpec.resolvedCommand` / `args`。理由：内置 `commandOverrides.windows` 是本机路径，换机器会失效。
- **B4-① 待做（仅前端）**：在引擎行内加「覆盖启动方式」折叠编辑（command/args/cwdPolicy 三字段），保存时随 `PUT` 一并提交；未覆盖时显示探测到的 `executable` 为占位。
  - ✅ **已做（v0.1.15）**：`client.js` 的 `renderEditor()` —— 折叠按钮「覆盖启动方式 ▸」→ （command / args / cwdPolicy）三个受控输入；
    args 用 `parseArgs()` 支持引号整段（如 `--skill "C:\Users\x\.agents\skills"`）；未改动 args 时**不下发**，避免把内置 args 洗掉。

**② 环境变量编辑器形态**
- 现状：单个 `<textarea>`，约定「每行 KEY=VALUE」（`parseEnv`，[client.js:109-116](../lib/client.js)）。
- AionUi 参照：每行 = **变量名输入框 + 值输入框（默认打码）+ 👁 临时显示 + 🗑 删除**，底部「＋添加变量」空行 —— 即"两段（key/value）"设计。
- **顺带必修的语义 bug**：现 textarea 的删除是假的 —— `mergeEnginePatch` 只增不删（[routes.js:66-74](../lib/routes.js)），从 textarea 删掉一行后该键仍留在 `engines.json`。改成两栏行后，🗑 删除必须对该键显式传 `null` 才能真正移除。
- **B4-② 待做（前端为主 + 一个后端约定确认）**：重写 env 编辑区为受控的 key/value 行列表；`save` 时把「被删除的键」以 `{ [key]: null }` 并入 `env` patch。后端 `null`=删除 的契约已存在，无需改路由，仅需前端按此发送。
  - ✅ **已做（v0.1.15）**：`envPatch()` 收集「未动 + 新增」的键，并把 🗑 掉的**已存在键**以 `null` 下发；
    `verify-ui.mjs` 直接断言 PUT body 里 `OPENCODE_TOKEN === null` 且 `PLAIN === 'x'`（未动的键不受影响）。

> 版本约定照旧：B4 每完成一条子项 → 升 version + 写 CHANGELOG。

**关键设计点**（详见 UI-DESIGN.md）：
- **白拿**：预设选择器 / 锁定提示 Toast / 配置只读查看器 —— 官方 `ui-agent-preset` 已覆盖，**不要重写**
- **必须自己写**：引擎列表 / 测试连接 / 环境变量编辑 / **「绑定此引擎的专家」反向索引**
  （AionUi 那张截图里最有价值的、我原先漏掉的一块）
- **启动方式可覆盖**：内置的 `commandOverrides.windows` 是本机路径，换机器会失效

---

## C · 补齐 opencode 验证

`opencode` 的 ACP 已在 P0 阶段用探针完整验证过（`opencode acp`，能力最宽），
但**尚未在 DSH 里跑过真实会话**（P1 只用 `omp` + `Command Code` 验过）。

| 步骤 | 动作 |
| --- | --- |
| C1 | 新建会话 → 选 `OpenCode` 预设 → 发一句话 |
| C2 | 确认 `opencode.exe` 子进程出现（**这是"走 ACP 路径"的判据**） |
| C3 | 检查轨迹是否正常、有无 `config_option_update`（它的 model/effort/mode 配置组） |

**顺带价值**：`opencode` 是唯一实测支持 **per-session 切模型**（`setSessionConfigOption`）的引擎 ——
跑通它对后续"每专家绑模型"有直接意义。

---

## 环境备忘

```
DSH_HOME        D:\Ecode\.dsh          profile: desktop
插件源码        D:\Ecode\tools\Dsh_Plugins\dsh_multi_acp
已安装位置      <profile>\node_modules\dsh-multi-acp    （pnpm 硬链接）
诊断报告        D:\Ecode\.dsh\multi-acp\load-report.txt
备份            cordis.patch.yml.bak-* / package.json.bak-* / pnpm-lock.yaml.bak-*
回滚            powershell -File tools\rollback.ps1      （已 -WhatIf 预演通过）
```

**迭代循环**：改源码（优先 `Edit`，保留硬链接）→ 升 version → 若改了 package.json 或用了 `Write`
则 `cd <profile>; pnpm install` → 重启 → **看插件页版本号确认加载**
