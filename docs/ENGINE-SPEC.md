# 引擎规格（EngineSpec）

> 配套文档：[DESIGN.md](./DESIGN.md) · [VERIFICATION.md](./VERIFICATION.md)
> 证据等级标记沿用 DESIGN.md §0（✅实测 / 📖参考实现 / ❓待验证）

---

## 1. 设计原则

**每个字段都必须有"哪个引擎真的需要它"的实证。不预先设计没人用的字段。**

这条原则来自对 AionCore 的观察（📖）：它的 `CustomAgentAdvancedOverrides` 只有 4 个字段（`yolo_id` / `native_skills_dirs` / `behavior_policy` / `description`），而且源码里有一个**专门的测试**保证 `skill_delivery` **不能**从用户侧设置，注释理由是：

> 它是**厂商能力声明**，应由 registry/probe 决定，不是用户偏好。开放它必须是同时改前后端两个仓库的一次性变更。

→ 推论：**"引擎天生具备什么"属于声明，"用户想怎么用"属于偏好，两者不能混在一个字段表里。**

---

## 2. EngineSpec schema

```jsonc
{
  // ── 身份 ────────────────────────────────────────────
  "id": "opencode",                    // 稳定标识，会话映射/状态文件以此为键
  "label": { "zh": "OpenCode", "en": "OpenCode" },
  "icon": "opencode",                  // 图标 key，UI 侧解析
  "description": { "zh": "...", "en": "..." },

  // ── 启动 ────────────────────────────────────────────
  "command": "opencode",
  "commandOverrides": {                // 按平台覆盖
    "windows": "C:\\Users\\29096\\.opencode\\bin\\opencode.exe"
  },
  "args": ["acp"],
  "env": {},                           // 附加环境变量
  "cwdPolicy": "session",              // session = 用会话工作目录 | fixed
  "cwd": null,                         // cwdPolicy=fixed 时使用

  // ── 握手 ────────────────────────────────────────────
  "initBudget": {
    "steadySecs": 30,                  // 📖 AionCore INIT_TIMEOUT_SECS
    "coldSecs": 300,                   // 📖 AionCore COLD_START_INIT_TIMEOUT_SECS
    "coldProbe": "none"                // none | npx-cache
  },

  // ── 协议 ────────────────────────────────────────────
  "dialect": "canonical",              // canonical | <存档名>
  "capabilities": {                    // 探测所得，非用户可编辑
    "fs": null,                        // null = 未探测
    "terminal": null,
    "permissionRequests": null,
    "configOptions": null,
    "models": null,
    "modes": null
  },

  // ── 生命周期 ────────────────────────────────────────
  "disposeGraceMs": 6000,              // 📖 grok 版取值
  "idleDisposeMs": 30000,              // 📖 grok 版取值

  // ── 管理 ────────────────────────────────────────────
  "enabled": true,
  "sortOrder": 10,
  "health": {                          // 运行时写入，只读
    "lastCheckAt": null,
    "status": "unknown",               // unknown | ok | degraded | failed
    "latencyMs": null,
    "error": null
  }
}
```

### 字段依据

| 字段 | 依据 |
| --- | --- |
| `command` / `args` / `env` | 📖 AionCore `CommandSpec { command, args, env, cwd }` —— 其自有测试即 `omp acp`、`npx -y @xai-official/grok@0.2.102 agent stdio` |
| `initBudget` | 📖 AionCore `acp_init_budget.rs`（冷启动 300s 的理由：npx 首次安装在握手窗口内） |
| `dialect` | 📖 AionCore `acp_dialect.rs` |
| `disposeGraceMs` / `idleDisposeMs` | 📖 `dsh-grok-acp` 实际取值 |
| `enabled` / `sortOrder` | 📖 AionCore `PATCH /api/agents/{id}/enabled`、`AgentMetadata.sort_order` |
| `health.*` | 📖 AionCore `last_check_status` / `last_check_latency_ms` / `last_check_error` |
| `capabilities` | 📖 AionCore 把 `skill_delivery` 归为"厂商能力声明，由 registry/probe 决定" |

**刻意不含**：`provider` / `model`（那是 provider 维度，见 DESIGN §附录B）、`permissions`（走 `approval` 服务，见 DESIGN §14-5）。

---

## 3. 目标引擎（本机 ✅ 实测）

| 引擎 | 版本 | 可执行体 | ACP 启动方式 | 状态 |
| --- | --- | --- | --- | --- |
| **OpenCode** | v2.0.23 | `C:\Users\29096\.opencode\bin\opencode.exe`（**原生 exe**） | `opencode acp` | ✅ 有 `acp` 子命令 |
| **Command Code** | v1.76.0 | `C:\nvm4w\nodejs\commandcode.ps1`（**PowerShell shim**） | `cmd acp` | ✅ 子命令自述 "Run as an ACP agent over stdio (for Zed, etc.)" |
| **omp（oh-my-pi）** | v18.3.5 | `C:\Users\29096\AppData\Local\omp\omp.exe`（**原生 exe**） | `omp acp` | ✅ 子命令自述 "Run omp as an ACP (Agent Client Protocol) server over stdio" |
| （Codex） | — | `codex.exe` | — | ❌ **无 `acp`**，仅 `app-server` → 不在本插件范围 |
| （Grok） | 未安装 | `npx -y @xai-official/grok@0.2.102` | `… agent stdio` | 📖 参考用（AionCore / dsh-grok-acp 的形态） |

两位 CLI 的 ACP 子命令描述原文：

```
opencode:     acp    Start an Agent Client Protocol server
commandcode:  cmd acp    Run as an ACP agent over stdio (for Zed, etc.)
```

> ⚠️ **只有子命令存在 ≠ 协议实现完整。** 必须跑 [VERIFICATION.md](./VERIFICATION.md) 的 §3 握手探测，逐项对 §4 的方法清单。

### 3.1 预置引擎定义

> ⚠️ 以下 `commandOverrides.windows` **必须由探测结果确认**，不是抄本机路径就完事——用户机器不同、版本升级会变路径。

```jsonc
{
  "id": "opencode",
  "label": { "zh": "OpenCode", "en": "OpenCode" },
  "command": "opencode",
  "commandOverrides": { "windows": "C:\\Users\\29096\\.opencode\\bin\\opencode.exe" },
  "args": ["acp"],
  "cwdPolicy": "session",
  "initBudget": { "steadySecs": 30, "coldSecs": 300, "coldProbe": "none" },
  "dialect": "canonical",
  "enabled": true,
  "sortOrder": 10
}
```

```jsonc
{
  "id": "commandcode",
  "label": { "zh": "Command Code", "en": "Command Code" },
  "command": "cmd",
  "commandOverrides": {
    "windows": "C:\\nvm4w\\nodejs\\commandcode.ps1"   // ⚠️ .ps1 需要 shim 策略，见 DESIGN §10
  },
  "args": ["acp"],
  "cwdPolicy": "session",
  "initBudget": { "steadySecs": 30, "coldSecs": 300, "coldProbe": "none" },
  "dialect": "canonical",
  "enabled": true,
  "sortOrder": 20
}
```

---

## 4. ACP 能力清单（探测基线）

> ⚠️ **本节已被实测取代** —— 见下方 **§8 实测结果（P0 已执行 · 2026-10-07）**。保留本节是为了让"当初预期探测什么"可追溯。

📖 来自 `dsh-grok-acp` README 第 138-145 行的验收范围。**逐项探测并记录结果**，不假设。

### 4.1 生命周期

| 方法 | 必需性 | opencode | commandcode |
| --- | --- | --- | --- |
| `initialize` | **必需** | ❓ | ❓ |
| `authenticate` | 视实现 | ❓ | ❓ |

### 4.2 会话

| 方法 | 必需性 | opencode | commandcode |
| --- | --- | --- | --- |
| `session/new` | **必需** | ❓ | ❓ |
| `session/prompt` | **必需** | ❓ | ❓ |
| `session/cancel` | 期望 | ❓ | ❓ |
| `session/resume` | 期望 | ❓ | ❓ |
| `session/load` | 期望 | ❓ | ❓ |
| `session/close` | 期望 | ❓ | ❓ |
| `session/set_config_option` | 期望（mode/模型切换） | ❓ | ❓ |

### 4.3 流事件（`session/update`）

| 事件类 | opencode | commandcode |
| --- | --- | --- |
| assistant message chunk | ❓ | ❓ |
| thought / reasoning chunk | ❓ | ❓ |
| tool call | ❓ | ❓ |
| tool result | ❓ | ❓ |
| plan | ❓ | ❓ |
| commands（斜杠命令清单） | ❓ | ❓ |
| model / mode 变更通知 | ❓ | ❓ |

### 4.4 宿主回调

| 方法 | 说明 | opencode | commandcode |
| --- | --- | --- | --- |
| `fs/read_text_file` | 外部 agent 读文件 | ❓ | ❓ |
| `fs/write_text_file` | 外部 agent 写文件 | ❓ | ❓ |
| `session/request_permission` | 权限请求 → 对接 DSH `approval` 服务 | ❓ | ❓ |

### 4.5 多会话复用（R3）

| 探测 | opencode | commandcode |
| --- | --- | --- |
| 同一进程连发两次 `session/new` | ❓ | ❓ |
| 两个会话并发 `session/prompt` | ❓ | ❓ |

---

## 5. 方言档案（Dialect Profile）

**初始版本不实现任何方言档案。** 只提供 `canonical`（全部 Forward）。

📖 建立档案的正确方法（照 AionCore 的做法）：

1. 跑真实会话，**抓原始 stdio 行**
2. 找到被 SDK 拒绝的行（`-32602` / 反序列化失败）
3. **把真实报文写进测试常量**（AionCore 就是这么做的——注释明确标注报文来自 `logs.txt:8798` / `:523`）
4. 分类器只 absorb**已确认的那几种形状**，其余原样转发
5. 断言"真错误必须仍能被 SDK 报出来"

❌ **禁止**：凭"ACP 应该长这样"的推测预先写分类规则。

---

## 6. 需采集的探测数据（每个引擎一份）

一次 `try-connect` 应产出并落盘：

```jsonc
{
  "engineId": "opencode",
  "probedAt": "2026-10-07T...",
  "command": "opencode",
  "args": ["acp"],
  "spawn": { "ok": true, "pid": 1234, "stderrExcerpt": "" },
  "initialize": {
    "ok": true,
    "latencyMs": 812,
    "coldStart": false,
    "agentInfo": { /* 原样保留 */ },
    "authMethods": [ /* 原样保留 */ },
    "capabilities": { /* 原样保留 */ }
  },
  "methods": { "session/new": "ok", "session/load": "method_not_found", "...": "..." },
  "dialectRejects": [ /* 被 SDK 拒绝的原始行，逐条 */ ],
  "notes": ""
}
```

**采集纪律**：

- 原始报文**逐字保留**（这是方言档案的唯一合法来源）
- 但**不得落盘凭据**（token / key / cookie）——采集时脱敏
- 失败也要落盘（`method_not_found` 与"没测"是两种不同状态）

---

## 7. 状态文件格式

`$DSH_HOME/multi-acp/engines.json`（用户编辑层，覆盖内置）：

```jsonc
{
  "version": 1,
  "engines": [ /* EngineSpec[]，只存与内置不同的条目或用户新增的 */ ]
}
```

`$DSH_HOME/multi-acp/sessions.json`（运行时映射）：

```jsonc
{
  "version": 1,
  "sessions": {
    "<dshSessionId>": {
      "engineId": "opencode",
      "acpSessionId": "...",
      "createdAt": "...",
      "lastUsedAt": "..."
    }
  }
}
```

⚠️ 按 DESIGN §7 D5：**一旦会话发出首条消息，`engineId` 不得再被修改**。状态文件里应把这一点做成硬不变量（读取时校验并拒绝非法变更）。

---

## 8. 实测结果（P0 已执行 · 2026-10-07）

**执行方式**：`probe/probe-acp.mjs`，用官方 `@agentclientprotocol/sdk@0.25.1` 的 `ClientSideConnection` 真实握手。
**原始证据**：`docs/evidence/probe-*.json`（脱敏）。

### 8.1 结论：两个引擎都跑通了完整对话往返

| | **OpenCode** | **Command Code** | **omp（oh-my-pi）** |
| --- | --- | --- | --- |
| 版本 | 2.0.23 | 1.76.0 | 18.3.5 |
| spawn | 原生 exe 直启 ✅ | `.ps1` → `pwsh -File` ✅ | 原生 exe 直启 ✅ |
| `initialize` | 782 ms | 3130 ms | **579 ms**（最快） |
| `agentInfo.name` | `OpenCode` | `Command Code` | `oh-my-pi`（`title: omp`） |
| 登录 | `opencode-login` | 已登录 | `agent` — 复用 `~/.omp` 本地凭据 |
| `session/new` | ✅ | ✅ | ✅ |
| **多会话复用（R3）** | ✅ 同进程 2 session | ✅ 同进程 2 session | ✅ 同进程 2 session |
| **`session/prompt` 全链路** | ✅ `PONG` · `end_turn` · 15836 ms | ✅ `PONG` · `end_turn` · 19258 ms | ✅ `end_turn` · **5200 ms**（最快） |
| 流事件 | thought×14 · message · usage · available_commands · config_option_update | thought×27 · message · usage | available_commands×2 · **`session_info_update`×3** · message×2 · usage |
| `usage` 反馈 | `cost=0`（免费模型） | `cost=$0.001847` | `cost=$0.0029046` |
| **方言解析失败** | **0** | **0** | **0** |

> **omp 是三者中 ACP 实现最完整的**：唯一支持 **MCP over SSE**（`sse: true`）、唯一同时暴露 `modes` **和** `configOptions`、启动与往返都最快。

→ **R3（多会话复用）✅ 通过**，DESIGN §7 D6（每引擎一个进程）**成立**
→ **R4（`.ps1` shim）✅ 通过**（`pwsh -NoProfile -ExecutionPolicy Bypass -File <shim> acp`）
→ **R6（方言）本批次未发现异常**，但不等于没有（只覆盖了正常路径）

### 8.2 `agentCapabilities` 实测原文

**OpenCode**（能力更宽）：

```json
{
  "loadSession": true,
  "mcpCapabilities": { "http": true, "sse": false },
  "promptCapabilities": { "embeddedContext": true, "image": true },
  "sessionCapabilities": {
    "additionalDirectories": {}, "close": {}, "delete": {},
    "fork": {}, "list": {}, "resume": {}
  },
  "_meta": { "opencode/child-session-updates": true }
}
```

**Command Code**：

```json
{
  "loadSession": true,
  "promptCapabilities": { "audio": false, "image": true, "embeddedContext": true },
  "mcpCapabilities": { "http": true, "sse": false },
  "sessionCapabilities": { "list": {}, "resume": {}, "close": {} }
}
```

**omp**：

```json
{
  "loadSession": true,
  "mcpCapabilities": { "http": true, "sse": true },
  "promptCapabilities": { "embeddedContext": true, "image": true },
  "sessionCapabilities": { "list": {}, "fork": {}, "resume": {}, "close": {} }
}
```

**三方对比总结**：

- 三者都支持 `session/list` · `session/resume` · `session/close` · `loadSession` · 图片 · embedded context
- 三者都支持 **MCP over http**；**只有 omp 额外支持 `sse: true`**
- `session/fork`：OpenCode ✅ · omp ✅ · Command Code ❌
- `session/delete` · `additionalDirectories`：**仅 OpenCode**
- **基础能力已被三方共同覆盖**，`fs/*` 等按需能力未在 capabilities 中声明（需实际调用验证）

### 8.3 ⚠️ 两种不同的"配置"风格（**必须都支持**）

| | OpenCode | Command Code | omp |
| --- | --- | --- | --- |
| 是否给 `modes` | ❌ `modes: null` | ✅ **5 档** | ✅ **2 档** |
| 是否给 `configOptions` | ✅ **3 组** | ❌ | ✅ **2 组** |
| 细节 | `model`（~100 个模型）/ `effort`（none·high·default）/ `mode`（build·plan） | `default` · `auto-accept` · `plan` · `dont-ask` · `bypass` | `mode`（default·plan）/ `model`（默认 `deepseek/deepseek-v4-pro`） |
| 切换方式 | `setSessionConfigOption` ✅ **实测生效** | ❓ 未实测 | ❓ 未实测 |

### ⚠️ 由此得出的关键设计结论

**omp 同时提供 `modes` 和 `configOptions`，是两者的超集。** 因此适配层**不能二选一**，必须：

1. 两条路径都读：优先 `configOptions`（信息更丰富、带 `category`），回退 `modes`
2. 切换时**两条路径都试**（先 `setSessionConfigOption`，失败再试 mode 切换接口）
3. **不要假设"一个引擎只有一种风格"**——omp 已经证伪

另注：`session/new` 响应里带 `modes` 时，`modes.availableModes[].description` 是**可直接展示给用户的权限说明**（Command Code 的 `plan` 写着 "Research and plan only — no edits or commands"，omp 的 `plan` 写着 "drafts a plan to a markdown file before any code changes"）→ **UI 应原样透出，不要自己编文案。**

**新事件类型**：omp 独有 `session_info_update`（opencode / commandcode 均未发出）。适配层需容忍未知事件类型，不可因此报错。

**OpenCode 实测**：`setSessionConfigOption({configId:'model', value:'opencode/nemotron-3.5-lightning-free'})` → 之后 `config_option_update` 确认新值，prompt 成功。**这是 per-session 切模型的原生能力**，直接对应 DESIGN 里"每专家绑模型"的需求。

**Command Code 的 5 档 mode** 天然映射 DSH 的权限/preset 概念，价值很高。

### 8.4 已知用户侧问题（非协议缺陷）

⚠️ **OpenCode 默认模型 `opencode/mistral-large-4` 报 `Insufficient account funds`**。

- 这是**计费问题，不是 ACP 问题**——换成免费模型（`opencode/*-free`）后立刻跑通
- 可用的免费模型（实测存在于 options 中）：`opencode/exo-free`、`opencode/fledge-alpha-free`、`opencode/ling-3.1-flash-free`、`opencode/longcat-2.5-preview-free`、`opencode/mimo-v2.6-flash-free`、`opencode/nemotron-3.5-lightning-free`、`opencode/space-bunny-free` 等
- 直连 DeepSeek 的选项：`deepseek/deepseek-v4-pro`、`deepseek/deepseek-flash`
- → **插件的"试连"功能应当把这种错误原样呈现给用户**（区分"协议不通"与"余额不足"）

### 8.5 仍未验证

| 项 | 状态 |
| --- | --- |
| Command Code / omp 的 `session/set_config_option` | ❓ 未实测（两者的 mode 切换路径）——**仅 OpenCode 验证过切换生效** |
| `session/request_permission` 回调 | ❓ 本轮未触发（trivial prompt 无需权限） |
| `fs/read_text_file` / `fs/write_text_file` 回调 | ❓ 本轮未触发 |
| 工具调用类流事件（`tool_call` / `tool_call_update` / `plan`） | ❓ 本轮未触发 |
| 长时间会话 / 取消（`session/cancel`） | ❓ 未测 |
| 真正的方言异常路径 | ❓ 未覆盖（需构造异常会话） |
