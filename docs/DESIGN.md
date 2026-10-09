# dsh_multi_acp 设计文档

> **插件名**：`dsh_multi_acp`（建议发布名 `dsh-multi-acp`）
> **目标宿主**：DSH Desktop（本机 `DSH_HOME = D:\Ecode\.dsh`，profile = `desktop`）
> **状态**：设计草案（v0.1），**未实现、未验证**
> **最后更新**：2026-10-07

---

## 0. 证据等级约定（本文档全文适用）

本文档严格区分三类陈述，**请勿混用**：

| 标记 | 含义 |
| --- | --- |
| ✅ **实测** | 在本机读取源码/运行命令直接验证过，附出处 |
| 📖 **参考实现** | 来自第三方实现的既有做法（`dsh-grok-acp` / AionCore），**已读源码但未在本机复现** |
| ❓ **待验证** | 推断或未证。**未验证前不得作为实现依据** |

> 方法论借自 AionCore `AGENTS.md`：*only assert what an approved source proves*。

---

## 1. 目标与非目标

### 1.1 目标

**一个插件驱动多个外部 ACP agent CLI，且"引擎"是数据行而非代码。**

具体：

1. 让 DSH 的一个会话可以由外部 ACP CLI 作为**根 agent**驱动（真·换引擎，非 provider 路线）
2. 新增一个引擎 = **加一行配置**，不是复制一个插件
3. 引擎可启用/停用/排序，有健康检查与"试连"
4. 与原生 DSH agent 共存：未声明引擎的会话仍走官方 DSH factory

### 1.2 非目标（明确排除）

| 排除项 | 原因 |
| --- | --- |
| 会话**中途**切换引擎 | 见 §7 D5：与 DSH 官方闸门一致，且 AionCore 同样不支持（✅实测：`routes/agent.rs` 无此端点，全 crate 搜 `switch_agent\|rebuild_agent\|recreate\|change_agent\|swap_agent` 仅 1 处无关注释） |
| 替换 agent loop 本体 | preset 不在 loop 层（✅实测：`router-standard/agent.cordis.yml` 无 `dsh-agent-loop`） |
| 接入 codex | ✅实测无 `acp` 子命令（仅 `app-server`）→ 走 provider 路线，见 `codex-plugin-dsh` |
| 把外部 CLI 当**子代理** | 已有官方 `@deepseek-ai/dsh-subagent-acp`，不重复造 |
| 把外部 CLI 当**模型供应商** | 已有 `@mars-sea/dsh-commandcode-provider` 等 |
| 改写 `cordis.patch.yml` | 见 §7 D2：该文件含**明文凭据** |

---

## 2. 为什么不是"一个 CLI 一个插件"

`dsh-grok-acp`（📖 已读源码）是"一个 CLI 一个插件"的形态，其 README 第 195 行自述：

> 当前没有 Codex 或 Claude Code 适配器；它们应作为**独立 adapter** 接入，而不是向 Grok 实现中加入条件分支。

若照此结构接 opencode + commandcode，将得到**两个近乎重复的插件**（各含 factory 替换、preset 注册、ACP host、UI 路由）。而两个 CLI 的差异**只有启动命令和方言**：

```
opencode     → command: opencode,     args: ["acp"]
commandcode  → command: cmd,          args: ["acp"]     (经 .ps1 shim，见 §10)
grok         → command: npx,          args: ["-y","@xai-official/grok@0.2.102","agent","stdio"]
```

**因此：插件处理协议，引擎是数据。** 这是本插件与 `dsh-grok-acp` 的根本分歧点。

AionCore 已验证这条路可行（📖）：其引擎就是 `CommandSpec { command, args, env, cwd }` 一条数据行，因此能支撑 7+ 引擎。

---

## 3. 架构总览

```
                            DSH Desktop (0.2.0-rc.2)
                                     │
   ┌─────────────────────────────────┼─────────────────────────────────┐
   │                                 │                                 │
[agents]                       [agentPresets]                    [webServer]
   │                                 │                                 │
 factory 槽位 ──替换──► MultiAcpRouter            resolvedRoots += <pkg>/presets/acp-<id>/
   │                        │                                 │
   │            ┌───────────┴───────────┐                     │
   │            │                       │                     │
   │   会话未声明引擎            会话声明引擎 E                  │
   │            │                       │                     │
   │   官方 DSH factory          AcpAgentFactory(E)           │
   │   （原生 agent loop）              │                      │
   │                          AcpHost[E]（懒启动 · 多会话复用 · 空闲回收）
   │                                    │
   └────────────────────────────────────┼─────────────────────┘
                                        │ JSON-RPC over stdio (ACP)
                     ┌──────────────────┼──────────────────┐
                     ▼                  ▼                  ▼
              opencode acp          cmd acp        npx … grok agent stdio
```

**关键点：官方 factory 被保存为 fallback**，所以"这个会话跑原生 DSH"不需要额外机制——这正是 📖 `dsh-grok-acp` 的 `HarnessRouterFactory(ctx, originalSlot.target, grokFactory)` 的做法。

---

## 4. 核心机制（五个接入点）

以下五点全部来自 📖 `dsh-grok-acp/lib/index.js`（74 行内），已逐行读过：

### 4.1 服务注入

```js
export const inject = [
  'agents', 'agentPresets', 'sessions', 'sessionPersistence',
  'subprocess', 'approval', 'commands',
]
```

📖 对比 `experts-management` 的 inject（`src/index.js:585`）为
`['skills','webServer','settings','agents','agentDefaultModel','sessions','connection']`
—— 两者**没有交集冲突**，但本插件比它多要 `agentPresets` / `subprocess` / `approval`。

❓ 待验证：`subprocess` / `approval` / `agentPresets` 在 0.2.0-rc.2 的实际 API 形态。

### 4.2 替换 agent factory（"换引擎"的本体）

```js
const agents = unwrapService(ctx.agents)
const originalSlot = agents.factory        // 官方 agent-loop 的 factory
agents.factory = { target: new MultiAcpRouter(ctx, originalSlot.target, engineFactories) }
```

- `originalSlot.target` 是**官方 factory 本体**，保留作"走原生 DSH"分支
- `MultiAcpRouter` 按会话决定走哪一支
- ❓ **待验证（最高风险，见 §12 R1）**：0.2.0-rc.2 里 `agents.factory` 槽位是否仍存在、结构是否仍为 `{ target }`

### 4.3 注册 preset 根

```js
const presets = unwrapService(ctx.agentPresets)
presets.resolvedRoots = [multiAcpPresetsRoot, ...originalRoots]
```

📖 包内 `presets/` 目录被提升为**系统信任的 preset 根**。DSH 的 preset 结构（✅实测，本机 `.agent-presets/`）：

```
presets/<name>/
├── preset.yml          # name / description / order   ← 仅显示元数据
└── agent.cordis.yml    # 组合定义（14-19 KB）+ 可选 bootstrap .mjs
```

❓ 待验证：**多引擎时 preset 怎么摆**。两个候选方案，见 §7 D4。

### 4.4 ACP 子进程

📖 grok 版的配置形态：

```js
{
  command: 'grok',
  args: ['agent', '--no-leader', 'stdio'],
  stateFile: <DSH_HOME>/grok-harness-sessions.json,
  disposeGraceMs: 6000,
  idleDisposeMs: 30000,
}
```

并且 README 第 34 行明确：**多个会话复用一个按需启动的 ACP 进程，空闲后自动关闭。**

→ 本插件：**每个引擎一个 `AcpHost` 实例**（不是每会话一个进程）。

### 4.5 会话切换闸门

```js
if (!sessionBlank(session)) throw new Error('会话开始后不能再切换 Harness')
```

📖 README 第 33 / 111 行的设计理由：**避免一段历史由两个 Agent 引擎共同生成。**

→ 本插件**沿用**该闸门，不绕过。见 §7 D5。

---

## 5. 引擎数据模型

完整 schema 与三个目标引擎的实测参数见 **[ENGINE-SPEC.md](./ENGINE-SPEC.md)**。此处只列形状：

```jsonc
{
  "id": "opencode",
  "label": { "zh": "OpenCode", "en": "OpenCode" },
  "command": "opencode",
  "commandOverrides": { "windows": "C:\\...\\opencode.exe" },
  "args": ["acp"],
  "env": {},
  "cwdPolicy": "session",              // session | fixed
  "initBudget": { "steadySecs": 30, "coldSecs": 300, "coldProbe": "npx-cache" },
  "dialect": "canonical",              // canonical | <name>（见 §9）
  "capabilities": { "fs": true, "terminal": false, "modes": [], "models": true },
  "enabled": true,
  "sortOrder": 10
}
```

**设计原则**：schema 中的每个字段都必须有"哪个引擎真的需要它"的实证。**不预先设计没人用的字段。**

---

## 6. 状态与持久化

| 数据 | 位置 | 理由 |
| --- | --- | --- |
| 引擎定义（内置默认） | 插件包内 `engines/builtin.json` | 随包分发 |
| 引擎定义（用户编辑） | `$DSH_HOME/multi-acp/engines.json` | 插件自管，**不碰 cordis.patch.yml** |
| 会话↔ACP sessionId 映射 | `$DSH_HOME/multi-acp/sessions.json` | 📖 同 `dsh-grok-acp` 的 `stateFile` |
| 诊断/最近一次试连结果 | 同上（同文件或旁挂） | 便于 issue 排查 |

⚠️ **不得写入 `cordis.patch.yml`**。✅实测该文件含 MCP 行的明文凭据（云效 token / 钉钉 secret）；程序化重写有泄漏与破坏 `dsh-agent-sync` 托管块的风险。

---

## 7. 关键设计决策

| # | 决策 | 理由 / 取舍 |
| --- | --- | --- |
| **D1** | 一个插件 + 引擎数据行 | §2。避免为每个 CLI 复制插件；AionCore 已验证（📖） |
| **D2** | 引擎配置放插件自管文件 + settings，**绝不写 cordis.patch.yml** | 凭据风险（§6）。✅ **Step 0 后更有底气**：preset 可用 `agentPresets.register()` 程序化注册，**根本不需要碰配置文件** |
| **D3** | 保留官方 factory 作 fallback | "跑原生 DSH"零成本；📖 grok 版同构；✅ Step 0 确认 `agents.factory` 形状为 `{ target }` |
| **D4** | ~~每个引擎物化一个 preset 目录，注册为 `resolvedRoots`~~ → **在 `apply()` 中为每个引擎调 `agentPresets.register({ id, name, description, order, plugins })`，保存返回的 `unregister` 作清理** | ✅ **Step 0 修订**：`resolvedRoots` 在 0.2.0-rc.2 **已移除**；替代品 `register(definition)` 是公开方法、返回 disposer、所有权归声明方 |
| **D5** | ~~沿用 `sessionBlank` 闸门~~ → **直接用官方 `agentPresets.select(agent, presetId)`** | ✅ **Step 0 修订**：`select()` 内部已做 `recompose` + `session.append("agent-preset/selected")`，锁门判定用 `turnBoundary` projection（比 `sessionBlank()` 更精确），并抛可透传的 `RemoteError("agent-preset/locked", …)`。**语义仍与 AionCore 一致：会话开始后不可换引擎** |
| **D6** | 每引擎一个 AcpHost，多会话复用进程 | 📖 省资源；⚠️ 前提是目标 CLI 的 ACP 实现支持一个进程服务多 session（❓ 待验证，见 R3） |
| **D7** | 预留方言层，默认 canonical 直通 | §9。ACP 实际上"每个实现都有方言" |
| **D8** | 握手超时分冷/稳态两档 | §9.2。📖 AionCore 实测数据 |
| **D9** | 提供"试连"（try-connect） | 接 ACP CLI 最大的痛点是"它没实现这个方法"vs"我参数错了"。📖 AionCore 有 `POST /api/agents/custom/try-connect` |
| **D10** | 引擎列表暴露给专家管理层，但**专家包不直接定义引擎** | 见 §11 |

---

## 8. 生命周期

```
会话创建
  └─ 用户选择引擎 E（或默认"原生 DSH"）
       └─ session.append('agent-preset/selected', { agentPreset })   📖
            └─ MultiAcpRouter 解析 → AcpAgentFactory(E)
                 └─ AcpHost[E].ensureStarted()          # 懒启动
                      ├─ spawn(E.command, E.args, env)
                      ├─ ACP initialize（预算见 §9.2）
                      ├─ authenticate（如需要）
                      └─ session/new  或 session/load
                           └─ 会话轮次 → session/prompt → 流事件 → 渲染
会话关闭 / 空闲超时
  └─ AcpHost[E].release(sessionId)
       └─ 无活跃会话 → 空闲 disposeGraceMs 后关闭进程
```

**必须处理的异常路径**：

- `initialize` 超时 → 区分冷启动/稳态超时，给用户可读的错误（📖 AionCore 的 `InitBudget { timeout, cold_start }` 就是为了把"300s 等待"解释清楚）
- 子进程崩溃 → 会话标记为不可用，**不静默重试**（避免重复消费用户输入）
- 引擎被停用但会话仍引用它 → 明确报错，不 fallback 到别的引擎（避免"历史由两个引擎生成"）

---

## 9. 方言与握手

### 9.1 ACP 方言层

📖 AionCore `protocol/acp_dialect.rs` 的 doc comment 是本设计的重要依据：

> 官方 `agent-client-protocol(-schema)` 只接受标准 `SessionUpdate` 变体，会对非标准 `session/update` 形状硬拒绝 `-32602`，**静默丢掉信号**。

其对策值得直接抄：

- 在**传输边界、SDK 解析之前**做 line-level 分类
- 已知非标准 shape → **absorb** 成内部信号
- 其余一切（含真错误、未知变体）→ **原样转发**，让 SDK 继续报 `-32602`
  （原注释：*never swallow real errors*）
- wire shape **必须来自真实抓包**，不得推断

**本插件的设计**：

```
acp-transport (readline)
   └─ dialect.classify(line) → Forward(line) | Absorb(signal)
        └─ sdk.parse(line)   （仅 Forward 的行）
```

引擎 schema 的 `dialect` 字段选择分类器档案；默认 `canonical`（全部 Forward，零行为变化）。

⚠️ **初始版本只实现 `canonical`**。为 opencode / commandcode 建立方言档案，要等 §P2 阶段拿到真实抓包后再做——**不预设它们有方言**。

### 9.2 握手预算

📖 AionCore `protocol/acp_init_budget.rs`：

- 稳态 `INIT_TIMEOUT_SECS = 30`
- 冷启动 `COLD_START_INIT_TIMEOUT_SECS = 300`
- 原因：`npx -y <pkg>` 的**首次安装发生在握手窗口内**；实测 `@oh-my-pi/pi-coding-agent` 冷 81s vs 热 10s
- 冷启动判定：`_npx/<hash>` 缓存目录是否存在
- 可用环境变量覆盖

**本机实测影响**：`opencode` 是原生 `.exe`（✅），无此问题；但 `grok` 走 `npx -y`（✅实测 AionCore 用的就是这个形式），会踩。故 schema 保留 `coldProbe` 字段。

---

## 10. Windows 专项

✅ 本机实测的引擎形态差异：

| 引擎 | 形态 | 影响 |
| --- | --- | --- |
| `opencode` | `C:\Users\...\.opencode\bin\opencode.exe`（**原生 exe**） | 直接 spawn，无坑 |
| `commandcode` | `C:\nvm4w\nodejs\commandcode.ps1`（**PowerShell shim**） | ⚠️ 需 shim 策略 |
| `grok` | `npx` 拉起 | 需冷启动预算 |

**待办**：

1. ❓ 验证 DSH `subprocess` 服务 spawn `.ps1` / `.cmd` 的正确姿势（是否走 shell？`shell: true`？）
2. ❓ 若 subprocess 不支持 `.ps1`，需要一层 wrapper（例如生成 `.cmd` 转发，或用 `pwsh -File` 显式调用）。**优先找原生 exe** 规避
3. 📖 参考 AionCore 的 Windows 特例：codex 的 `danger-full-access` 需额外注入 `windows.sandbox="unelevated"`
4. ⚠️ `dsh-grok-acp` 声明前置条件为"macOS 或能运行 Grok CLI 的环境"，**Windows 未验证**；本插件不能假定其 Windows 路径可用

---

## 11. 与 experts-management 的关系

**分层原则：引擎是宿主的，专家只声明"我要用哪个引擎"。**

```
dsh_multi_acp（本插件）              dsh_experts-management_plus
  ├─ 定义/管理引擎                     ├─ 专家包声明 modelSelection / agentPreset
  ├─ 暴露"可用引擎列表"给 UI    ◄──────┤─ UI 下拉选择（数据来自本插件）
  └─ 会话级引擎路由                    └─ 创建会话时把选择传给宿主
```

- 本插件**不感知专家概念**
- 专家包**不定义引擎**（不写 `command`/`args`），只写**引擎 id 引用**
- ❓ 待验证：专家触发建会话时，如何把 `agentPreset` 传下去（📖 `agents.create({ meta: { agentPreset } })` 是已知入口，但专家侧是另一条路径）

⚠️ **依赖顺序**：本插件的 P0/P1 与 experts-management PLUS 版**互不阻塞**，可并行。

---

## 12. 风险登记表

| # | 风险 | 严重度 | 验证方式 | 若不通过的退路 |
| --- | --- | --- | --- | --- |
| **R1** | `agents.factory` 槽位在 **0.2.0-rc.2** 已变/已删 | ~~🔴 致命~~ ✅ **已消除** | ✅ **Step 0 实测**：`AgentFactory` 接口在；`agents.factory` 是普通实例属性、形状 **`{ target }`**（`setFactory` 内部就这么赋值）；消费方 `requireFactory()` 读 `.target` → **grok 的直接赋值写法成立**。见 `evidence/P0-step0-asar-findings.md` §1 | 不适用 |
| **R2** | `agentPresets` API 签名变化 | ~~🔴 高~~ ✅ **已消除**（需换 API） | ✅ **Step 0 实测**：`resolvedRoots` **已移除**，但 `register(definition)` / `recompose(ctx,id)` / **`select(agent,presetId)`** 均在。见 `evidence/P0-step0-asar-findings.md` §2 | 不适用 |
| **R3** | 目标 CLI 的 ACP 实现**不支持一个进程服务多 session** | ~~🟠 中~~ ✅ **已消除** | ✅ **实测通过**：OpenCode 与 CommandCode 均支持同进程多 session（`docs/evidence/`） | 不适用（D6 成立） |
| **R4** | `cmd acp` 的 `.ps1` shim 无法被拉起 | ~~🟠 中~~ 🟡 **降级** | ✅ **已证明可拉起**：`pwsh -NoProfile -ExecutionPolicy Bypass -File <shim> acp`。**仍待验证**：DSH `subprocess` 服务是否支持同样的调用形式 | 找原生 exe / 写 `.cmd` 转发 |
| **R5** | opencode / commandcode 的 ACP 只实现了部分方法 | ~~🟡 低‑中~~ ✅ **已消除** | ✅ **实测**：两者均完成 `initialize`→`session/new`→`prompt` 全链路；能力清单见 ENGINE-SPEC §8.2 | 不适用 |
| **R6** | 两者的非标准 ACP 方言 | 🟡 低 | ⚠️ **本批次 0 条解析失败，但只覆盖正常路径**——异常路径仍需抓包 | 方言层 absorb（§9.1） |
| **R7** | DSH 0.2.0-rc.2 的 `subprocess` / `approval` 服务 API 与 grok 版假设不符 | 🟠 中 | 读源码 | 按实际 API 适配 |
| **R8** | 与 `experts-management` 客户端插件的 Slot 冲突 | 🟡 低 | 同时启用后跑 UI | 命名空间隔离 |

---

## 13. 阶段计划

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| **P0 验证** | 见 [VERIFICATION.md](./VERIFICATION.md)。R1/R2 是 go/no-go | **R1 不通过即终止本项目** |
| **P1 最小可用** | 单引擎（opencode）+ 会话级选择 + 官方 fallback | 一个会话能由 `opencode acp` 驱动完成一轮对话 |
| **P2 多引擎** | 引擎注册表 + 第二引擎（commandcode）+ 启用/停用/排序 | 两个引擎在**不同会话**同时可用 |
| **P3 健壮性** | 方言层（取真实抓包后）+ 冷/稳态握手预算 + 试连 UI + 健康检查 | 引擎 crash / 握手超时有可读诊断 |
| **P4 集成** | 引擎列表暴露给 experts-management PLUS 版 | 专家可声明引擎并生效 |

**P1 之前不动 `docs/` 之外的任何文件。**

---

## 14. 开放问题（待验证清单）

1. ❓ `agents.factory` 在 0.2.0-rc.2 的确切定义与替换语义（**R1，最高优先**）
2. ❓ `agentPresets.resolvedRoots` / `recompose` / `agentPresets` 服务的确切签名（R2）
3. ❓ 多引擎的 preset 组织方式（D4 的两个方案哪个可行）
4. ❓ `subprocess` 服务如何 spawn `.ps1` / `.cmd`（R4）
5. ❓ `approval` 服务如何对接 ACP 的权限请求（`session/request_permission`）
6. ❓ `opencode acp` / `cmd acp` 的 ACP 方法覆盖度（R5）
7. ❓ 两者是否支持一个进程服务多 session（R3）
8. ❓ 专家触发建会话时如何传递 `agentPreset`（§11）

---

## 附录 A：参考实现与出处

| 参考 | 用途 | 已读 |
| --- | --- | --- |
| `dsh-grok-acp`（`github.com/zmh2000829/DSH-agent-bridge`） | 路线 B 的主骨架 | ✅ `lib/index.js`、`lib/preset-marker.js`、`presets/*`、README |
| AionCore（`github.com/iOfficeAI/AionCore`） | 多引擎架构、方言层、握手预算、Windows 特例 | ✅ `protocol/acp_dialect.rs`、`protocol/acp_init_budget.rs`、`factory/acp_launch_policy.rs`、`routes/agent.rs`、`api-types/custom_agent.rs` |
| `dsh-plugin-kit`（`@weibaohui`） | DSH 插件 API 实际用法 | ✅ `src/index.js` |
| `experts-management`（`@weibaohui`） | 服务注入的实际样例、客户端 slot 用法 | ✅ `src/index.js`（部分）、`README.md` |

## 附录 B：术语

| 术语 | 含义 |
| --- | --- |
| **引擎 / harness** | 驱动一个会话的 agent 运行时。本插件语境下指一个外部 ACP CLI |
| **provider** | 模型供应商（如 commandcode / opencode-go）。**与引擎是正交的两个维度** |
| **preset** | DSH 的 agent 行为组合（工具/委派/规划/persona）。**是引擎的配置，不是引擎本身** |
| **root agent / 根 agent** | 掌握整个会话的 agent（相对"子代理"） |
| **subagent** | 被主任务派一次性活的 agent |
| **Dialect / 方言** | 某 CLI 对 ACP 的非标准扩展或偏离 |
