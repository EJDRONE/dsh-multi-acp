# 引擎不足清单（Issue Ledger）

> 生成方式：只读核对，不改动任何 preset / 代码。
> 每条结论都指向仓库内已有证据（探针 JSON 的字段、`lib/engines.js` 行号、`docs/ENGINE-SPEC.md §8.5`、`docs/ROADMAP.md`）。
> 证据等级沿用 DESIGN.md §0：✅实测 / 📖参考 / ❓未验证。
>
> 数据来源探针（`docs/evidence/`）：
> - omp：`probe-C_Users_29096_AppData_Local_omp_omp_exe-2026-10-07T08-01-43-410Z.json`
> - OpenCode（付费默认模型失败）：`probe-C_Users_29096_opencode_bin_opencode_exe-2026-10-07T07-58-20-593Z.json`
> - OpenCode（切免费模型成功）：`probe-C_Users_29096_opencode_bin_opencode_exe-2026-10-07T08-00-05-550Z.json`
> - Command Code：`probe-C_nvm4w_nodejs_commandcode_ps1-2026-10-07T07-58-52-106Z.json`

---

## 0. 能力矩阵（实测）

| 维度 | omp (oh-my-pi) | OpenCode | Command Code |
| --- | --- | --- | --- |
| 握手 latency | ✅ 579ms | ✅ 782ms | ✅ 3130ms（最慢） |
| prompt 往返 | ✅ 5200ms（最快） | ✅ 15836ms | ✅ 19258ms（最慢） |
| session 能力 | list·fork·resume·close | list·fork·resume·close·**delete**·**additionalDirectories** | list·resume·close（**无 fork/delete/addDir**） |
| MCP | ✅ http + **sse**（唯一） | http（无 sse） | http（无 sse） |
| prompt 输入 | image·embeddedContext | image·embeddedContext | image·embeddedContext |
| audio 输入 | ❌ 无 | ❌ 无 | ❌ audio:false |
| 启动方式 | 原生 exe | 原生 exe | ⚠️ `.ps1` 经 `pwsh -File` |
| 默认模型 | deepseek/deepseek-v4-pro | ⚠️ opencode/mistral-large-4（**付费**） | deepseek/deepseek-v4-flash |
| set_config_option | ❓ 未实测 | ✅ 已验证切模型 | ❓ 未实测（mode 路径） |

> 三家共同点：**均无 audio 输入**；**权限/fs 读写/工具流/取消 全链路均未在探针中触发**（见 ISSUE-04）。

---

## 🔴 High

### ISSUE-01 · OpenCode 开箱即坏：默认模型是付费模型
- **现象**：新建 OpenCode 会话直接发一句话即失败，报 `Internal error: Upstream request failed: Insufficient account funds`。
- **证据**：`probe-...opencode...07-58-20-593Z.json` → `prompt.ok=false`，`error="...Insufficient account funds"`；默认 `configOptions.model.currentValue=opencode/mistral-large-4`。换 `opencode/nemotron-3.5-lightning-free` 后（`...08-00-05-550Z.json`）`prompt.ok=true`。
- **影响**：用户选 OpenCode 预设后第一次对话就报错，且错误文案是计费口径、易被误判为"ACP 协议不通"。
- **修复方向（未执行）**：① 试连/首帧把"协议不通"与"余额不足"分流呈现（ENGINE-SPEC §8.4 已提出此要求）；② 或在引擎行里给 OpenCode 预置一个免费模型作为默认 configOption。

### ISSUE-02 · commandOverrides.windows 全是本机绝对路径，换机即失效
- **现象**：三家内置可执行体路径写死为本机用户目录。
- **证据**：`lib/engines.js:31` `C:\Users\29096\AppData\Local\omp\omp.exe`；`:51` `C:\Users\29096\.opencode\bin\opencode.exe`；`:71` `C:\nvm4w\nodejs\commandcode.ps1`。
- **影响**：装到别的机器上，除非用户手动 `PUT /multi-acp/engines/:id` 改 `resolvedCommand`，否则探测为 `not-installed`。B1 的四态探测能识别，但内置默认对他人无意义。
- **修复方向（未执行）**：内置行改为裸命令（`omp`/`opencode`/`commandcode`）交给 PATH 解析，本机绝对路径下沉到 `<stateDir>/engines.json` 用户层。

---

## 🟠 Medium

### ISSUE-03 · Command Code 启动方式最脆弱 + 非 Windows 语义错误
- **现象**：本体是 PowerShell shim，需 `pwsh -NoProfile -ExecutionPolicy Bypass -File` 拉起；且 `engines.js` 基础 `command` 写成了 `cmd`。
- **证据**：`lib/engines.js:70` `command:'cmd'`，`:71` windows override 指向 `.ps1`；`resolveSpawn`（`:98`）对 `.ps1` 走 `pwsh -File`。探针 `target.spawnVia="pwsh -File"`。
- **影响**：① 多一层进程、受执行策略/ pwsh 是否存在影响；② 在非 Windows 上 `command:'cmd' args:['acp']` 是无意义命令，全靠 windows override 兜底，一旦 override 不命中就彻底错。
- **修复方向（未执行）**：基础 `command` 改为 `commandcode`（真实 CLI 名），shim 逻辑只在检测到 `.ps1`/`.cmd` 时由 `resolveSpawn` 处理。

### ISSUE-04 · 权限 / fs 读写 / 工具流 / 取消 全链路未验证（A1/A2/A3）
- **现象**：三家探针都只跑了 trivial prompt，`clientCallbacks={}`，未触发任何回调。
- **证据**：全部 4 个 probe JSON → `clientCallbacks:{}`、`errors:[]`；`docs/ENGINE-SPEC.md §8.5` 明确 `session/request_permission`、`fs/read_text_file`/`write_text_file`、`tool_call`/`tool_call_update`/`plan`、`session/cancel` 均为 ❓未测；`docs/ROADMAP.md` A1/A2/A3 标为"已接线，待运行时验证"。
- **影响**：这是"能否真正当根 agent 用"的核心面。默认拒绝权限（`acp-client.js` `requestPermission` 无 handler 时返回 `cancelled`）会让引擎写文件静默失败——用户看不到报错，只看到引擎"没干活"。
- **修复方向（未执行）**：按 ROADMAP A2 优先做——让引擎执行一个必然触发权限/工具调用的任务，验证 DSH approval 弹窗与 `tool/call`·`tool/result` 落盘。

### ISSUE-05 · omp / Command Code 的 set_config_option（模型·mode·thinking 切换）未实测
- **现象**：omp 有 `model`/`thinking`/`mode` 三组 configOptions，Command Code 有 5 档 mode，但两者的切换路径从未验证；只有 OpenCode 验证过切模型生效。
- **证据**：`docs/ENGINE-SPEC.md §8.5` "Command Code / omp 的 `session/set_config_option` ❓未实测——仅 OpenCode 验证过切换生效"；omp 探针 `setConfig:[]`（空）。
- **影响**：卡片把"per-session 切模型/5 档权限 mode"当卖点，但除 OpenCode 外无法保证真的能切。
- **修复方向（未执行）**：对 omp、Command Code 各补一次 `set_config_option` 往返探针。

---

## 🟡 Low

### ISSUE-06 · OpenCode 尚未在 DSH 内跑过真实会话
- **现象**：OpenCode 只做过独立探针验证，DSH 端到端只用 omp + Command Code 验过。
- **证据**：`docs/ROADMAP.md` §C "尚未在 DSH 里跑过真实会话"。
- **影响**：结合 ISSUE-01，OpenCode 是"探针能通、DSH 内未验、默认还坏"的最不确定一家。
- **修复方向（未执行）**：ROADMAP C1–C3（选 OpenCode 预设发一句话 → 确认 `opencode.exe` 子进程 → 检查 `config_option_update` 轨迹）。

### ISSUE-07 · omp 缺 delete、Command Code 缺 fork/delete/additionalDirectories
- **现象**：三家 session 能力不对齐。
- **证据**：omp 探针 `sessionCapabilities={list,fork,resume,close}`（无 delete）；Command Code 探针 `{list,resume,close}`（无 fork/delete/addDir）；OpenCode `{...,delete,additionalDirectories}` 最全。
- **影响**：若上层功能依赖"删除 ACP 会话""额外目录喂入"，omp/Command Code 会缺位。当前插件主路径未用到这些，故列 Low。
- **修复方向（未执行）**：能力差异透传给 UI 做徽章，依赖这些能力的功能对不支持的引擎降级。

### ISSUE-08 · 卡片"新任务默认"徽章与 bundle 默认引擎来源不一致
- **现象**：GUI 里"新任务默认"徽章挂在 Command Code，但插件自带 patch 的 `defaultEngine` 是 `omp`。
- **证据**：`cordis.patch.yml:16` `defaultEngine: omp`；截图徽章在 Command Code 卡上。
- **影响**：说明运行实例的默认引擎被 `<stateDir>/engines.json` 或 profile 层 config 覆盖过。排查"为什么默认不是 omp"时，只看 bundle 默认值会得出错误结论。
- **修复方向（未执行）**：确认当前生效的 defaultEngine 来源（profile config / engines.json / 用户选择），文档里注明优先级。

### ISSUE-09 · `acp-*` preset 的组合是**空壳**（没有 DSH 原生工具）+ resume 静默回落原生 loop
- **现象（用户 2026-10-09 反馈）**：用本插件创建的 preset 开会话，"根本没挂 DSH 原生的
  shell / 文件系统工具"；会话里 `write{...} → FS_SANDBOX_DENIED`、`pwsh{...} → error`。
- **证据**：
  1. `session-144c11b2`（`agentPreset=acp-commandcode`）的 `request/header` 只有 **164** 个工具，
     全是部署层插件工具；模型自己探到 `unknown tool "write"` / `unknown tool "read"` / `unknown tool "bash"`。
  2. `<stateDir>/trace.log`（2026-10-09）里**每一次** `factory.resume` 都是
     `presetId:null → fallback-native` —— `ResumeAgentOptions` 类型里根本没有 `agentPreset`
     （只有 `resumeSessionId`），所以重开会话必然回落；而官方 loop 会按持久化的 `acp-*`
     preset 挂载一个**只有 marker 行**的组合 ⇒ 既没引擎、又没工具。
  3. 用户报的两条错误本身来自 `agentPreset=standard` 的会话：`FS_SANDBOX_DENIED` 是
     `dsh-fs-sandbox` 在 workspace-write 下拒绝写工作区外路径（按设计）；
     `pwsh` 的 `SetNamedSecurityInfoW failed (Win32 5)` 是宿主 `dsh-sandbox-windows-acl` 缺陷。
- **影响**：致命 —— 这类会话完全无法读写文件、无法执行命令，用户第一反应就是"引擎不可用"。
- **处置（v0.1.15，已修）**：`lib/preset-native.js` 按官方 `standard` preset 的工具行补齐组合；
  `MultiAcpFactory._presetIdOf()` 在 resume 路径回落查 `session-map.json` 的 `engineId`。
  证据与验收见 `docs/evidence/A10-preset-tools-mcp-2026-10-09.md`。

### ISSUE-10 · MCP servers 没有随会话下发（`ACP-INTEGRATION §4.1` 缺口）
- **现象**：引擎会话里只有引擎自带工具，DSH 里配好的 MCP（weknora / chrome-devtools /
  drawio / dingtalk）一个都不在。
- **证据**：`acp-host.openSession({ mcpServers })` 参数一直存在，但**没有任何调用方传值**
  （`grep -n mcpServers lib/` 只命中签名与解构）。
- **影响**：跨端的工具/数据面断层；用户在 DSH 侧配置的 MCP 需要到每个引擎里重配一遍。
- **处置（v0.1.15，已修）**：新增 `lib/mcp-servers.js`，从
  `<DSH_HOME>/storages/mcp_connector.json` 读取并映射为 ACP `McpServer`，
  `session/new` 与 `session/load` 双通道下发；可用 `mcp.include/exclude` 与
  `engine.mcp`（`inherit` | `none` | 自定义数组）收窄。**引擎侧接受性待实测**（见 A10 §6）。

### ISSUE-11 · 替身 agent 的 scoped ctx 缺服务 → **宿主崩溃**
- **现象**：用户未做任何操作，DSH 直接弹崩溃框（`crash-2026-10-09T07-15-29-089Z-host.log`、
  `crash-2026-10-09T07-16-41-114Z-host.log`）。
- **证据**：同一栈 `dsh: fatal load failure: Error: cannot get property "systemPrompt" without inject`
  at `dsh-experimental-tool-agent-team/lib/index.js:237 (install)` ← `maybeInstall:541` ← `:545`。
- **根因**：`dsh-scope#createScope(ctx, key)` 的 scoped ctx **继承"铸造它的插件"的依赖 API**；
  本插件 inject 里没有 `systemPrompt`（官方 AgentLoop 有），于是别人访问 `agent.ctx.systemPrompt` 抛错，
  而异常发生在**插件装载路径**上 → 宿主进程退出。
- **影响**：致命（宿主崩溃 + 会话卡死 + 用户被迫重启）。
- **处置（v0.1.15，已修）**：`inject` 与官方 AgentLoop 对齐
  `['agents','agentPresets','sessions','commands','tools','systemPrompt','llm']`。
  15:18 重启后无新崩溃，且早先卡死的会话复活（见 `evidence/A10-*.md §7.2`）。

### ISSUE-12 · ACP 回显写坏会话日志（历史加载失败）— ✅ 已修 + 历史已修
- **现象**：DSH 打开 ACP 会话报「历史加载失败」，逐轮暴露 6 条格式契约：
  ① `tool/call … has no advertised tool lifecycle`（缺 `assistant/message` 工具广告块）
  ② `first frame is not exactly one header line`（修复脚本帧布局错）
  ③ `released v2 row 0 has seq gap (expected 0, got 1)`（seq 起点错）
  ④ `format v4 message requires a producer-owned source kind`（`source.kind` 缺失）
  ⑤ `session event at seq N lacks an identified message`（`message.id` 缺失）
  ⑥ `step/end leaves unresolved tool call …`（超时导致悬空调用）
- **根因**：我们做的是"替身 factory"，往会话日志写事件必须满足 DSH 的格式契约，而不只是字段名对。
  前两条是插件回显缺项（①⑥），其余是我第一版**历史修复脚本**自己踩的读取器/校验器契约。
- **处置（v0.1.16，已修）**：插件侧把 `tool/call` 原样塞进 `assistant/message` 的 `tool-call` 块
  （A11-3）、并在 `step/end` 前补齐悬空调用的错误结果（A12）；
  历史文件用 `tmp\repair-orphan-toolcalls.mjs`（6 契约全绿）+ `tmp\scan-orphan-toolcalls.mjs` 修完。
  4 个受影响会话用户已确认可加载。

---

## 处置建议（优先级排序）
1. **ISSUE-01 / ISSUE-04** —— 一个是"选了就坏"、一个是"核心能力没验"，最先处理。
2. **ISSUE-02 / ISSUE-03** —— 可移植性与启动正确性，影响他人使用与跨平台。
3. **ISSUE-05 / ISSUE-06** —— 补齐验证，兑现卡片卖点。
4. **ISSUE-07 / ISSUE-08** —— 记录与降级策略，非阻塞。

---

## 处置状态（2026-10-08 · v0.1.13）

| # | 状态 | 处置 |
| --- | --- | --- |
| ISSUE-01 | ✅ **已修（a+b）** | (a) 失败归一成稳定机器码写入 `turn/end.reason.error.code`；(b) 新增引擎字段 `initialConfigOptions`，**内置 OpenCode 预置免费模型 `opencode/nemotron-3.5-lightning-free`**，会话开好即自动切换（失败仅告警、可在 `engines.json` 覆盖）。探针实证：默认模型必败、免费模型 cost=0 |
| ISSUE-02 | ✅ **已修** | 内置改为**裸命令 + `fallbackPaths`（env 模板）**，删除写死的本机绝对路径。探测顺序：`resolvedCommand` → `commandOverrides` → `fallbackPaths` → **PATH**；`resolveSpawn` 优先用探测到的绝对路径 |
| ISSUE-03 | ✅ **已修** | `command` 由 `cmd` 改为真实 CLI 名 `commandcode`；`.cmd`/`.ps1` shim 由 `resolveSpawn` 按探测到的后缀处理 |
| ISSUE-04 | 🟢 **部分修复** | 权限已接线（A2）；**如实声明 `fs:false`**（此前谎报 `true` 却空实现）；工具/取消已接线（A1/A3）。**端到端仍待运行时验证** |
| ISSUE-05 | ✅ **已实测** | 探针（2026-10-08）证明 omp 与 Command Code 的 `set_config_option` 均成功（agent 回 `config_option_update`） |
| ISSUE-06 | 🟢 **部分** | 独立探针复验 OpenCode 通过（含免费模型 cost=0）；**DSH 内**真实会话仍待做（需 DSH Web UI，内置浏览器未挂载） |
| ISSUE-07 | ✅ **已做（透传）** | 试连成功后缓存能力快照；`GET /engines` 各引擎行带 `capabilities`；客户端渲染徽章 |
| ISSUE-08 | ✅ **已澄清** | `GET /engines` 返回**生效 `defaultEngine`** + 来源说明（插件 config；空串 = 官方 DSH loop），客户端显示「默认引擎」行 |

> 本轮（v0.1.13）落地 ISSUE-02/03、01(a)、04（fs 声明）、07（透传）、08；
> 01(b)/05/06 属**运行时验证或选型**，清单保留。另加客户端 `apply` 的 try/catch 韧性（v0.1.12 教训）。

---

## 处置状态（2026-10-09 · v0.1.15）

| # | 状态 | 处置 |
| --- | --- | --- |
| ISSUE-09 | ✅ **已修** | (a) `lib/preset-native.js`：`acp-*` preset 组合补齐 DSH 原生工具行（skill-filesystem + tool-skill / tool-pwsh\|tool-bash / tool-fs + tool-fs-search / tool-jobs / tool-todo / tool-ask-user / tool-web），marker 仍在最后；(b) resume 路径回落 `session-map.json` 的 `engineId`，不再静默跑原生 loop；(c) 可选 `unsandboxedFs`（entry-local `dsh-fs-local`，消费侧同组）与 `presetTools` 分组裁剪。静态验收 21/21 |
| ISSUE-10 | ✅ **已修 + 已闭环** | `lib/mcp-servers.js`：DSH MCP 存储 → ACP `McpServer` 映射（env/headers 对象→数组、bearer→`Authorization`），`session/new` + `session/load` 下发；`mcp.include/exclude`、`engine.mcp` 收窄。**闭环实证**（2026-10-09 16:34 / `acp-omp`）：`session.mcp{count:4}` → omp 侧生成 `0.mcp__weknora_dc328ba5_search_knowledge.log` → DSH 轨迹里 10/10 调用成功并返回真实知识库数据；omp 自身配置无 weknora ⇒ 来源只能是注入。详见 `evidence/A10-*.md §9` |
| ISSUE-04 | 🟢 **部分修复（维持）** | 工具流回显这一块补了 **C1**：`available_commands_update`（引擎上报的命令/skill）此前被丢进 unknown update，现落进 `lib/engine-runtime.js` + UI 诊断行 + `GET /:id/commands`；原生侧技能目录随 preset 一起可用 |
| ISSUE-06 | 🔴 **仍未闭环** | 本轮定位到"DSH 内会话其实没跑到引擎"的机制（resume `presetId:null`）并修了回退路径，但**新建会话是否 100% 路由**与**引擎侧是否接受 MCP** 都需要一次真跑。判定方法见 `docs/evidence/A10-*.md` §6「仍未验证」 |
| ISSUE-07 | ✅ 已做（维持） | —— |
| ISSUE-08 | ✅ 已澄清（维持） | —— |

> 本轮（v0.1.15）同时完成 B4 UI：可编辑启动方式（command/args/cwdPolicy）、
> 环境变量行编辑（👁/🗑/＋，删除走 `KEY: null`）、四态过滤桶 + 搜索 + 握手诊断行。
> 行为验收 `tmp/verify-ui.mjs` 38/38。
