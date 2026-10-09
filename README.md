# dsh_multi_acp

> 让 **DSH 的一个会话由外部 ACP agent CLI 作为根 agent 驱动**（路线 B · 真·换引擎）。
> 设计核心：**引擎是数据行，不是代码** —— 新增一个引擎 = 加一行配置。

- **目标宿主**：DSH Desktop 0.2.0-rc.2（`DSH_HOME = D:\Ecode\.dsh`，profile = `desktop`）
- **当前版本**：**0.1.16**（2026-10-09）
- **状态**：🟢 **端到端跑通，并已在 DSH 内完成真实会话验证**（引擎路由 / preset 工具面 / MCP 注入 / 工具回显 / 引擎命令回显 / 引擎管理 UI）
- **文档**：[设计](./docs/DESIGN.md) · [引擎规格](./docs/ENGINE-SPEC.md) · [验证方案](./docs/VERIFICATION.md) · [UI 设计](./docs/UI-DESIGN.md) · [ACP 集成](./docs/ACP-INTEGRATION.md) · [问题清单](./docs/ISSUES.md) · [路线图](./docs/ROADMAP.md) · [证据](./docs/evidence/) · [变更日志](./CHANGELOG.md)

---

## 这是什么 / 不是什么

| | |
| --- | --- |
| ✅ 是 | DSH 当 **ACP 客户端**，驱动外部 CLI（omp / opencode / command-code）当根 agent |
| ✅ 是 | 把 DSH 的 **MCP 服务器随 `session/new` 下发给引擎**（引擎因此能用 DSH 里配好的知识库等） |
| ❌ 不是 | DSH 当 **ACP 服务端**。DSH 内置的 `@deepseek-ai/dsh-acp` 是**反方向**（把 DSH 变成别人的 agent），本插件不复用它 |
| ❌ 不是 | provider 路线（外部 CLI 只当"大脑"，loop 仍属 DSH） |
| ❌ 不是 | 子代理路线（官方 `@deepseek-ai/dsh-subagent-acp`） |

---

## 完成度（全部有实测证据）

| 能力 | 落地位置 | 实测证据 |
| --- | --- | --- |
| 引擎数据层 | `lib/engines.js` | 三个引擎的 `command`/`args` 本机实测（[ENGINE-SPEC §8](./docs/ENGINE-SPEC.md)） |
| ACP 客户端 / 进程宿主 | `lib/acp-client.js`、`lib/acp-host.js` | `probe/probe-acp.mjs`、`tmp/probe-mcp-engine.mjs` 用**同一套生产代码**跑通三家完整往返 |
| 插件接线（替换 factory + 注册 preset） | `lib/index.js` → `lib/index.impl.js` | `trace.log`：`install.factory-installed` + 三个 `preset.register` |
| **会话真由引擎驱动** | `lib/acp-agent.js` | `factory.createAgent {engineId:'omp'}` → 引擎自带工具在轨迹里回显；`factory.resume.engine-from-map` |
| **preset 原生工具面** | `lib/preset-native.js` | 会话 `request/header` 出现 `read/write/edit/glob/grep/pwsh/skill`（修复前是 164 个工具、零原生工具） |
| **MCP 随会话注入** | `lib/mcp-servers.js` | `session.mcp {count:4}`；omp 侧 `0.mcp__weknora_dc328ba5_*.log`；Command Code 探针实调 `mcp__weknora-dc328ba5__list_knowledge_bases` 并返回真实知识库名 |
| **引擎工具调用回显（A1）** | `lib/acp-agent.js` | 轨迹里 `tool/call` + `tool/result`（含 `assistant/message` 广告块，满足 DSH 会话格式契约） |
| **引擎命令/技能发现回显（C1）** | `lib/engine-runtime.js` | `acp.available_commands {engineId:'omp', total:166}`；`GET /multi-acp/engines/:id/commands` |
| 引擎管理 UI | `lib/client.js`、`lib/routes.js` | B4：覆盖启动方式 / 环境变量行编辑 / 四态过滤+搜索 / 握手诊断行（`tmp/verify-ui.mjs` 38/38） |
| 时长与超时可控 | `lib/acp-client.js` | `promptTimeoutMs`（插件级 + 引擎级，`<=0` = 不超时）+ 超时打印"引擎最后一次 update" |
| 历史文件修复工具 | `tmp/repair-orphan-toolcalls.mjs` | 6 条会话日志契约全绿（见 [VERIFICATION](./docs/VERIFICATION.md) §13） |

> 复盘与踩坑全记录：[`docs/evidence/A10-preset-tools-mcp-2026-10-09.md`](./docs/evidence/A10-preset-tools-mcp-2026-10-09.md)（preset 工具面 / resume 回落 / MCP 闭环 / 会话日志 6 条契约）。

---

## 目录结构

```
dsh_multi_acp/
├── package.json           插件清单（dsh.bundle.patch 指向 cordis.patch.yml）
├── cordis.patch.yml       本插件自带的 bundle patch（⚠️ 不是 profile 那份），含全部配置项与注释
├── lib/
│   ├── index.js           插件入口（诊断加载器）→ 转发到 index.impl.js
│   ├── index.impl.js      ⭐ 真正实现：替换 agents.factory + register preset + 配置归一化
│   ├── engines.js         ⭐ 引擎注册表（数据行）+ 探测/描述 —— 新增引擎改这里
│   ├── preset-native.js   ⭐ acp-* preset 的原生工具组合（抄官方 standard preset 的行）
│   ├── mcp-servers.js     ⭐ DSH MCP 存储 → ACP McpServer 映射与过滤
│   ├── engine-runtime.js  引擎运行时观测（命令/技能上报、MCP 下发摘要 → UI 诊断行）
│   ├── acp-agent.js       ⭐ 工厂 + Agent 组装 + 事件桥接（A1/A2/A6/A12）
│   ├── acp-client.js      ACP 客户端（官方 SDK）+ 超时预算
│   ├── acp-host.js        每引擎一个共享进程宿主 + 试连
│   ├── routes.js          `/multi-acp/*` 宿主路由（引擎 CRUD/试连/命令）
│   ├── client.js          浏览器侧设置面板（手写 bundle，无需 esbuild）
│   ├── session-map.js     dshSessionId ↔ acpSessionId 映射（resume 路由用）
│   ├── preset-ids.js      preset id 生成/解析（acp-<engineId>）
│   ├── preset-marker.js   每个 preset 的 marker 行（标识 engineId）
│   ├── dsh-imports.js     宿主包解析 / 服务解包 / 符号自检
│   └── index.full.js      （历史备份，**不是入口**，勿用）
├── probe/                 可复用 ACP 探针（`probe-acp.mjs` 等）
├── tools/                 安装与重启脚本（见「运维」）
├── tmp/                   验证/诊断脚本与临时产物
└── docs/                  设计 / 引擎规格 / UI / ACP 集成 / 验证 / 问题 / 路线图 / 证据
```

---

## 配置

`cordis.patch.yml` 的 `config`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `defaultEngine` | `''`（**本仓库自带的 patch 里设为 `omp`**） | 没有显式 preset 的会话走哪个引擎；留空 = 走官方 DSH agent loop |
| `stateDir` | `<DSH_HOME>/multi-acp`（patch 里用 `!!js` 展开 `DSH_HOME`/`USERPROFILE`） | 引擎定义、会话映射、`trace.log` |
| `engines` | `[]` | 引擎定义（最高优先级，便于试验） |
| `verboseStartup` | `true` | 启动时打印宿主符号自检结果 |
| `presetTools` | `true` | `acp-*` preset 挂哪些原生工具组：`true` / `false` / `['skills','shell','fs',…]` |
| `unsandboxedFs` | `false` | `true` = 用 entry-local `dsh-fs-local` 遮蔽宿主沙箱 fs（写工作区外不再被拒） |
| `mcp` | `{enabled:true, include:[], exclude:[]}` | MCP 随会话下发策略（见下） |
| `promptTimeoutMs` | `300000` | 一次 `session/prompt` 的超时；**`<=0` = 不超时**（长任务推荐） |

**引擎来源优先级**（`lib/engines.js`）：内置 `BUILTIN` → `<stateDir>/engines.json` → 插件 `config.engines`。
按 `id` 整体覆盖（不做深合并，避免半覆盖导致意外）。引擎行还可单独设 `mcp`（`'inherit'`/`'none'`/自定义数组）
与 `promptTimeoutMs`（优先于插件级）。

### MCP 随会话下发

默认把 `<DSH_HOME>/storages/mcp_connector.json` 里 `enabled !== false` 的连接映射成 ACP `McpServer`
（stdio → `{name, command, args, env[]}`；http/sse → `{type, name, url, headers[]}`，bearer → `Authorization` 头），
随 `session/new` **与** `session/load` 下发。收窄方式：

```yaml
mcp:
  enabled: true
  include: []              # 只下发这些（按 name / serverName / serverKey 匹配）
  exclude: ['dingtalk']    # 排除这些
```

⚠️ 治理边界：ACP 没有审批/授权字段，注入给引擎的 MCP 是**全量可用**的；DSH 的 `tools.governance`
不随之生效。键名以 [ISSUES/ACP-INTEGRATION](./docs/ACP-INTEGRATION.md) §4.1 记录为准。

### 新增一个引擎

```jsonc
// <DSH_HOME>/multi-acp/engines.json
{
  "engines": [
    {
      "id": "mytool",
      "label": { "zh": "我的工具", "en": "My Tool" },
      "command": "mytool",
      "args": ["acp"],
      "cwdPolicy": "session",     // session | fixed
      "mcp": "inherit",           // inherit | none | [自定义服务器]
      "promptTimeoutMs": 0,       // 可选：该引擎不超时
      "enabled": true,
      "sortOrder": 40
    }
  ]
}
```

要求：该 CLI 必须能说 **ACP over stdio**。先用探针验证，再验证 MCP 接受性：

```powershell
cd probe; node probe-acp.mjs "mytool" acp                       # 基础往返
node ..\tmp\probe-mcp-engine.mjs mytool                          # 带 4 个 mcpServers 起会话
```

⚠️ Windows 上若是 `.cmd`/`.ps1` shim（如 `commandcode.cmd`），探针要显式给入口：

```powershell
node tmp\probe-mcp-engine.mjs commandcode --command "C:\nvm4w\nodejs\commandcode.cmd" --args "acp" --init-secs 120
```

---

## 运维：改完代码必须"发布"（否则跑的还是旧插件）

profile 用 pnpm 的 `file:` 依赖装本仓库，安装副本是**硬链接树**：

- 用 **Edit** 改已有文件 = 原地写 → 硬链接自动同步；
- 用 **Write** 建新文件 / 重写整文件 = 换 inode → **硬链接断裂**，安装副本里没有该文件或仍是旧内容。

```powershell
pwsh -File tools\install.ps1 -Sync     # pnpm install：重新硬链接 + 校验（无配置改动）
pwsh -File tools\restart-and-capture.ps1 -WaitSeconds 30   # 重启 DSH（沿用原参数，抓启动日志）
pwsh -File tmp\verify-install.ps1      # 逐文件 SHA256 对比 repo ↔ 安装副本
```

**判据**：插件页版本号 = `package.json` 的版本；`<stateDir>/trace.log` 出现
`preset.register`（含 `nativeToolRows`）+ `install.factory-installed`。
进程名是 `DeepSeek Harness.exe`（`Get-Process dsh/electron` 找不到它）。
需要 CDP 调试时：`pwsh -File tmp\restart-debug.ps1`（加 `--remote-debugging-port=9223`）。

---

## 验证脚本（零依赖，改完随手跑）

| 脚本 | 覆盖 |
| --- | --- |
| `tmp\verify-preset-mcp.mjs` | preset 原生工具组合（逐条对照官方 preset 的模块名）+ MCP 映射/别名/短路（21 项） |
| `tmp\verify-ui.mjs` | B4 UI 行为（自带 mini-React，真点真改真保存，断言 PUT body）（38 项） |
| `tmp\verify-toolname-timeout.mjs` | 工具名解析（含"title 就是工具名"反例）+ 超时语义（22 项） |
| `tmp\probe-mcp-engine.mjs` | 直连某引擎：是否接受 `mcpServers` + 是否真的调用了注入的 MCP 工具 |
| `tmp\scan-orphan-toolcalls.mjs` / `tmp\repair-orphan-toolcalls.mjs` | 扫描/修复"未广告 tool/call"等会话日志损坏（6 条契约，自动备份） |
| `tmp\reframe-all.ps1` | 对 4 个曾损坏的会话做 6 契约自检 |
| `tmp\check-running.ps1`、`tmp\trace-window.mjs`、`tmp\ztools.mjs` | 进程/插件加载判据、trace 时间窗、单会话结构分析 |

`node --check lib\*.js` + 上表即为本地验收；**必须真跑**的项目（引擎路由、MCP 是否被接受、skill 发现）
的判定手段见 [VERIFICATION.md §13](./docs/VERIFICATION.md)。

---

## Skills 能"透传"给 ACP 引擎吗

**协议层：不能。** ACP 的 `session/new` 只有 `cwd` / `mcpServers`（没有 skills 字段），`available_commands_update` 是引擎→客户端的单向上报。

**实际层：可以，靠磁盘数据而非协议（路径 D），且本机已验证在 ACP 会话里生效。v0.1.17 起可在
【引擎管理 → 编辑 → **SKILLS 目录**】里配置**（投递方式 + 目录列表，带「已找到 N 个 skill」状态）：

| 引擎 | ACP 会话下能否用 DSH 的 skills | 配方（已验证） |
| --- | --- | --- |
| **omp** | ✅ 零配置：能列出全部 119 个（= `~/\.agents/skills`），并能 `skill://agent-reach` 载入真实正文 | `skillDelivery: auto`（内置默认） |
| **Command Code** | ✅ 需显式挂载：`activate_skill{"name":"agent-reach"}` 成功 | `skillDelivery: args` + `skillsDirs: ['~/.agents/skills']`（**内置默认已是这个**，UI 里可直接改） |
| **OpenCode** | ✅ 官方明认 `~/.agents/skills`（本机账号余额为 0，模型回合没跑成） | `skillDelivery: auto`（内置默认） |

UI 里可改的三项（落在 `<stateDir>/engines.json`）：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `skillDelivery` | `auto` / `args` / `none` | 引擎自扫 / 启动时追加参数 / 不下发 |
| `skillsDirs` | 目录数组（支持 `~`、`%VAR%`、`${VAR}`） | 空 = `~/.agents/skills` |
| `skillArgsTemplate` | 默认 `['--skill', '{dir}']` | `args` 模式的参数写法（换 CLI 时改这里） |

引擎行上会显示 `SKILLS: args · --skill 挂载 1/1 个目录（119 个 skill）· 追加参数: --skill C:\...\.agents\skills`。

```powershell
# 复跑（直连引擎，不动 DSH）
node tmp\probe-mcp-engine.mjs omp --prompt "加载 agent-reach skill 并引用它的描述"
node tmp\probe-mcp-engine.mjs commandcode --command "C:\nvm4w\nodejs\commandcode.cmd" `
     --args "acp --skill C:\Users\29096\.agents\skills" --init-secs 120
```

> 对照：**工具（实现类）不能这样共享** —— `web_search` 之类的运行时实现没有磁盘约定，只能重新包成
> **MCP server** 走 `mcpServers` 透传（本插件已落地该通道）。详见 [ACP-INTEGRATION §5/§6](./docs/ACP-INTEGRATION.md)。

---

## 已知限制 / 不是本插件的问题

| 项 | 说明 |
| --- | --- |
| OpenCode 真实模型回合 | 本机 opencode 账号余额为 0 → prompt 阶段报 `Insufficient account funds`。**`session/new` 带 `mcpServers` 已被接受**（sessionId `ses_…`），连上与否待有余额时复跑 `tmp\probe-mcp-engine.mjs opencode` |
| 导出 session.log → HTTP 500 | **DSH 自带导出功能的问题**：对**当前 live（打开着）的会话**导出失败，`standard` 预设同样复现；`@deepseek-ai/dsh-session-log-export` 的 `flushLiveSessionLog → sessions.flush` 抛错。**规避**：先切走/关掉会话再导出 |
| `pwsh → error`（`SetNamedSecurityInfoW failed (Win32 5)`） | 宿主 `dsh-sandbox-windows-acl` 给工作目录授 ACL 失败，与 preset/引擎无关 |
| `FS_SANDBOX_DENIED` | 宿主 `dsh-fs-sandbox` 在 workspace-write 下按设计拒绝写工作区外路径；需要时开 `unsandboxedFs` |
| 会话日志格式契约 | 任何往会话里写事件的"回显"（含手工修历史文件）都必须满足 6 条契约，见 [VERIFICATION §13](./docs/VERIFICATION.md) |

### 本机引擎环境事实（2026-10-07 探针 + 2026-10-09 复测）

| 引擎 | 版本 | 可执行体 | 握手 | 往返 | MCP 注入 |
| --- | --- | --- | --- | --- | --- |
| **omp** (oh-my-pi) | 18.3.5 | 原生 exe | 579 ms | 5.2 s | ✅ 接受 + ✅ 已证连上 |
| **Qoder CLI CN** | 1.1.65 | `qoder-cn` shim → `qoderclicn.exe`（**`--acp` 开关**） | 924 ms | — | ✅ 接受 + ✅ 已证连上（5/5，实调两套 weknora） |
| **OpenCode** | 2.0.23 | 原生 exe | 782 ms | 15.8 s | ✅ 接受；连上待余额 |
| **Command Code** | 1.76.0 | `.cmd` → `cmd /c`（亦可 `.ps1` 经 `pwsh -File`） | 3130 ms | 19.3 s | ✅ 接受 + ✅ 已证连上 |
| codex | — | ❌ 无 `acp`（仅 `app-server`） | — | — | 不在本插件范围 |

⚠️ 内置 `commandOverrides.windows` 是本机路径，换机器需覆盖。
