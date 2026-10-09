# CHANGELOG

## 0.1.25 — 2026-10-10 🟢 **A17：长任务终于"看得见"了 —— 工具事件增量落盘 + 助手文本流式**

- **现象（用户提问"omp 跑的过程中完全不给 DSH 反馈吗？"→ 实测确认）**：
  引擎**一直在发** `session/update`（`trace.log` 里 `acp.tool-call` 连续出现），
  但**会话日志直到 turn 结束才一次性落盘** —— `session-503ea973` 里 21 个 `tool/call`
  的时间戳全是 `+300s`（我们掐断那一刻），那 4 分钟 UI 完全没反馈，看起来像死机。
- **修复①：工具事件增量落盘**（`_onToolCallUpdate`）—— `tool/call` 首现即 flush、
  终态 `tool/result` 一到即 flush（广告块由 A14 在 flush 内先写；悬空调用仍由 A12 在 `step/end` 前收尾）。
- **修复②：助手文本流式**（`_maybeFlushAssistantDelta`）—— 只写**增量**（`_streamedTextLen` 去重），
  按 **≥1200ms 或 ≥400 字符**节流，写 `assistant/message`（`surfaceOp: 'append'`）。
  长回合会呈现为若干段连续消息；`trace('acp.live-flush.text')` 记录每次落盘量。
- **已知增量改进**（本轮不做，已在代码注释与 CHANGELOG 记录）：把"同一条消息原地增长"做成
  `surfaceOp: {op:'replace', start, end}` + `sourceEventSeqs`。需要 `session.append()` 回传 seq，
  且**类型里的 `start/end`（`dsh-session` types.d.ts:393）与实测日志里的 `startSeq/endSeq` 命名不一致**
  （原生会话实测样例：`{"op":"replace","startSeq":10,"endSeq":10}` + `sourceEventSeqs:[10]`），
  必须先在真机上验证清楚再用，否则会把会话日志写成非法格式。
- 验收：新增 `tmp/verify-live-flush.mjs` **12/12**（首现即 flush / in_progress 不重复 flush /
  终态即 flush / ≥400 字符立即写 / 节流生效 / 间隔到只写增量 / force 收尾 / 不写空消息 / 非 turn 不落盘）。

---

## 0.1.24 — 2026-10-10 🟢 **A16：prompt 超时改成"双闸"（空闲闸为主，总时长闸默认不限）**

- **现象**（用户反馈 + 我拆日志确认）：`本轮运行失败 acp[omp]: session/prompt: timed out after 300s
  (last engine update 0s ago: agent_thought_chunk " pinned")`。
  `session-503ea973`（定时任务跑 omp 的新闻采集）：引擎**已成功完成 21 次工具调用**
  （execute 13 / read 6 / fetch 2），仍在持续吐 `agent_thought_chunk` 时，被我们的**墙钟 300s** 掐断 ——
  错误里那句 "last engine update **0s** ago" 就是"它正在干活"的铁证。
- **修复**：把单一墙钟闸拆成两个（`lib/prompt-timeout.js`，纯函数、可单测）：
  | 闸 | 字段 | 默认 | 作用 |
  | --- | --- | --- | --- |
  | **空闲闸（主）** | `idleTimeoutMs` | **180000** | 多久**没有任何 `session/update`** 才算卡死 → 长任务不再被误杀 |
  | 总时长闸 | `promptTimeoutMs` | **0（不限）** | 仍可显式设上限，防极端情况 |
  任一触发都带上"最后一次引擎 update"的摘要（A11-2 的诊断保留）。
- **实现**：agent 侧 `_promptOnce` 用 `setInterval` 看门狗 + `Promise.race`（它才知道
  `_lastUpdate` 是什么时候）；客户端侧只负责总时长闸。引擎行可单独覆盖两个字段
  （`engines.json` / PUT），插件配置同名项作为默认值注入。
- **UI**：编辑面板新增 **「超时」** 行 —— `空闲(ms)` / `总时长(ms)` 两个输入框
  （占位符显示插件默认值，留空 = 不改，填 `0` = 关闭该闸）。
- 验收：`tmp/verify-toolname-timeout.mjs` **31/31**（+9 条双闸断言，含**事故复现**：
  "持续有 update 的长任务在默认配置下不会被掐断"）、`tmp/verify-ui.mjs` **73/73**
  （+2：两个超时输入框存在并在 PUT body 中下发）。

---

## 0.1.23 — 2026-10-10 🟢 **A15：会话权限档 → 引擎权限档的自动映射（"完全权限 ⇒ 引擎免问"）**

- **背景**：DSH 的档位（【完全权限】/【工作区内修改】/【仅可查看】）写的是 `sandbox/mode` +
  `approval/policy`，**只管 DSH 自己的工具**；ACP 会话里引擎的工具只能通过
  `session/request_permission` 让 DSH 参与，而请求里的"工具"是引擎给的整条命令行，
  DSH 的策略引擎认不出 ⇒ 只能"问人" ⇒ 无人值守时一律被拒（实测切【完全权限】后仍 6/6 rejected）。
- **接通**：新增 `lib/permission-bridge.js`
  - `readSessionPermissions(projections, session)` —— 读 DSH 的 `permissions` 会话投影
    （`dsh-permission-presets` 的 `{preset, sandbox, approval}`）；
  - `mapPresetToMode()` —— 映射表：**完全权限 ⇒ `dont_ask`**；工作区内修改 / 仅可查看 ⇒ 不改动引擎，
    但分别给出"无人值守会被拒"/"ACP 没有只读引擎语义"的**明确告警**；未知档 ⇒ 不介入；
    引擎没声明该档模板 ⇒ 不改动 + 告警（**不假装放开**）；
  - `applyPermissionMode()` —— 产出会话专用引擎变体，带 **`poolKey = id#mode`**
    （`acp-host.js#get` 改用它池化：免问 / 询问不能共用一个进程），`id` 保持不变
    （preset / session-map / 事件 source 都依赖它）。
- **接线**：工厂新增 `this.projections`（读投影）与 `this.permissionModeFromSession`（插件配置，
  默认 `true`）；`createAcpAgent()` 在 `pool.get()` **之前**完成映射，并 `trace('session.permission')`
  记录 `preset/sandbox/approval/mapped/poolKey`。
- **UI**：权限模式下拉下新增说明（"会话档位为【完全权限】时本引擎自动以不询问档启动"）。
- 配置：`cordis.patch.yml` 新增 `permissionModeFromSession: true`。
- 验收：新增 `tmp/verify-permission-bridge.mjs` **17/17**（映射表 / 引擎不支持时的告警 /
  `poolKey` 与 `id` 语义 / 投影读取三种异常 / 开关关闭 / `resolveSpawn` 真的带上权限参数）。

---

## 0.1.22 — 2026-10-10 🟢 **引擎级 `permissionMode` 开关（治"全通道被拒"）**

- **现场诊断**（`session-8a6cb2e1`，定时任务跑的 `acp-qodercn` 会话）：
  `approval/asked=11 / decided=11`，**11 次全部 `rejected`**；对应的 `tool/result` 是引擎自己的
  「The user doesn't want to proceed with this tool use…」⇒ `curl` / `Invoke-WebRequest` / `node fetch` /
  `chrome-devtools` / `web_search` / **连 `Edit 写文件`** 全部被拒，看起来像"网络+写盘都被沙箱挡了"。
  真相：这些是**引擎自己的工具**，每个都先发 ACP `session/request_permission`
  → 我们桥（A2）转给 DSH 审批 → **无人值守任务没人点批准**（且 `policy:"never"` 的兜底是 **fail-closed 拒绝**）
  → 桥把 `rejected` 回给引擎 → 引擎报"用户拒绝"。**与沙箱、网络、MCP schema 都无关。**
- **新增：引擎级 `permissionMode`**（`lib/engines.js`）三档，**数据集驱动**（各家 CLI 开关不同）：
  | 档位 | 行为 | 适用 |
  | --- | --- | --- |
  | `default` | 不追加参数，引擎照常询问 | 交互会话（安全默认） |
  | `dont_ask` | 按 `permissionTemplates.dont_ask` 追加（Qoder：`--permission-mode dont_ask`） | **定时任务/无人值守** |
  | `bypass` | 按模板追加（Qoder：`--dangerously-skip-permissions`） | 完全跳过检查（⚠️ 危险） |
  只有引擎行声明了对应模板该档才可选（UI 会禁用未声明的档位）。
- **内置 `qodercn` 行**已声明两档模板（实测取自 `qoderclicn --help`）；其余引擎未声明（UI 显示为不可选，
  可用「覆盖启动方式 → args」手填）。
- **UI**：编辑面板新增「权限模式」下拉（+ 切到非默认档时显示实际追加的参数）；引擎行摘要只在非 `default` 时显示
  （`权限模式: dont_ask · 追加参数: --permission-mode dont_ask`）。
- **路由**：`PUT /multi-acp/engines/:id` 接受 `permissionMode`。
- 验收：`tmp/verify-preset-mcp.mjs` **37/37**（+7 条权限档断言；顺带把那条会随 MCP 存储变动而假失败的
  exclude 断言改成"排除本机真实存在的第一条连接别名"）、`tmp/verify-ui.mjs` **71/71**（+4：三档可选、默认 default、
  切换后显示追加参数、PUT body 带 `permissionMode`）、`tmp/verify-toolname-timeout.mjs` 22/22。

---

## 0.1.21 — 2026-10-09 🔴 **A14：prompt 没跑完时也必须补"工具广告块"（否则会话又变 corrupt）**

- **现象**：新会话 `session-a8b0c5f6`（WeKnora）加载失败：
  `SessionFormatError: tool/call call_00_6nWenHV41HbK2VSmtZDe6812 has no advertised tool lifecycle`。
- **根因（A11-3 的缺口）**：广告块只在 `_promptOnce` **成功返回**时才写；
  而 `_flushToolEvents()` 在 `finally` 一定会落 tool 事件 ⇒ **超时 / 取消 / 引擎中途死掉**时，
  日志里只有 `tool/call`、没有广告 → 判 corrupt。
- **修复**：新增 `_ensureToolAdvertisements(events)`，在 `_flushToolEvents()` 落盘**之前**
  把"还没广告过的 callId"补成一条 `assistant/message`（content 全是 tool-call 块、`stream: []`）；
  已广告过的记在 `_advertised` 集合里，**不重复**（同一 callId 重复广告同样会被校验器拒绝）。
  ⚠️ 该集合只在 turn 开始时重置 —— 一度误加在 `_flushToolEvents()` 里会导致重复广告，已修。
- **历史文件**：`tmp/repair-orphan-toolcalls.mjs` 修复 `session-a8b0c5f6`
  （28 条未广告调用 → 插入 28 条广告块，seq 重排 0..107，重排帧），修复后
  `未广告=0`、turn/step 体检无 ⚠️；**全量扫描 0 个会话受影响**。
- 检测工具：`node tmp\scan-orphan-toolcalls.mjs`（会话级）+
  `node tmp\repair-orphan-toolcalls.mjs <dir> [--apply] [--reframe] [--normalize-turns]`。

> **约定**：每次改动代码必须同步递增 `package.json` 的 `version`。
> 理由：DSH 插件页显示版本号，是判断"新代码是否真的加载"的唯一可靠依据。
> 尤其是本插件经 pnpm 以**硬链接**安装 —— 改源码即生效，UI 上无法区分
> "改动无效"与"插件压根没重新加载"。

---

## 0.1.20 — 2026-10-09 🟢 **【添加自定义 Agent】两个入口（手动 / 通过对话）**

### 后端
- 新增 **`lib/engine-probe.js`**：
  - `discoverCandidates(hint)` —— 已知 ACP 候选表（omp / opencode / commandcode / qoder-cn / gemini /
    claude / cursor-agent / kimi / iflow / auggie / goose）+ PATH 浅扫（文件名含线索的可执行文件），
    解析绝对路径（`resolveExecutable`，含 `.exe/.cmd/.bat/.ps1`）；
  - `probeCandidate({command,args})` —— 用**生产同款** `AcpClient` 跑一次真实 ACP `initialize`，
    返回 `{ok, ms, agentInfo, error}`（失败一律短超时收尾，不挂死）。
- 新增两个宿主路由：
  - `POST /multi-acp/probe` —— 手动添加时先验证握手；
  - `POST /multi-acp/discover` —— 给线索 → 候选 → **逐个握手** → 只把能跑的返回给 UI。

### UI（`lib/client.js`）
- 头部新增 **「＋ 添加自定义 Agent ▾」** 下拉：**手动添加** / **通过对话添加**。
- **手动添加**：id / 显示名 / command / args / cwdPolicy 表单 → 「探测」（未探测成功**不允许保存**）
  → 显示 `握手成功 · mytool 1.0 · 12ms` 或失败原因 → 「保存引擎」（`POST /multi-acp/engines`）。
- **通过对话添加**：输入线索（如 `qoder`）→ 「发现」→ 列表里成功项带 `agentInfo 版本 · 路径 · 耗时` 与
  **添加**按钮，失败项显示原因且**不给**添加按钮（避免写入不认 ACP 的 CLI）。

### 验收
- `tmp/verify-discover.mjs`（新）→ **9/9**：候选发现（`qoder`→`qoder-cn.cmd`、`omp`→`omp.exe`）、
  `probeCandidate(qoder-cn --acp)` **握手成功（qoder-cli-cn 1.1.65 · 1576ms）**、
  对非 ACP 进程失败而非挂死、空 hint 只列已安装项。
- `tmp/verify-ui.mjs` → **67/67**（+14：下拉两个入口、手动表单、未探测禁止保存、探测调用与结果、
  保存 POST body、发现面板、`/discover` 调用、只给成功项添加按钮、添加写库）。

---

## 0.1.19 — 2026-10-09 🟢 **路径选择器 · 插件名/版本号 · Qoder CLI CN 入列（实测闭环）**

### 1) 路径选择器（不用手输路径）
- 新增宿主路由 **`GET /multi-acp/browse?path=<dir>`**（`lib/routes.js#browse`）：只列**子目录**
  （含 junction/symlink 判定），返回 `{path, exists, parent, dirs[], quick[]}`，
  默认目录 = `%USERPROFILE%`；`quick` 给「用户目录 / skills（DSH）/ DSH_HOME」快捷入口；最多 500 条。
- UI：skills 目录行新增 **📁 按钮** → 弹出选择器面板（当前路径 + ← 上级 + 快捷入口 + 子目录列表 +
  「选择此目录」）。**纯 DOM 实现**，不依赖 Electron 原生对话框，webview / 浏览器通用。
- 选择器回填后与手输完全等价（同一 `skillsDirs` 字段）。

### 2) 右上角显示插件名 + 版本号
- `GET /multi-acp/engines` 新增 `plugin: {name, version, description}`（运行时读本插件 `package.json`）。
- UI 头部渲染 `dsh-multi-acp v0.1.19` 徽章（hover 显示 description）。

### 3) Qoder CLI CN 入列（内置引擎行）
- **实测结论**：`qoderclicn.exe **--acp**` 是完整 ACP agent（⚠️ 是**开关**不是子命令：
  `qoderclicn acp` 无法握手）：
  - `initialize` 924 ms → `{"name":"qoder-cli-cn","title":"Qoder CLI CN","version":"1.1.65"}`
  - `session/new` **接受 5 个 mcpServers** → 真的调用两套 weknora 端点（`list_knowledge_bases` ×2）→
    回答真实数据「广西弄岗国家级自然保护区 / 广西自然保护地 / 翼界知识库 / 司风 / 标准知识库」
  - `available_commands` **137 个**
- 新增内置行 `qodercn`（`command: 'qoder-cn'`，`args: ['--acp']`，
  `fallbackPaths` 含 `~/.qoder-cn/entry/qoder-cn.cmd` 与 `~/.qoder-cn/bin/qoderclicn/qoderclicn.exe`）。
  技能：它有自己的技能库（`qoderclicn skills link <path>`），暂定 `skillDelivery: auto`。
- 顺带修 `resolveAcpToolName()`：新增"标题首段是标识符"的提取
  （Qoder 的 `title = "list_knowledge_bases (weknora-2afef91d MCP Server)"` → 取 `list_knowledge_bases`）。

### 验收
- `tmp/verify-ui.mjs` → **53/53**（+8：插件版本徽章、📁 按钮、选择器面板/子目录/请求、
  「选择此目录」回填与关闭、PUT body 含选择器回填的路径）
- `tmp/verify-preset-mcp.mjs` → 30/30 · `tmp/verify-toolname-timeout.mjs` → 22/22
- `node tmp/probe-mcp-engine.mjs qodercn` → 接受 + **已连上**（见上）

---

## 0.1.18 — 2026-10-09 🟢 **A13：turn 编号在 resume 后必须接续（否则会话被判 corrupt）**

- **现象**：`SessionFormatError: turn/start does not open the expected turn`（`session-fb54ccef`，第 7 条契约）。
- **定位**：v3→v4 校验器 `fmt-v3v4.js:746-747`：`turn/start` 时**不能有已打开的 turn**，
  且 `data.turn` 必须等于 `nextTurn`（`turn/end` 时 +1）。
- **根因（我们的 bug）**：`AcpTurnRunner._turn` 是**每个 agent 实例**的计数器（`this._turn += 1`）
  ⇒ 会话被 resume 后新实例从 0 起，又写了 `turn/start {turn:1}` → 日志里出现两个 turn 1。
- **修复**：新增 `_lastTurnFromSession()`，构造时用 DSH 的 `turnBoundary` 投影（`projections.stateOf`）
  读 `lastTurn`，拿不到就退化为扫描 `session.events` 里最大的 `data.turn`，把 `_turn` 初始化到该值
  （trace：`acp.turn.resume-from-projection` / `resume-from-events`）。
- **历史文件修复**：`tmp\repair-orphan-toolcalls.mjs --normalize-turns`
  （按 `turn/start` 分段重写 `data.turn` 为 1,2,3…，段内 `step` 重排 1,2,…；**step 必须从 1 起**，
  否则 `step/start` 校验同样会挂）。`tmp\dump-boundaries.mjs` 可直接体检（打印每个 turn/step 边界与 ⚠️）。

---

## 0.1.17 — 2026-10-09 🟢 **SKILLS 配置（引擎管理 UI）+ 技能投递三模式**

### 背景
ACP **协议里没有 skills 字段**（`session/new` 只有 `cwd`/`mcpServers`），技能共享靠**磁盘目录**。
实测（见 `docs/evidence/A10-…md §9.1`）：omp / OpenCode 自扫 `~/.agents/skills`（DSH 的 119 个就在那里，
omp 在 ACP 会话里能列出并 `skill://agent-reach` 载入正文）；**Command Code 需要 `--skill <dir>`**
（加上后 ACP 会话里 `activate_skill{"name":"agent-reach"}` 成功）。

### 新增
- **引擎行 schema**（`lib/engines.js`）：
  - `skillDelivery`：`'auto'`（引擎自扫）/ `'args'`（启动时追加参数）/ `'none'`；
  - `skillsDirs`：要暴露的目录（空 = `~/.agents/skills`，支持 `~`/`%VAR%`/`${VAR}` 展开）；
  - `skillArgsTemplate`：`args` 模式的写法，默认 `['--skill', '{dir}']`；
  - 内置默认：**Command Code → `args`**（否则它在 ACP 会话里看不到 skill），omp / OpenCode → `auto`。
- **投递生效点**：`resolveSpawn()`（探针、DSH 会话共用同一条路径）。
- **运行探测**：`describeSkills()` 报每个目录「是否存在 / 有多少个 skill」，并在引擎行摘要里
  显示「SKILLS: args · --skill 挂载 1/1 个目录（119 个 skill）· 追加参数: --skill C:\...\.agents\skills」。
- **UI**（`lib/client.js`）：编辑面板新增 **「SKILLS 目录」**块 —— 投递方式下拉 + 目录行（路径输入 +
  状态徽章「已找到 N 个 skill」/「目录不存在」+ 🗑）+ **＋ 添加目录** + 说明文字；
  保存时下发 `skillDelivery` / `skillsDirs`（`routes.js#mergeEnginePatch` 已校验）。
- 引擎行的 **launch 行**照旧显示基础 args，新增的 SKILLS 摘要在下一行单独显示（避免把 shim 前缀混进去）。

### 验收
- `tmp/verify-preset-mcp.mjs` → **30/30**（新增 9 条：auto 不追加 / args 追加 `--skill <dir>` /
  多目录可重复 / 自定义模板 / `describeSkills` 三种投递语义与真实目录探测）
- `tmp/verify-ui.mjs` → **45/45**（新增 SKILLS 块：默认 auto、目录行渲染、切 args、
  改路径 + ＋添加目录，断言 PUT body 的 `skillDelivery` / `skillsDirs`）

---

## 0.1.16 — 2026-10-09 🟢 **工具名不再用句子 · prompt 超时可配置 + 超时诊断 · 🔴 修"历史加载失败"（A1 回显缺工具广告块）**

> ⚠️ 0.1.16 里最要紧的是第三条：**0.1.15 的 A1 回显会让会话文件被 DSH 判为 corrupt**
> （`tool/call … has no advertised tool lifecycle`），已修 + 已提供历史文件修复脚本。

### A12：`step/end` 前必须收尾悬空 `tool/call`（生产侧 + 历史修复都要）

- **现象**：`SessionFormatError: step/end leaves unresolved tool call call_00_Sv65lS0mUVT6bbLeZzJz0604`。
- **定位**：v3→v4 校验器 `fmt-v3v4.js:577`：`step/end` / `turn/end` 时 `this.tools` 必须已清空
  （即每个"已广告 + 已 start"的调用都要有 `tool/result`）。
- **我们的 bug（同 A11-3 的连带）**：引擎跑到一半 **prompt 超时/取消/引擎崩**时，某个
  `tool_call` 永远不会有终态 → 只有 `tool/call` 没有 `tool/result`（实测 `fb54ccef` 33 调用 / 32 结果）。
- **修复（插件）**：新增 `_resolvePendingToolCalls(reason)`，在写 `step/end` 之前，对每个
  `recorded && !finished` 的调用补一条 `isError:true` 的 `tool/result`
  （`createToolResultMessage`，文案说明"引擎未返回结果 + turn 结束原因"），并 `trace('acp.tool-result.injected')`。
  官方 loop 中断时同样是这么收尾的。
- **修复（历史文件）**：`repair-orphan-toolcalls.mjs` 增加同样的收尾逻辑，并补齐两个新契约：
  **消息必须有非空 `message.id`**（读取器 `worker.cjs:5644-5680` "lacks an identified message"）、
  `assistant/message.source.kind === 'model'`（第四契约）。
- 现在修复脚本对 6 条契约全绿：① 广告块 ② 第一帧仅一行 ③ seq 从 0 连续 ④ source.kind
  ⑤ message.id ⑥ step/turn 结束前无悬空调用。

### A11-3：`tool/call` 必须先被"广告"，否则历史加载失败（严重）

- **现象**：DSH 打开会话 → `历史加载失败：stored session "…" is corrupt: … SessionFormatError:
  tool/call call_00_B92CT0Xdh4GJ5bL3uIhW3432 has no advertised tool lifecycle`。
- **定位**：DSH 的会话格式校验器
  `@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:618-650`（加载历史时执行）要求：
  `tool/call` 的 callId **必须**先出现在某条 `assistant/message` 的
  `content[].type === 'tool-call'` 块里，且 `name` / `arguments` **逐字节相等**：
  `if (pending === void 0) throw '… has no advertised tool lifecycle'`。
- **我们的 bug（A1 回显）**：只写 `tool/call` + `tool/result`，**从不写广告块**；而且
  `assistant/message` 只在"有文本"时才写，引擎只调工具不吐字时（或 prompt 超时提前抛错时）
  一条都不写。受影响会话实测 **33 次调用 / 0 条 assistant/message**。
- **修复**：`_promptOnce` 组装 assistant 消息时，把本 turn 缓冲的 `tool/call` 事件**原样**
  （同一 `name`、同一 `arguments` 字符串）作为 `tool-call` 内容块塞进 `content`，并改成
  "有工具调用也写 assistant/message"。该消息先于 `_flushToolEvents()` 落盘 ⇒ 广告在前、调用在后。
- **修复历史文件**：`tmp\repair-orphan-toolcalls.mjs <sessionDir> [--apply] [--reframe]`
  （安全校验：全 `append`、无 seq 交叉引用；按 turn/step 在每条孤儿 `tool/call` 前插入广告块；
  重排 seq；**先备份** `*.bak-<时间戳>`）。`tmp\scan-orphan-toolcalls.mjs` 用于扫描受影响会话。
- **⚠️ 帧布局同样有契约**（第二次踩坑）：DSH 读取器要求
  **第一帧恰好只有一行**（会话头），否则报
  `corrupt Zstandard session log: first frame is not exactly one header line`。
  修复脚本第一版把整文件压成一帧 ⇒ 修好"未广告"又踩这条；现在 `frames = [头帧(1 行), 数据帧(每 200 行, 均以换行结尾)]`，
  `--reframe` 可只重排帧布局。**任何手工重写 `.jsonl.zstd` 的工具都必须遵守这条。**
- 影响面：今天 15:31–15:53 之间由 ACP 引擎写的 **4 个会话**（`eb41892c` / `c65875d3` / `fb54ccef` /
  `e877352c`），其余 67 个会话正常。

### A11-1：`tool/call.name` 取真工具名，`title` 另存

- 现象（用户指出）：轨迹里的"工具名"是句子，如 `"Finding WeKnora base URL in configs"`。
- 根因：官方**反向**桥（`dsh-acp` 的 `updates.ts:52-85`，DSH 当 ACP agent 时）把 DSH `name`
  写成 ACP `title`；我们早期直接取反得到 `name = update.title`，而引擎（实测 omp）的
  `title` 是**给人读的一句话**。ACP 的 `ToolCall` **没有** `toolName` 字段
  （`@agentclientprotocol/sdk` types.gen.d.ts:5130-5190：`toolCallId/title/kind/status/content/
  locations/rawInput/rawOutput/_meta`），真名通常藏在 `_meta` 或引擎自定义字段里。
- 改动：新增 `resolveAcpToolName()`（导出，可测），按
  `update.toolName` → `_meta.{toolName,tool_name,tool,name,toolId}` → `rawInput.tool|toolName`
  取真名；调用方再退回 `kind`（read/execute/edit…）→ `'acp-tool'`。
  `tool/call` 事件新增 **`title` / `kind` 两列**（DSH 只读 `name`/`arguments`，这两列给轨迹阅读与导出用）。

### A11-2：`session/prompt` 超时可配置 + 超时打印"引擎最后一次 update"

- 现象（`session-fb54ccef`）：turn 以 `acp[omp]: session/prompt: timed out after 300s` 结束，
  但完全不知道引擎停在哪。
- 改动：
  - `lib/acp-client.js`：硬编码的 `300_000` → `DEFAULT_PROMPT_TIMEOUT_MS`（导出）+
    `engine.promptTimeoutMs` 覆盖；**`<= 0` = 不超时**（`withTimeout` 直接返回原 promise，
    适合长任务）；插件配置 `promptTimeoutMs`（默认 300000）由 `index.impl.js` 注入每个引擎行，
    引擎行自带值优先（`engines.json` 也可单引擎设）。
  - `lib/acp-agent.js`：每个 turn 记 `_lastUpdate` 摘要（`tool_call/agent_message_chunk/
    available_commands_update`…），超时错误追加
    `(last engine update 12s ago: tool_call bash (in_progress) — …)`，并 `trace('acp.prompt.timeout')`
    记 `kind/ageMs/frames`。常见形态一眼可辨：卡工具 / 还在吐字 / 完全没声音（进程僵死）。

验收：`node tmp\verify-toolname-timeout.mjs` → **17/17 PASS**（工具名 11 条 + 超时 6 条）。
配置项已写进 `cordis.patch.yml` 注释。

---

## 0.1.15 — 2026-10-09 🟢 **preset 补齐原生工具组合 · resume 不再静默回落 · MCP 随会话下发 · B4 UI**

> 起因：用户反馈「dsh_multi_acp 创建的 preset 里根本没挂 DSH 原生的 shell / 文件系统工具，
> 会话中报 `write → FS_SANDBOX_DENIED`、`pwsh → error`」。逐条查证与处置见
> `docs/evidence/A10-preset-tools-mcp-2026-10-09.md`、`docs/ISSUES.md` ISSUE-08/09。

### ISSUE-08：ACP preset 是"空壳" + resume 静默回落原生 loop（任务 2）

**实测证据**

- 会话 `session-144c11b2`（`agentPreset=acp-commandcode`）的 `request/header` 里只有 164 个工具，
  全是部署层插件工具；模型自己探到 `unknown tool "write"` / `unknown tool "read"` / `unknown tool "bash"`。
- `<stateDir>/trace.log`（2026-10-09 01:28–05:55）里**每一次** `factory.resume` 都是
  `presetId:null → fallback-native` —— 因为 `ResumeAgentOptions`（`@deepseek-ai/dsh-agent` 类型定义）
  里**没有 agentPreset 字段**，只有 `resumeSessionId`。

**改动**

- 新增 **`lib/preset-native.js`**：`acp-*` preset 现在按
  `@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml` 的工具行补齐
  **skill-filesystem + tool-skill / tool-pwsh|tool-bash / tool-fs + tool-fs-search /
  tool-jobs / tool-todo / tool-ask-user / tool-web**，marker 仍是最后一行。
- 插件配置 `presetTools`（`true`/`false`/分组数组，默认全开）与 `unsandboxedFs`
  （按 `minimal` preset 的写法，在 entry-local realm 里用 `dsh-fs-local` 遮蔽宿主 sandboxed fs；
  ⚠️ 消费 fs 的 `tool-fs` / `tool-fs-search` **必须和 fs-local 同组**，否则等于没遮蔽）。
- **A9**：`_presetIdOf()` 在 resume 路径上回落查 `<stateDir>/session-map.json` 的 `engineId`，
  命中即路由到引擎（此前一律静默跑官方 loop）。

### ISSUE-09：MCP servers 没有随会话注入（任务 4）

- 新增 **`lib/mcp-servers.js`**：读 DSH 自己的 `<DSH_HOME>/storages/mcp_connector.json`
  （`tables.connections`），映射成 ACP 的 `McpServer`（env/headers 对象→数组、bearer→`Authorization` 头），
  经 `session/new` **与** `session/load` 一并下发（`acp-host.resumeSession` 新增 `mcpServers`）。
- 收窄口径：插件 `mcp.enabled/include/exclude` + 引擎 `engine.mcp`（`inherit` | `none` | 自定义数组），
  include/exclude 按**别名**（ACP 名 / `name` / `serverName` / `serverKey` / `connectionId`）匹配。
- ⚠️ 治理边界：ACP 没有审批/授权字段，注入给引擎的 MCP 是**全量可用**的（`docs/ACP-INTEGRATION.md` §4.1）。

### C1：引擎 skill / 命令发现的**回显**（任务 3）

- 新增 **`lib/engine-runtime.js`** + `acp-agent` 的 `available_commands_update` 处理（此前被
  "unknown update" 丢掉）：记录引擎上报的 slash command / skill 清单（进程内观测 + `trace` 留痕），
  UI 诊断行显示「引擎命令/技能：N 个」；新端点 `GET /multi-acp/engines/:id/commands`。
- 原生侧：preset 挂上 `skill-filesystem` + `tool-skill` → 回落原生时技能目录同样可用。

### B4：引擎管理 UI 完善（任务 1）

- **① 可编辑启动方式**：展开 `覆盖启动方式` → `command` / `args`（含引号整段解析）/ `cwdPolicy`
  → `PUT {resolvedCommand, args, cwdPolicy}`。
- **② 环境变量行编辑**：KEY/VALUE 行 + 👁 明文切换 + 🗑 删除（**已保存过的键以 `KEY: null` 下发**，
  否则删不掉）+ ＋ 新增。
- 顺带：四态过滤桶（全部/可用/未安装/不可用）+ 搜索、默认引擎徽章、**握手诊断行**
  （MCP 下发 + 引擎命令/技能 + 最近握手时间）、`启用/停用` 按钮、MCP 策略下拉。

### 验收（可复跑）

| 脚本 | 结果 |
| --- | --- |
| `tmp/verify-preset-mcp.mjs` | **21/21 PASS**（组合行的模块名逐条对照官方 standard/minimal preset；MCP 映射/别名/短路） |
| `tmp/verify-ui.mjs` | **38/38 PASS**（自带 mini-React，真点真改真保存：断言 PUT body 里的 `null` 删除、args 解析、mcp=none） |

### A10-2 / A10-3：切换 preset 时「会话已被占用」（2026-10-09 15:02–15:13 实测）

用户在新会话里点「切换到 OpenCode / Command Code / 标准模式」，三次都报
`session "session-e877352c…" is already owned by an active write handle`（UI 提示"可能是其他正在运行的 DSH"）。
`trace.log` 还原时间线：

```
07:02:21.996 factory.createAgent {preset=acp-omp}          ← 创建成功
07:02:24.308 acp.available_commands {engine=omp}           ← 引擎已连通（C1 生效）
07:02:24.443 factory.resume.engine-from-map {engine=omp}   ← 0.1s 后 UI 来 resume（切 preset）
07:02:24.443 factory.resume.error-fallback {"…already owned by an active write handle"}
07:04:33…07:06:xx 反复 resume → 同一句错（连「标准模式」也切不动）→ 会话彻底卡死
```

**根因（三条，都要修）**

1. `ResumeAgentOptions` 里没有 `agentPreset`，切 preset 时 UI 只改 `session.agentPreset` 再 `resume`
   → 我们的 A9 回落把**旧引擎**当成目标（切到哪都还是 `acp-omp`），于是又去抢同一份写句柄。
   ✅ 修：`_presetIdOf()` 优先读**活会话的当前 preset**（`ctx.sessions.get(id).agentPreset`），
   trace `factory.resume.preset-from-live`；map 只作重启后的冷 resume 兜底。
2. 本工厂为该会话创建的 agent 若还活着，就仍持有写句柄（`sessionPersistence.open(id,'write')` 是
   **单写所有权**）。DSH 的 `agents.resume()` 是**无条件转发**给工厂的（`dsh-agent/lib/index.js:556`），
   没有"已有活 agent 就 attach"的分支 → 必须由我们**自己释放旧 agent**。
   ✅ 修：新增 `MultiAcpFactory._live`（本工厂驱动的活 agent 表）+ `_disposeStale(sessionId, why)`，
   在 create / resume 的**分支之前**调用（放分支之前才覆盖"切到标准模式"的情况 —— 那条路径我们不建 ACP agent，
   但官方 `persistence.prepare` 会因"会话仍 live"直接拒绝）。
3. 冲突时只看得到一句模糊报错。✅ 修：`_diagnoseHandleConflict()` 记 `ours=` / `hostHasLiveAgent=`
   到 trace 与日志，下次一眼定位是谁占着。

### A10-4：宿主**崩溃**（我们的 agent scoped ctx 缺 `systemPrompt`）—— 2026-10-09 15:15 / 15:16 两次

用户没做任何操作，DSH 直接弹崩溃框，诊断报告 `crash-2026-10-09T07-15-29-089Z-host.log`
与 `crash-2026-10-09T07-16-41-114Z-host.log`（两次同一栈）：

```
dsh: fatal load failure: Error: cannot get property "systemPrompt" without inject
    at install      (dsh-experimental-tool-agent-team/lib/index.js:237)
    at maybeInstall (…:541)     ← 监听 agent/created + 装载时遍历 live agents，对"团队成员"装团队工具
    at Object.<anonymous> (…:545)
    at async Proxy.announce (dsh-agent/lib/index.js:579)   ← 会话 announce（我们的 create/resume 会走到）
```

**根因**：`dsh-scope` 的 `createScope(ctx, key)` 注释写着
"The scoped context **inherits the minting plugin's dependency API**" ——
我们用 `createScope(rootCtx, agent)` 造出来的 `agent.ctx` 能访问什么，取决于**本插件的 inject 列表**。
官方 loop 是 `static inject = ["agents","sessions","llm","tools","systemPrompt"]`，
所以别人的插件可以放心访问 `agent.ctx.systemPrompt`；而我们只声明了
`["agents","agentPresets","sessions","commands"]` → `agent.ctx.systemPrompt` 抛错 →
**fatal load failure → 宿主进程退出**。

**修复**：`lib/index.js` + `lib/index.impl.js` 的 `inject` 与官方 AgentLoop 对齐：
`['agents','agentPresets','sessions','commands','tools','systemPrompt','llm']`。
原则：**替身 factory 造出来的 agent，其 scoped ctx 必须和官方 agent 长得一样**，
否则任何按官方约定访问 `agent.ctx` 的插件都可能把宿主带崩。

**验证**（15:18 重启后）：无新崩溃；之前卡死的 `session-e877352c` 直接复活：

```
07:18:30.816 factory.resume {engine=omp, preset=acp-omp}
07:18:30.825 session.mcp {sid=e877352c, count=4}   ← MCP 4/4 下发
07:18:33.169 acp.available_commands {engine=omp}   ← 引擎回来上报命令清单
（全程没有 error-fallback）
```

### 未做（如实）

- **ISSUE-06 最后一跳的"人工确认"**：14:43 那枪已经把链路推到"引擎 spawn 成功 + MCP 已下发 + 引擎已回 `available_commands`"，
  剩下 `sessionProjections` / 写句柄两处修复后的**收尾确认**（预期：不再出现 `error-fallback`，
  会话界面显示引擎自己的模型与工具）。
- MCP 注入只验到"映射正确 + 调用点已接线 + 引擎已收到 `session/new`"，**引擎侧是否真的连上这些 MCP**
  尚未做 round trip（判定：会话里调用被注入 MCP 提供的工具）。
- `pwsh → error`（`SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)`）
  是**宿主 `dsh-sandbox-windows-acl` 的 ACL 授予失败**，与 preset 无关；已记入证据文件，
  规避办法（危险模式 / 换工作目录）见证据文件"环境结论"。

---

### 🔬 真实会话验证（2026-10-09 14:43，重启后第一枪）—— 顺带修掉一个致命 bug

用户在一个 `preset=acp-omp` 的真实会话里复现（日志 `session-c2601ea1` + `trace.log`）：

| 观察点 | 结果 |
| --- | --- |
| preset 工具行 | ✅ `preset.register` 带上 9 行 `nativeToolRows` |
| 该会话首个 `request/header` | ✅ **602 个工具**，含 `read/write/edit/glob/grep/pwsh/skill/web_search/todo_write/job_list`（旧代码同期是 164 个、无一个原生工具） |
| 引擎路由 | ✅ `factory.createAgent {presetId:'acp-omp', engineId:'omp'}` + `factory.createAgent.spawning {command:'omp'}` |
| MCP 注入 | ✅ `session.mcp {count:4, summary:'MCP：4 个 — weknora-dc328ba5(http), chrome-devtools(stdio), drawio(http), dingtalk-workspace(stdio)'}` |
| 最终结果 | ❌ `factory.createAgent.error-fallback {"message":"cannot get property \"sessionProjections\" without inject"}` → 引擎都 spawn 了仍回落原生 loop |

**修复**：`acp-agent.js` 里 `rootCtx.sessionProjections` → `rootCtx.get('sessionProjections')`
（该服务是**可选**的：`dsh-session-projection` 类型注释明确写 "headless assemblies without the
registry stay unaffected"，因此**不能**硬 `inject`，只能用非抛错访问器 `ctx.get()`，
与既有的 `readApproval` / `readPersistence` 一致；`createAcpInbox` 本来就对 undefined 兜底）。

---

## 0.1.14 — 2026-10-08 🟢 **ISSUE-01(b) 落地 + ISSUE-05 探针实证**

### ISSUE-01(b)：OpenCode "选了就坏" —— 预置免费模型

- 新增引擎字段 **`initialConfigOptions: { configId, value }[]`**；`createAcpAgent` 在 ACP 会话开好后
  （create/resume 都走）逐条 `setConfigOption`，**失败只记警告、不致命**。
- 内置 OpenCode 预置 `{ configId:'model', value:'opencode/nemotron-3.5-lightning-free' }`
  （可在 `<stateDir>/engines.json` 覆盖；`PUT /:id` 会保留该字段）。
- `describeEngines` / `mergeEnginePatch` 一并带上该字段。

### 探针实证（`docs/evidence/probe-*2026-10-08*.json`）

| 引擎 | 结论 |
| --- | --- |
| **omp** | ✅ 握手 560ms；`set_config_option model=…` 成功（agent 回 `config_option_update`）；多会话复用 OK；prompt `end_turn` 1253ms |
| **Command Code** | ✅ 握手 2720ms；`set_config_option` 成功；`modes` 5 档；`sessionCapabilities={list,resume,close}`；prompt `end_turn` 49.3s |
| **OpenCode** | ✅ 握手 414~738ms；`sessionCapabilities` 最全；**默认模型 `opencode-go/claude-haiku-5-5` → `Insufficient account funds`**（ISSUE-01 仍真）；切 `opencode/nemotron-3.5-lightning-free` → `end_turn` **cost=0** |

⇒ **ISSUE-05（omp / Command Code 的 `set_config_option`）已实测通过**；
ISSUE-01 的"默认坏 / 换免费模型好"复现并被 v0.1.14 的预置修复覆盖。

### 未做（如实）

ISSUE-06「**在 DSH 内**跑 OpenCode 真实会话」仍待做 —— 需要驱动 DSH Web UI，
而 AionUi 内置浏览器当前未挂载（`not attached`）。独立探针已复验通过。

---

## 0.1.13 — 2026-10-08 🟢 **按 docs/ISSUES.md 完善（引擎可移植性 / 错误分流 / 能力透传）**

处置逐条见 `docs/ISSUES.md` 新增的「处置状态」表。本轮代码改动：

- **ISSUE-02（可移植性）**：`lib/engines.js` 内置行去掉写死的本机绝对路径，改为
  **裸命令 + `fallbackPaths`（`%LOCALAPPDATA%`/`%USERPROFILE%`/`%APPDATA%` 模板）**；
  探测顺序：`resolvedCommand`（用户显式）→ `commandOverrides` → `fallbackPaths` → **PATH**。
  `resolveSpawn()` 改为优先用**探测到的绝对路径**。本机实测三引擎仍全部 `available`，
  且 `commandcode` 靠 PATH 命中 `commandcode.CMD`。
- **ISSUE-03（启动正确性）**：Command Code 的基础 `command` 由 `cmd` 改为真实 CLI 名
  `commandcode`；`.cmd`/`.ps1` shim 由 `resolveSpawn` 按**探测到的后缀**处理。
- **ISSUE-01(a)（错误分流）**：新增 `classifyAcpError()`，把失败归一成稳定机器码
  （`INSUFFICIENT_FUNDS` / `RATE_LIMITED` / `UNAUTHORIZED` / `TIMEOUT` / `UNKNOWN`），
  写入 `turn/end.reason.error.code`。OpenCode 的 `Insufficient account funds` 现归为
  `INSUFFICIENT_FUNDS`，不再与"协议不通"混在一起。（(b) 预置免费模型未做 —— 模型 id 易变。）
- **ISSUE-04（如实声明能力）**：`AcpClient.initialize` 默认 `clientCapabilities.fs`
  由 `true` 改为 **`false`** —— 此前"谎报"支持 fs 但 handler 只返回空内容，会让引擎写文件静默失败；
  未实现就声明 false，引擎改用自己的 fs 工具。被误调时记 warn。
- **ISSUE-07（能力徽章透传）**：路由在试连成功后缓存能力快照，`GET /engines` 各引擎行带
  `capabilities`；客户端渲染 `MCP http/sse · session … · prompt … · agent · ms` 一行。
- **ISSUE-08（默认引擎来源）**：`GET /engines` 返回生效 `defaultEngine` + 来源说明
  （插件 config；空串 = 官方 DSH loop），客户端显示「默认引擎」行。

**韧性**：`lib/client.js` 的 `apply()` 外层加 try/catch，**绝不 rethrow** —— 复现 v0.1.12
的教训不会再让单个客户端插件拖垮 web boot。

**未做（如实）**：ISSUE-01(b)、ISSUE-05、ISSUE-06 属运行时验证/选型，见 ISSUES.md 处置表。

---

## 0.1.12 — 2026-10-08 🔴 **修复：客户端入口未声明 `inject` 导致 DSH 无法启动**

**现象**（用户报告）：

```
web boot: 1 entry did not activate
dsh-multi-acp: failed
```

崩溃日志（`…\dsh-desktop\logs\crash-*-web-boot.log`）给出确切原因：

```
[dsh-multi-acp] locale: Error: cannot get property "locale" without inject
```

**根因**：`lib/client.js` 的客户端模块导出**漏了静态 `inject` 声明**。
Cordis 对**未声明 inject 的服务属性访问直接抛错**（与 CHANGELOG 0.1.4 / P1 证据 §5 记录的是同一个陷阱）：

```js
// 错误：ctx.locale 的属性访问本身就抛错，外层的 `ctx.locale && …` 守卫救不了
if (ctx.locale && typeof ctx.locale.register === 'function') { … }
```

客户端入口激活失败 ⇒ web boot 判定「1 entry did not activate」⇒ **整个应用起不来**。

**修复**（照活样例 `experts-management/client/index.js:1368-1370`）：

```js
module.exports = { name: CLIENT_NAME, inject: ['slots', 'locale'], apply(ctx) { … } }
```

**教训**（已补进 B0 证据 §2.3）：**客户端模块必须静态声明它要用的每个服务**
（`slots` / `locale` …），否则属性访问即抛错；不要用「属性访问 + `&&` 守卫」来探测服务。

**验证**：重启后进程正常、`load-report` OK、`:19387` 监听、**无新崩溃日志**；
服务端 bundle 已含 `inject: ['slots', 'locale']`。

---

## 0.1.11 — 2026-10-08 🟡 **B3：客户端半边（设置页「引擎管理」分区）**

新增 `lib/client.js` —— **手写 bundle**，直接采用加载器约定的
`window.__ModuleLoader__.load({ id, factory })` 包裹，**不用 JSX**（`React.createElement`）⇒ **免 esbuild**。

- 平台模块 `require('react')` 由加载器 seeded require table 提供；纯 Node 下有最小 shim（可静态加载）。
- 注册：`ctx.slots.inject('settings.section', () => ctx.slots.register({name,id,order,locale,label,inject}, Comp))`。
- i18n：`ctx.locale.register(NS,'zh'|'en',…)`。
- 面板：拉 `GET /multi-acp/engines` 渲染四态列表（状态徽章/可执行体）；
  「测试连接」→ `POST /:id/test` 并显示 `connected · ms · agent` 或失败原因；
  「编辑环境变量」→ `KEY=VALUE` 文本域，`PUT /:id` 后**自动试连**并刷新。
- 刻意**不用** `dsh-client-ui-primitives`（只原生元素 + 内联样式），降低与宿主版本耦合。

清单：`package.json` 加 `exports['./client'] = './lib/client.js'` 与 `dsh.client = { platform:'web' }`。

### 状态

✅ **已目视验证**（用户截图确认）：设置 → 引擎管理；三引擎 `omp (oh-my-pi)` / `OpenCode` / `Command Code`
均显示「可用」+ 可执行体路径 + 「测试连接 / 编辑环境变量」按钮。

---

## 0.1.10 — 2026-10-08 🟡 **B2：宿主侧引擎管理 HTTP 路由**

新增 `lib/routes.js`，在 `ctx.webServer` 上注册 `prefix /multi-acp`（`index.impl.js` 里
`ctx.inject(['webServer'], …)`；缺席则跳过、不阻塞加载）。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/multi-acp/engines` | 列表 + 四态 + 可执行体（+ `stateDir`） |
| POST | `/multi-acp/engines` | 新增/写入自定义引擎（`engines.json`） |
| PUT | `/multi-acp/engines/:id` | 改 `env`（`null`=删键）/ `args` / `resolvedCommand` / `enabled` / `sortOrder` |
| POST | `/multi-acp/engines/:id/test` | 试连（`AcpHost.tryConnect`）；失败写入 `lastError` ⇒ 该引擎态变 `unavailable` |
| GET | `/multi-acp/engines/:id/bound-experts` | 反向索引 —— **当前返回空集+说明**（无数据源，见 B0 §4） |

- **合并策略**：`loadEngines` 的用户层是"整体覆盖、不深合并"，故 PUT 先把 patch 合并进
  **归一化引擎**（保留 `commandOverrides`/`initBudget`/`cwd`/`resolvedCommand`）再整体写入 ——
  否则一次环境变量编辑就会丢掉内建启动路径覆盖。
- 写入用 `.tmp → rename` 原子替换。
- **回环守卫**：`isLoopback(req)` —— 非回环来源一律 `403`。本路由不做应用层鉴权
  （与活样例一致），但引擎 `env` 可能含 API 密钥，故保留这最后一道防线
  （当前 webServer 监听 `127.0.0.1`，`netstat` 已确认）。
- 隔离测试（fake req/res/pool）全绿：列表四态、test、PUT 合并+持久化、bound-experts 空集+note、404、非回环 403。

### 运行时验证（`curl http://127.0.0.1:19387`）

| 请求 | 结果 |
| --- | --- |
| `GET /multi-acp/engines` | ✅ 200；`omp`/`opencode`/`commandcode` 全 `available`，可执行体路径正确 |
| `POST /multi-acp/engines/omp/test` | ✅ 200；**`omp` 实测握手 584ms、`oh-my-pi 18.3.5`**、能力集 `mcp{http,sse}` + `session{list,fork,resume,close}` + `prompt{image,embeddedContext}`、`parseFailures:0` |
| `GET /multi-acp/engines/omp/bound-experts` | ✅ 200；空集 + 说明 |
| `GET /multi-acp/engines/nope` · `/whatever` | ✅ 404 |

> `PUT` 会写用户的 `<DSH_HOME>/multi-acp/engines.json`，故**只在隔离测试**里验证，未在真实 profile 上执行。

### 状态

✅ **已运行时验证**（`:19387/multi-acp/*`）。

---

## 0.1.9 — 2026-10-08 🟡 **B0/B1：引擎管理 UI 的契约核实 + 四态探测**

### B0 · 契约核实（证据：[`docs/evidence/B0-ui-contract-findings.md`](docs/evidence/B0-ui-contract-findings.md)）

- **宿主路由**：`ctx.webServer.register({ kind:'exact'|'prefix', path, handler(req,res) })`，返回 disposer；
  handler 自己拥有完整响应。活样例 `experts-management/src/index.js:868`。
- **客户端插件**：`window.__ModuleLoader__.load({ id, factory:(require)=>{…; return module.exports} })`；
  `require('react')` / `react-dom/client` / `@deepseek-ai/dsh-client-ui-primitives` 由**加载器 seeded require table** 提供。
  注册：`ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({name,id,order,locale,label,inject}, Comp)))`。
  已知 slot：**`settings.section`**、`conversation.input.left`。
- **清单**：`exports['./client']` + `dsh.client.platform='web'`。
- ⚠️ **发现**：专家包 `plugin.json` **没有 `agentPreset`**（也无任何 preset/engine 绑定字段）⇒
  UI-DESIGN §3.2 的「绑定此引擎的专家」**没有数据源**，B2 该端点只能返回空集+说明。

### B1 · 引擎四态探测（`lib/engines.js`）

```js
detectExecutable(engine, { platform, env })  // 路径直查 / PATH 按 PATHEXT 查找
engineState(engine, opts)                     // disabled > not-installed > unavailable > available
describeEngines(engines, opts)                // B2/UI 用的引擎行（状态+可执行体+能力）
readUserEngines / saveUserEngine(stateDir, e) // <stateDir>/engines.json 读写（.tmp→rename 原子）
```

本机实测：`omp` / `opencode` / `commandcode` 三者 `available`，路径解析正确。

---

## 0.1.8 — 2026-10-08 🟡 **A3 · A4 · A8：取消语义 / 会话恢复 / 持久化**

三条耦合在"会话生命周期"上，一起做。

### A3 · 取消语义（DSH 0.2.x **没有** `agent/canceled` 事件）

结论：取消的表达是 **`Agent.cancel(cause, { keepInbox })` + `turn/end{kind:'aborted', reason}`
+ inbox splice 的 `outcome:'canceled'`**（无独立"canceled"事件）。

- `cancel()`：透传 cause，abort 信号，调 ACP `session/cancel`；`keepInbox` 时不 `clear()`（照契约）。
- **inbox 重写**：新增 `mutate(target,start,del,inserted,discardRemoved)`：
  - `discardRemoved=true`（clear / replace / remove）⇒ 被移除消息记 `outcome:'canceled'`
    并发 `agent/inbox/discarded`；
  - `discardRemoved=false`（认领）⇒ 不记 outcome、不发 discarded；
  - 插入消息一律发 `agent/inbox:inserted`。
    照 `agent-loop/src/inbox.ts:197-243`。
- `_claim` 改用非丢弃式 `consume()`（此前误用 public `splice` ⇒ 认领会被记为 canceled）。

### A8 · 会话持久化（此前**完全没接**）

契约（`agent-loop/src/index.ts:652-706`）：agent 侧只需
`persistence.create(header)` → `appendUnstoredSuffix()` → `announce`（后端**按 sessionId 自动路由**
live 事件）→ `handle.close()`。

- create：`ctx.get('sessionPersistence')?.create(session.header, { inheritedEventCount })`。
- 发布前 `appendUnstoredSuffix(stored, session)`（`session.snapshotEvents` 推未存后缀）。
- 失败/销毁路径全部 `handle.close()`。

### A4 · 会话恢复（此前有**两个 bug**）

1. **身份字段用错**：resume 用的是 `options.resumeSessionId`（`ResumeAgentOptions`），
   而代码读的是 `options.sessionId` ⇒ 恒为 `undefined` ⇒ "恢复"其实偷偷新建了会话。
2. **没有 seed**：从未读取持久化日志，恢复出来的会话是空的。

- resume：`persistence.open(id,'write')` → `handle.read(0)` 取回事件 →
  `interruptedTurnClosers()` 补崩溃孤儿 turn → `sessions.prepare({ seed, meta: handle.header,
  inheritedEventCount, eventState })`。照 `agent-loop/src/index.ts:807-890`。
- **ACP sessionId 映射**：新增 `lib/session-map.js`（`<stateDir>/sessions.json`）记录
  `dshSessionId → { engineId, acpSessionId, cwd }`；resume 时据此 `host.resumeSession()`
  （`session/load`）。映射缺失或 `load` 失败 ⇒ **退回新建 ACP 会话**并告警，
  **不**降级到官方 loop（避免静默换引擎）。
- `MultiAcpFactory` / `index.impl.js` 传递 `stateDir`。

### 状态

🟡 已实现，**待运行时验证**：① 长任务中途取消 → `turn/end{aborted}` + inbox canceled；
② 重启后打开同一 ACP 会话能否续上；③ `sessions\**.jsonl.zstd` 是否完整落盘。

---

## 0.1.7 — 2026-10-08 🟡 **A1 接线：ACP 工具调用 → `tool/call` · `tool/result`**

**问题**：`AcpTurnRunner.onAcpUpdate` 收到 `tool_call` / `tool_call_update` 后只塞进
`this._pendingToolCalls`，**从不 append 会话事件** → 会话日志里没有 `tool/call` / `tool/result`，
工具调用无法在轨迹里体现（P1 观察到的工具调用其实是引擎侧行为，未经我们桥接）。

### 契约（session/src/types.ts:361-385）

```
'tool/call'   : { turn, step, callId, name, arguments }     // log-only，无 surfaceOp
'tool/result' : { turn, step, message: ToolResultMessage }  // **surface event**，需 surfaceOp
```
字段对应取反自官方 ACP 桥（`packages/acp/acp/src/updates.ts:52-85`，DSH→ACP 方向）：
`title ←→ name`、`rawInput ←→ arguments`（JSON 字符串）、
`status: failed ⇒ isError: true`、`status: completed ⇒ 正常`。

### 改动（`lib/acp-agent.js`）

- `onAcpUpdate` 的 `tool_call` / `tool_call_update` 两分支统一走 `_onToolCallUpdate()`。
- `_onToolCallUpdate()`：按 `toolCallId` 记账；**首次见到即落 `tool/call`**，
  **终态（completed/failed）各落一次 `tool/result`**；未见过的 callId 先补 `tool/call`
  （保证 result 必有配对的 call）。`tool/result` 带 `{ surfaceOp: 'append' }`。
- **缓冲落盘**：tool 事件在 prompt 期间只进 buffer，待 `_promptOnce` 落完
  `assistant/message` 后、`step/end` 之前统一 flush —— 保证会话顺序为
  `assistant/message → tool/call·tool/result → step/end`（而非 tool 先于 assistant）。
- `_bridging` 仅在 prompt 期间为 true：turn 外的迟到 update 不桥接（记 debug）。
- 新增 `acpToolContentToBlocks()`（ACP `content`/`diff` → DSH 文本块；`image` 降级占位；
  无内容时回退 `rawOutput`）与 `safeJsonString()`（`arguments` 必须是字符串）。

### 状态

🟡 **已接线，待运行时验证**：需一次会产生工具调用的 ACP 会话，检查会话事件里是否有
`tool/call` 落盘 —— **这是"只有我们的路径才会产生的副作用"**（见 CHANGELOG 0.1.4 附注的教训）。

---

## 0.1.6 — 2026-10-08 🟡 **A2 接线：ACP `session/request_permission` → DSH `approval` 服务**

**目标**：把外部引擎的授权请求路由到 DSH 的 `ctx.approval`，由 DSH UI 回答。
此前 `AcpClient` 的 `onPermission` **默认一律拒绝**，且 `AcpHost._onPermission` 从未赋值 →
引擎的写操作会**静默失败**。

### 契约（`@deepseek-ai/dsh-user-approval`，已在本机 0.2.0-rc.2 asar 逐字核实）

```
ctx.approval.request({ agent, toolName, callId?, reason?, signal? })
  : Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
```

- 服务名 `'approval'`（`class ApprovalService extends Service { super(ctx, 'approval') }`）。
- **硬前置：必须在一个已打开的 turn 内调用** —— `hasOpenTurn(session)` 反向扫日志，
  最后一个是 `turn/start` 才算开。权限请求发生在 prompt 期间，满足该前置。
- `'never'` 策略直接返回 `'rejected'`；无 answerer / answerer 抛错 → `'unavailable'`（fail closed）。
- 官方 ACP 桥（服务端方向）的映射可作参照：`packages/acp/acp/src/index.ts:155-173`。

### 改动

- **`lib/acp-host.js`**：新增 `_dispatchPermission(params)` —— ACP 进程**按引擎共享**，
  权限请求必须按 `params.sessionId` 路由到对应会话的 handler；找不到 / 抛错 → `cancelled`。
  原来的 `onPermission: (p) => this._onPermission?.(p)`（`_onPermission` 从未赋值）改为走该路由。
- **`lib/acp-agent.js`**：
  - `createAcpAgent` 用 `readApproval(rootCtx)`（`ctx.get('approval')` + 解包，**不 inject**
    以保持可选）取宿主权限服务，连同 `agent` 一起交给 runner。
  - `AcpTurnRunner.onAcpPermission(params)`：构造 `ApprovalRequest`（`agent`/`toolName`/`callId`/`signal`）
    调用 `approval.request()`，再用 `mapApprovalToAcp()` 把结果映射回 ACP 响应。
  - `mapApprovalToAcp()`：`allowed-once` → 选中引擎给的 **allow** 选项（优先 `allow_once`，
    **绝不替用户选 `allow_always`**）；`rejected`/`unavailable` → 选中 **reject** 选项；
    其余/无匹配 → `{ outcome: 'cancelled' }`。任何异常 fail closed。
- `assertAgentContract` / 自检：无新增必选符号（`approval` 保持可选）。

### 状态

🟡 **已接线，待运行时验证**：需要一次真实 ACP 会话中触发写操作，观察 DSH 是否弹出权限提示。
（若宿主未挂 answerer，会得到 `unavailable` → 我们的策略是**拒绝**并记日志，绝不擅自放行。）

---

## 0.1.5 — 2026-10-07 ✅ **A5/A6/A7 三个运行时契约定案 + 修复阻断性 surfaceOp 缺陷**

**背景**：ROADMAP §A 的 7 项里，A5/A6/A7「读源码就能定」。本轮读**官方 TS 源码**
（本地稀疏克隆 `refs/harness`）并用**本机 0.2.0-rc.2 的 app.asar** 逐字复核后定案。
证据：[`docs/evidence/A5-A7-contract-resolutions.md`](docs/evidence/A5-A7-contract-resolutions.md)。

### 定案结论

| # | 契约 | 结论 |
| --- | --- | --- |
| A5 | `TurnEndReason` union | `completed` / `aborted(reason)` / `blocked` / `error(error)` / `max-tokens` / `interrupted` / `forked`。**不存在 `end-turn`** |
| A6 | `UserMessage` | 身份字段是 **`id: MessageId`**（不是 `messageId`）；`content` 是 `ContentBlock[]`，文本块 `{ type:'text', text }` |
| A7 | `agentPresets.mount` | `mount(ctx: Context, id?: string): Promise<AgentPreset>`；**`ctx` 必须是 scoped context**，否则抛 `requires a scoped context` |

### 🔴 顺带发现并修复：`surfaceOp` 是硬要求（阻断一切 append）

`user/message` · `assistant/message` · `tool/result` 属于 `SurfaceEventType`；
`Session.append` → `surfaceOpOf()` 会抛
`"… is surface-eligible and requires a surfaceOp marker"`。
**已在 0.2.0-rc.2 的 app.asar 中逐字核实** `SURFACE_EVENT_TYPES` 与该校验。
修复前 `lib/acp-agent.js` 对 `user/message` / `assistant/message` 都没传 surfaceOp →
**正常 ACP turn 会在 append 处直接抛错**（这也解释了此前"看起来能跑"与源码状态之间的矛盾）。

### 代码改动（`lib/acp-agent.js` · `lib/dsh-imports.js`）

- **A5**：`_runTurn` 按 `completed` / `aborted(reason)` / `error(LlmFailure-ish)` 记 `turn/end`；
  `cancel()` 记录取消原因，`stop()` 缺省 `{ kind:'disposed' }`；新增 `_errorText()`（`errorChain` 优先）。
- **A6**：`extractText()` 只取 `type==='text'` 块（**`reasoning` 也是 `{ text }` 形状，绝不回灌**）；
  inbox `replace`/`remove` 改为按 `message.id` 匹配。
- **§4**：`user/message` / `assistant/message` append 补 `{ surfaceOp: 'append' }`；
  `assistant/message` 改用 `createAssistantMessage({ content, source:{provider,model} })` +
  官方 `AssistantStreamAccumulator` 生成合法 `stream`（此前传入 string 与自定义 stream 形状，均不符契约）。
- **A7**：用 `createScope(rootCtx, agent)` 得到 **scoped** `agent.ctx`（照 agent-loop agent.ts:130-131），
  并在发布链外显式 `scope.dispose()`；**补齐 `options.setup(agent.ctx, agent)` + `commit()` 调用**
  （官方组装点，此前完全没调）；宿主未挂 preset 时后备 `mount(ctx, id?)`。
- `dsh-imports.js`：自检符号补 `AssistantStreamAccumulator`。
- **附带修正**：`_runTurn` 的 `step` 改为**按 turn 重置**（本 driver 每 turn 一个 step，恒为 1）。
  早先前跨 turn 单调递增，与 `turn/start` 把 `nextStep` 置 1 的约定冲突（开启 session-invariant 时会报错）。

> ⚠️ 安装提醒：本轮改了 `package.json`（版本号）→ 需 `cd <profile>; pnpm install` 后再重启，
> 以插件页版本号 `v0.1.5` 确认加载。

---

## 0.1.4 — 2026-10-07 ✅ **P1 端到端跑通（里程碑）**

**结果**：插件页显示 `v0.1.4 · 运行中`；「设置 → Agent 预设 → 自定义」出现三个预设
（`acp-omp` / `acp-opencode` / `acp-commandcode`）。

### P1 出口条件逐项验收

| 条件 | 状态 | 证据 |
| --- | --- | --- |
| 插件能被加载 | ✅ | 插件页 `v0.1.4 · 运行中` |
| 预设注册到官方 UI | ✅ | 三张卡片出现在「设置 → Agent 预设 → 自定义」 |
| **会话能由外部 ACP CLI 驱动** | ✅ | `omp` 会话完整轨迹：初始化提示词 → 用户消息 → 助手思考 → 多轮工具调用 → 结果 |
| **走的是 ACP 路径，而非静默降级** | ✅ | **`omp.exe` 子进程存活（PID 24700）** —— 决定性证据，排除了"工厂 catch 后 fallback 到官方 loop"的可能 |
| 两个引擎都可用 | ✅ | `omp` 与 `Command Code` 各跑通一个会话 |
| 流式与用量反馈 | ✅ | 125 tok/s · 163k tok · 缓存命中 64% · ~$0.02 |

### 顺带验证了进程生命周期设计

`Command Code` 会话结束超 30 秒后其进程已消失 —— 与 `idleDisposeMs: 30000`
（空闲回收）的设计意图一致。**一个引擎一个共享进程、按空闲回收**的策略在真实使用中成立。

### 附：验证方法上的一次教训

"看起来能用"不等于"走的是我们的路径"。若不查子进程，很容易把
**降级到官方 factory 的结果**误判为成功 —— 因为我在 `MultiAcpFactory` 里加了
catch-and-fallback 的安全兜底。**验证时必须找到"只有我们的路径才会产生的副作用"**
（此处是 ACP 子进程），而不是只看最终输出。

**根因（两个 bug 叠加，后者掩盖前者）**：

1. **致命**：异常分支里的 `JSON.stringify(originalSlot)` —— `originalSlot` 是 **Cordis traced 代理**，
   `JSON.stringify` 会读它的 `.toJSON`，而 Cordis 对未声明 inject 的属性**直接抛错**：
   ```
   Error: cannot get property "toJSON" without inject
       at JSON.stringify
       at index.impl.js:163:69
   ```
   结果是"防御性错误信息自身崩溃"，插件恒定「启动失败」，**真正的故障条件被完全掩盖**。
2. **被掩盖的真因**：`typeof originalSlot?.target !== 'function'` —— 官方类型里
   `AgentFactory` 是**带 `createAgent`/`resume` 方法的对象，不是函数**，
   导致正常情况被误判为异常，进而走进上面那个会崩的分支。

**修复**：

- 新增 `describeShape()`：只读自有属性名与 `typeof`，**绝不 `JSON.stringify` Cordis 代理**
- 守卫改为检查 `target` 是否为**带 `createAgent`/`resume` 的对象**

**新增诊断架构（建议长期保留）**：

- `lib/index.js` 改为**薄加载器**：静态声明 `name`/`inject`，用**动态 `import()`** 加载
  `lib/index.impl.js`（真实实现）
- 原理：Cordis 静态 import 时模块求值期的抛错**无法捕获**，插件只会静默「启动失败」；
  动态 import 的错误是**可捕获的 Rejection** → 把 `error + stack` 写进
  `<DSH_HOME>/multi-acp/load-report.txt`
- 配套"最小桩 + 二分法"：桩不含自家 import，`apply()` 直接写标记文件，
  从而把"包清单问题 / inject 问题 / 模块问题"逐层分离

**顺带确认（本轮二分法的副产物）**：

- `inject: ['agents','agentPresets','sessions','commands']` 四个服务名**全部有效**
- 插件的包入口 / `dsh` 字段 / `dsh.profile.bundles` 注册**均无问题**

---

## 0.1.3 — 2026-10-07

- 移除 `lib/preset-marker.js` 的 `schemastery` 依赖（它处在 `acp-agent.js` 的 import 链上，
  而 0.1.1 只清理了 `index.js`，漏了这条链）
- **结果**：仍「启动失败」→ 说明 `schemastery` 不是（唯一）原因

## 0.1.2 — 2026-10-07

- 添加诊断用最小桩（`inject: []`，`apply()` 写标记文件）与 `lib/index.full.js` 备份
- **结果**：桩能加载 → 证明包清单/入口没问题

## 0.1.1 — 2026-10-07

**目标**：消除最可能的两个"加载期抛错"，让插件从「启动失败」变成可加载。

- **移除 `schemastery` 构造的 `Config` schema**，改为 `DEFAULT_CONFIG` 常量 +
  `normalizeConfig()`。
  理由：宿主用的是 `@deepseek-ai/schemastery`，与公开 `schemastery` 未必同源；
  而 `Schema.object` / `Schema.array(Schema.any())` 是**模块求值期**最容易抛错的一环。
  Cordis 允许插件不带 Config。
- **ACP SDK 改为惰性加载**（`loadAcp()`，用时才 `import '@agentclientprotocol/sdk'`）。
  理由：加载期任何顶层 import 失败都会让整个插件「启动失败」，
  而 SDK 只在开 ACP 连接时才需要。

**状态**：仍未确认是否解决 `启动失败`（UI 未见变化，需重启后看版本号确认）。

---

## 0.1.0 — 2026-10-07

首个版本。P1 骨架。

- `lib/engines.js` — 引擎注册表（数据行）：omp / opencode / commandcode，参数全部本机实测
- `lib/acp-client.js` — ACP 客户端（官方 SDK）
- `lib/acp-host.js` — 每引擎一个共享进程宿主 + 按 sessionId 分发 update
- `lib/acp-agent.js` — Agent 工厂 + Agent 实现 + Inbox + Turn runner
- `lib/preset-marker.js` / `lib/preset-ids.js` / `lib/dsh-imports.js`
- `lib/index.js` — 插件入口（替换 `agents.factory` + `agentPresets.register`）
- `tools/` — install / rollback / register-bundle / restart-and-capture

**已知问题**：在 DSH Desktop 上显示「启动失败」。
