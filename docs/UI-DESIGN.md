# UI 设计（参照 AionUi Agent 管理界面）

> 参照物：AionUi「AI 核心 → Agents」列表页 + 引擎详情页（用户提供的两张截图）
> 配套：[DESIGN.md](./DESIGN.md) · [ENGINE-SPEC.md](./ENGINE-SPEC.md) · [VERIFICATION.md](./VERIFICATION.md)
> 状态：设计稿（v0.1）· **未实现**
> macOS/Windows 术语沿用 DSH：[`cordis.patch.yml`](..) · preset · provider

---

## 0. 参照物拆解

| 截图 | 页面 | 关键元素 |
| --- | --- | --- |
| 图 1 | **引擎列表** | 三态分档 `全部 41 / 可用 6 / 不可用 35`、搜索框、「添加自定义 Agent」、每行：图标 + 名称 + 状态徽章 + 信息图标 +（右侧）MCP/技能计数 + **测试连接** + **编辑** |
| 图 2 | **引擎详情** | 顶部 `← 返回` + 引擎名 + **测试连接**；`已连接` 状态横幅（带诚实免责）；**环境变量编辑器**（键值行 + 显示/删除 + 添加变量）；**保存并测试**；**绑定此 Agent 的助手 (N)** 反向索引 |

### 0.1 从截图里读出的设计意图（值得抄）

1. **三态分档而不是"有/无"** —— `可用 / 未安装 / 不可用`。引擎是**探测出来的**，不是纯手写清单。
2. **"在线 ≠ 已授权"的诚实措辞** —— 原文：

   > 「在线」只表示可连接，并不代表已登录或已授权。如果该工具需要 API 密钥或访问令牌，请在下方「环境变量」中补充。

   以及：

   > 这无法替代在 CLI 中的账号登录（例如用 Google 账号登录 Gemini）。OAuth 登录请在终端里通过 CLI 完成。

   **这正好印证 DESIGN §7 D9 的判断**：接 ACP CLI 最大的坑是"分不清协议不通、未登录、还是余额不足"。
3. **「保存并测试」是一个原子动作** —— 不是"保存"再"另找地方测试"。
4. **反向索引「绑定此 Agent 的助手」** —— 从引擎看"谁在用我"。**这是排障的关键**：改引擎配置前先知道会波及谁。
5. **环境变量是引擎的一等公民** —— 每行一个变量，值默认打码，可临时显示、可删除。

---

## 1. 落到 DSH：能白拿什么、必须自己写什么

### 1.1 白拿（DSH 官方 UI 已覆盖）

| 能力 | 由谁提供 | 依据 |
| --- | --- | --- |
| **引擎/预设选择器** | `@deepseek-ai/dsh-client-ui-agent-preset` | 官方说明：*设置页显示内置与自定义卡片分组、默认项高亮和点击卡片选择*；读 `agentPresets/list` |
| **锁门拒绝提示** | 同上 | *Host 拒绝切换预设时，两处入口均通过 Toast 显示原因* → 我们的 `RemoteError('agent-preset/locked', …)` 自动 Toast |
| **查看 preset 声明** | 同上 | *每张卡片都提供「查看配置」，以只读 YAML 打开该 preset 声明的插件列表* |
| 权限/模式选择 | `ui-permission-presets` | 官方包 |

**结论：P1/P2 不需要任何 preset 选择 UI。**

### 1.2 必须自己写（DSH 没有"引擎"实体）

DSH 的 preset 是**声明式配置**，没有可管理的"引擎"对象。所以要补的正是截图里那两块：

| 截图里的能力 | 本插件对应 | 现状 |
| --- | --- | --- |
| 引擎列表 + 三态 | `lib/engines.js` 的 `BUILTIN` + 探测 | 🟡 数据结构有，**探测没有** |
| 测试连接 | `AcpHost.tryConnect()` | ✅ 已实现 |
| 编辑（环境变量） | `EngineSpec.env` | ✅ 数据结构有，**UI 没有** |
| 保存并测试 | 写 `engines.json` + `tryConnect()` | 🟡 需组装 |
| 添加自定义引擎 | `engines.json` 追加 | ✅ 数据结构支持 |
| 绑定此引擎的专家 | **没有** | ❌ **需新增**（见 §3） |
| 启用/停用、排序 | `EngineSpec.enabled` / `sortOrder` | ✅ 数据结构有，UI 没有 |

---

## 2. 新增设计：引擎源三态（照抄 AionUi 的探测思路）

当前 `loadEngines()` 只有"内置 3 条 + 用户文件覆盖"。**改进为三态**：

```
引擎来源（按优先级）
├── 内置 BUILTIN                  → 可用「候选」种子
├── PATH 探测（新增）              → 决定「已安装 / 未安装」
└── <stateDir>/engines.json       → 用户编辑层（可覆盖任意字段）
```

**探测实现**：

```js
// 对每个引擎候选，按 resolveCommand() 求值后检查可执行性
//   - 原生 exe / PATH 命中        → 状态 'available'
//   - 未命中                       → 状态 'not-installed'
//   - 命中但 tryConnect 失败       → 状态 'unavailable'（附 lastError）
```

**三态与 AionUi 的对应**：

| AionUi | 本插件 | 判据 |
| --- | --- | --- |
| 可用（绿） | `available` | 可执行体存在 |
| 未安装（灰） | `not-installed` | 可执行体不存在 → 附「安装指引」链接 |
| 不可用（红） | `unavailable` | 存在但 `tryConnect()` 失败 → 附 `lastError` |

**候选种子**（用于展示"未安装"项，照 AionUi 的 41 项清单思路）：

| 引擎 | 已知 ACP 启动方式 | 状态 |
| --- | --- | --- |
| `omp` | `omp acp` | ✅ 本机已实测可用 |
| `opencode` | `opencode acp` | ✅ 本机已实测可用 |
| `commandcode` | `cmd acp` | ✅ 本机已实测可用 |
| `grok` | `npx -y @xai-official/grok agent stdio` | 📖 参考实现用（AionCore 同款） |
| `cursor` | 见 `dsh-cursor-acp` | ❓ 未探测 |
| `codex` | ❌ 无 `acp`，仅 `app-server` | 明确不支持，**不该出现在列表里**（或标为"仅 provider 模式"） |

> ⚠️ **种子清单必须来自实测，不允许凭"它可能支持 ACP"就加进来** —— 否则会出现选得中、连不上、报错还说不清的项。

---

## 3. 新增设计：反向索引「绑定此引擎的专家」

AionUi 截图里的 **「绑定此 Agent 的助手 (2)」** 是很有价值的一块，我们要对应做「**绑定此引擎的专家**」。

### 3.1 为什么重要

`acp-omp` 这个 preset 一旦被某个专家包引用（`agentPreset: acp-omp`），**改引擎的 `command`/`env` 就会波及那个专家**。改之前必须先知道"会波及谁"。

### 3.2 实现

```js
// 扫描专家包，找引用本插件 preset 的项
//   数据源：$DSH_HOME/experts/<name>/.codebuddy-plugin/plugin.json
//   判据：agentPreset === 'acp-<engineId>'（或 modelSelection/harness 字段，取决于 PLUS 版落定）
// 输出：[{ expertId, displayName, avatar, detailHref }]
```

**数据来源已实测**：`D:\Ecode\.dsh\experts\` 下的专家包元数据结构已知（见 `docs/ENGINE-SPEC.md` 与项目记忆）。

### 3.3 展示

```
绑定此引擎的专家 (2)
  📰  资讯主编                                        查看详情 ›
  🖥  omp                                           查看详情 ›
```

---

## 4. 页面设计

### 4.1 页面 A：引擎列表

```
┌─────────────────────────────────────────────────────────────┐
│  引擎                                       [🔍 搜索引擎…]  │
│  管理本机可用的 ACP 引擎。新增引擎需该 CLI 支持 ACP over stdio。│
│                                        [＋ 添加自定义引擎 ▾] │
│                                                             │
│  全部 6   可用 3   未安装 2   不可用 1                       │
├─────────────────────────────────────────────────────────────┤
│  🖥  omp          [可用]    MCP ✓ · SSE      [测试连接][编辑] │
│  ⬢  OpenCode     [可用]    fork · delete     [测试连接][编辑] │
│  ⌘  Command Code [可用]    5 modes           [测试连接][编辑] │
│  ✦  Grok         [未安装]  npx 拉取          [测试连接][编辑] │
│  ⬡  Cursor       [未安装]                    [测试连接][编辑] │
│  ▲  Codex        [不可用]  仅 app-server     [测试连接][编辑] │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**与 AionUi 的差异**：

| 项 | AionUi | 本插件 | 理由 |
| --- | --- | --- | --- |
| 分档 | 全部 / 可用 / 不可用 | 全部 / 可用 / **未安装** / 不可用 | 四态更准确（"没装"和"装了坏了"处理方式完全不同） |
| 行内计数 | MCP 数 · 技能数 | **ACP 能力徽章**（`MCP http/sse`、`session fork/delete`、`modes 数`） | 我们的能力差异体现在 ACP 能力，不在 MCP/技能数 |
| 右上 | 添加自定义 Agent | 添加自定义引擎 | 同 |

### 4.2 页面 B：引擎详情

```
┌─────────────────────────────────────────────────────────────┐
│  ← 返回   omp                              [测试连接]        │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ ✅ 已连接                                              │  │
│  │ 已成功建立连接。注意：「在线」只表示可连接，并不代表    │  │
│  │ 已登录或已授权。若该引擎需要 API 密钥或访问令牌，请在  │  │
│  │ 下方「环境变量」中补充。                              │  │
│  │                                                       │  │
│  │ 握手 579 ms · 协议 ACP v1 · 解析失败 0 行              │  │
│  │ agent: oh-my-pi 18.3.5                                │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  环境变量                                                    │
│  某些引擎需要 API 密钥或访问令牌才能运行。每行填一个变量。    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ ℹ 配置环境变量可以解决：                               │  │
│  │   • 缺少 API 密钥或访问令牌 —— 最常见原因              │  │
│  │   • 自定义 API 地址或网关                              │  │
│  │   • 网络代理设置                                       │  │
│  │ 注意：这无法替代 CLI 中的账号登录。OAuth 登录请在终端  │  │
│  │ 里通过该 CLI 完成。                                    │  │
│  └───────────────────────────────────────────────────────┘  │
│   DEEPSEEK_API_KEY   ●●●●●●●●●●●●●●●●●●     [👁] [🗑]        │
│   OPENCODE_API_KEY   ●●●●●●●●●●●●●●●●●●     [👁] [🗑]        │
│   ＋ 添加变量                                                │
│                                                             │
│  ┌─────────────────────── 保存并测试 ────────────────────┐  │
│                                                             │
│  启动方式                                                    │
│   command: omp      args: ["acp"]      cwdPolicy: session    │
│   [覆盖启动方式]  ← 对应 EngineSpec.resolvedCommand / args   │
│                                                             │
│  绑定此引擎的专家 (1)                                        │
│   📰  资讯主编                                     查看详情 › │
└─────────────────────────────────────────────────────────────┘
```

**新增于 AionUi 的两块**：

1. **握手诊断行** —— `握手 579 ms · 协议 ACP v1 · 解析失败 0 行 · agent: oh-my-pi 18.3.5`。
   依据：我们的 `tryConnect()` 已经返回这些（见 `lib/acp-host.js`），且 `AcpClient` 统计 `parseFailures` / `rawLineCount` —— **方言问题的第一现场证据**。
2. **启动方式（可覆盖）** —— 对应 AionCore 的 `/overrides` = `{ command_override, env_override }`。理由：内置 `commandOverrides.windows` 是本机路径，换机器会失效。

---

## 5. 技术实现路径

### 5.1 插件清单

```jsonc
// package.json
{
  "exports": {
    "./client": "./lib/client.js",     // ← 新增
    "./preset-marker": "./lib/preset-marker.js"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }    // ← 新增
  }
}
```

### 5.2 三层结构

```
lib/client.js          浏览器侧入口（__ModuleLoader__.load 包裹，需 esbuild 打包）
  └── 消费 ctx.webServer 暴露的 HTTP API
lib/routes.js          宿主侧 HTTP 路由（挂在 ctx.webServer）
  ├── GET  /multi-acp/engines           列表 + 三态 + 能力徽章
  ├── POST /multi-acp/engines/:id/test  试连
  ├── PUT  /multi-acp/engines/:id       env / overrides / enabled / sortOrder
  ├── POST /multi-acp/engines           新增自定义引擎
  └── GET  /multi-acp/engines/:id/bound-experts   反向索引
lib/engines.js         数据层（已有）+ 新增 PATH 探测
```

### 5.3 构建

`client.js` 是 esbuild 产物（`__ModuleLoader__.load({ id, factory })` 包裹，`require('react')`）。
**参考**：`experts-management` 的 `scripts/build-client.mjs`（npm 包里不带，需从仓库取）。

### 5.4 Slot 挂载点（待确认）

| 目标位置 | 候选 slot | 状态 |
| --- | --- | --- |
| 侧边栏加「引擎」入口 | `ui-sidebar` | ❓ 待查 `@deepseek-ai/dsh-client-ui-slots` |
| 设置页加分区 | `ui-settings` | ❓ |
| 插件页加菜单项 | `plugins.add.actions`（`ui-agent-preset` 用过） | ✅ 已有先例 |

> **待办**：稀疏检出 `packages/client/ui-slots` + `ui-settings`，列出可用 slot 与贡献 API。

---

## 6. 分期

| 阶段 | 内容 | 前置 |
| --- | --- | --- |
| **P1** | **零 UI** —— preset 自动出现在官方选择器 | 无（推荐先做） |
| **P2** | 引擎三态探测（无 UI，只打日志/诊断） | P1 运行时验证通过 |
| **P3-a** | 「引擎」列表页（只读 + 测试连接） | slot 确认 |
| **P3-b** | 引擎详情页（env 编辑 + 保存并测试） | P3-a |
| **P3-c** | 反向索引 + 添加自定义引擎 + 启停排序 | P3-b |
| **P4** | harness 感知的模型选择器（替代 `ui-model-selection`） | 📖 参照 grok 的 `lib/client.js` |

---

## 7. 明确的非目标

| 不做 | 理由 |
| --- | --- |
| 自己写 preset 选择器 | DSH 官方 `ui-agent-preset` 已覆盖 |
| 自己写"锁定提示" | 官方 UI 会把 Host 的拒绝原因 Toast 出来 |
| 在 UI 里编辑 preset 的 YAML | 官方明确"Web 不创建也不编辑 preset"；我们只做**引擎**管理，preset 由 `register()` 程序化创建 |
| 把 codex 列进引擎列表 | ✅ 实测它没有 `acp` 子命令 |

---

## 8. 待确认清单

1. `@deepseek-ai/dsh-client-ui-slots` 的可用 slot 与贡献 API（§5.4）
2. 客户端插件如何注册设置页/侧边栏入口（`experts-management` 是现成样例，需读它的 `client/index.js`）
3. `ctx.webServer` 的路由注册签名
4. esbuild 打包的 loader/外部依赖约定（`react`、`@deepseek-ai/cordis` 由宿主提供）
5. 「绑定此引擎的专家」的引用判据，取决于 experts-management PLUS 版最终字段名
