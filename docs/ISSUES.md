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

## 规范化一轮（2026-10-10）新记录的条目

> 来源：按官方 + 社区规范做的一轮合规核查与重构（v0.2.0）。条目编号接原有序列。

### 🔴 ISSUE-13 · `trace.log` 记录引擎工具调用**原标题**，其中含凭据明文

- **现象**：`<stateDir>/trace.log`（实测本机 307KB）把 ACP 引擎的工具调用标题**原样落盘**。
  实测内容里含 WeKnora 的 `mcp_jcYs9xt7…` token、`sk-8Nwp9HTD…` API key、
  以及账号邮箱 + **明文密码**（引擎自己的工具参数里带着它们）。
- **证据**：`D:\Ecode\.dsh\multi-acp\trace.log` 中 `acp.tool-call` 事件的 `data.title` 字段。
- **影响**：该文件在 `DSH_HOME` 下（**不在仓库里**，`.gitignore` 也挡不住它本身），
  但它是**本插件自己写的状态文件** → 属凭据泄露面。用户分享日志排查问题时必然泄露。
- **修复方向（未执行）**：① trace 只记**元数据**（工具名、耗时、字节数），不记标题正文；
  ② 对可能含值的内容做脱敏（token/key/密码形态）；③ 提供关闭开关（如 `trace: false`）。
  **优先级高于本文件其它条目** —— 它已经在真实产生泄露。

### 🟠 ISSUE-14 · 宿主包解析在**宿主外**指向旧版本线（已加护栏，未根治）

- **现象**：`profiles/node_modules/@deepseek-ai/*`（244 条）是指向**全局 npm 安装**的绝对路径
  链接 → 实测解析到 `dsh-agent/dsh-session/dsh-tools = 0.1.1-rc.2`，而宿主是 `0.2.0-rc.2`。
- **后果实例**：`probeHostSymbols()` 在裸 node 下报 `dsh-llm 缺 AssistantStreamAccumulator`
  —— **假阴性**（该符号在 0.2.0-rc.2 里由 `export * from './assistant-stream.ts'` 提供）。
  宿主内实测 `factory.createAgent.contract` = `ok:true` ×12/12，**真实会话不受影响**；
  受影响的是**验证工具本身的结论可信度**。
- **已做**：探测报告一律带 `resolved`/`version`/`expected`/`trustHost`；
  新增 `scripts/diagnose-host-resolution.mjs`（退出码 0/1/2 = 一致 / 不一致 / 无法判定）。
  见 ADR-0003。
- **未做（**建议先测量再决定**）**：不手工改那棵树（DSH 维护、40+ 插件共享）。
  待确认的是「宿主外到底谁在用它」。
- **潜在断点**：那棵树的链接**硬绑定到 `nvm\v22.20.0`**，而 active 是 `v24.21.0`。
  `nvm use` 换版本会让整棵树悬空 —— 这正是 `B0-ui-contract-findings.md` §5 曾记录的状态。

### 🟡 ISSUE-15 · 自带 patch 里的 `idleDisposeMs` / `disposeGraceMs` 是死配置（**已修**）

- **现象**：两者作为**插件级**配置写在 `cordis.patch.yml` 里，并带说明注释，
  但代码只在**引擎行**上读它们（`lib/engines.js` 的 `BUILTIN`、`lib/acp-host.js` 的
  `this.idleDisposeMs`）。没有任何地方读 `config.idleDisposeMs`。
- **影响**：用户在插件配置里改它们**毫无效果**，且以为生效了。
- **已修**：从 `cordis.patch.yml` 删除，并写明它们是**每引擎**参数、该去哪儿改。

### 🟠 ISSUE-16 · profile 的 patch **整体替换** config，使自带 patch 的调参在本机失效（**已修**）

- **现象**：profile 的 `cordis.patch.yml` 里是 `- id: multi-acp` **加**一份 config
  （实测内容仅 `{ defaultEngine: "", verboseStartup: true }`）。按官方语义，
  非 `insert` 的 patch 行**替换该 Entry 的整个 `config`**（不做深合并）。
- **后果**：自带 patch 里那套调参（含 A16 的 `promptTimeoutMs: 0 = 不限`）**在本机不生效**，
  实际用的是代码默认 `promptTimeoutMs: 300000` + `idleTimeoutMs: 180000`。
  也就是说 **A16 修的"墙钟误杀长任务"在本机被 profile patch 抵消了** ——
  而且没有任何地方会报错。
- **证据**：`D:\Ecode\.dsh\profiles\desktop\cordis.patch.yml:96-101` vs `cordis.patch.yml`。
- **根因**：`tools/install.ps1` 的 `[4/5]` 步**合成**了那份只含 2 个键的覆盖 ——
  它不是"只覆盖这两项"，而是把其余键清成代码默认值。
- **已修（2026-10-10）**：
  1. `tools/install.ps1` **不再写入**任何覆盖行；若已存在，则用新工具**逐键核对并告警**。
  2. 新增 `scripts/verify-profile-config.mjs`：按官方组合语义（整体替换）算出
     **实际生效的配置**，与 bundle patch 的意图逐键对比，并**区分**
     「profile 显式覆盖」（有意）与「profile 没写而被静默清掉」（就是本 ISSUE）。
     退出码 `0` = 无静默清掉；`1` = 有。
  3. 本机 profile 已按建议 ① 处理：备份为
     `cordis.patch.yml.bak-20261010011114.-issue11`，把覆盖行补成**完整 config**
     （保留其**有意**设的 `defaultEngine: ""`），其余字节逐字未变。
- **验证**：`node scripts/verify-profile-config.mjs` → **退出码 0**，
  只剩 `defaultEngine` 一项「显式覆盖」；用备份跑同一工具 → 退出码 1，
  精确报出 `promptTimeoutMs: 0 → 300000` 被静默清掉。
  即 **A16 现在真正生效了**。
- **注意**：`--dump-config` **无法**用来核对本 profile —— Host 自带 CLI 直接拒绝：
  `error: profile "desktop" is managed exclusively by the Electron application`。
  这是 ADR-0001 的直接证据，也是本工具存在的另一个理由。

### ⚠️ 更正 · `docs/evidence/B0-ui-contract-findings.md` §5 的「悬空 junction」结论

原文断言 `profiles/node_modules/@deepseek-ai/*` 是**悬空** junction（目标不存在），
并据此推出「host 包靠 asar 的 NODE_PATH 解析，普通 Node 解析不到」。

**实测（2026-10-10）不成立**：那些链接**有目标**，指向全局
`@deepseek-ai/dsh@0.1.1-rc.2` 自带的 `node_modules`（`cordis = 4.0.1`）。

不是原文错，而是**那棵树的内容会变** —— 它取决于"哪个 nvm 版本下装了哪个 dsh"。
正确表述应为：**"指向全局安装的绝对路径链接，内容随环境漂移；宿主内解析正确，
宿主外解析到旧版本"**。结论与处置见 ADR-0003。

### 🟡 ISSUE-17 · `createCallbackSink` 的 `rawLines` 是一个**半接线的诊断钩子**

- **现象**：`lib/acp-client.js` 的 `createCallbackSink({ …, rawLines })` 里有一句
  `rawLines?.recordCallback?.(String(prop), args)` —— 也就是说它期望一个
  **`{ recordCallback }` 形状**的对象。但调用方（`AcpClient#start`）从不传它，
  而 `AcpClient` 自己持有的是 `rawLines: string[]`（**形状不符**）。
- **后果**：那行永远是 no-op；"把引擎回调序列记进诊断"这个意图**从未生效**。
  这也解释了为什么 `AcpClient.rawLines` 只能靠另一条路径（line-reader）填，
  且 `capabilities().rawLineCount` 反映的不是回调数。
- **证据**：`lib/acp-client.js:40`（签名）、`:73`（唯一一处 `recordCallback` 引用）、
  `:97`（`this.rawLines = []`）、`:162`（另一条路径 push）。
- **性质**：**不是坏**，是"没做完"。当前被显式标为可选参数（类型检查通过），
  并在注释里写明了事实，不再假装它在工作。
- **修复方向（未执行）**：二选一 ——
  ① 接线：让 `AcpClient` 传一个 `{ recordCallback(name, args) { … push 进诊断 } }`，
     于是 `rawLines` 真的能反映引擎回调序列（对排查"引擎到底发了什么"很有用）；
  ② 删除：连同那个参数与那一行一起删掉（它是仓库里唯一引用 `recordCallback` 的地方）。
  **倾向 ①**，因为排查引擎异常时"引擎发过哪些回调"是高频需求。

### 🔴 ISSUE-18 · 诊断数据被自己的测试污染（**已修**）

- **现象**：`<stateDir>/trace.log` 里 13 个不同 pid 反复出现同一签名
  `install.factory-installed ×6 → install.factory-bad-shape → factory-empty → factory-restored`。
- **误判**：被读成"宿主返回了无法识别的 factory 形状"，进而考虑**放宽 `index.impl.js` 里
  "形状不对就拒绝替换"的保守策略**。
- **根因**：`lib/trace.js` 在**模块加载期**把路径定死为生产路径
  `D:\Ecode\.dsh\multi-acp\trace.log`，于是**任何用假 ctx 调 `apply()` 的测试/脚本都会写进用户的真 trace**。
  最典型的是 `test/plugin-smoke.test.mjs` 里一条**故意构造**的用例
  `ctx.agents.factory = { target: 'not-a-factory' }` —— 它在真机上读起来就是
  `install.factory-bad-shape {shape:"object{target:string(not-a-factory)}"}`。
- **证据**：① 把 `describeShape()` 补上"字符串带值"后，字符串现出原形 `not-a-factory`，
  且该字面量**只**出现在测试文件里；② 算术吻合：测试调 `apply()` 8 次 = 6 install + 1 bad-shape + 1 empty；
  ③ 出现该签名的 pid 最早在 `2026-10-09T22:46Z` = 本轮第一次跑 `npm test` 的时段，
  每跑一次测试多一个 pid。
- **结论**：**不放宽那条保守策略**。真机实际读数是
  `replaced: object{target:object}` / `replacedWasOurs: false` / `depth: 1`，
  即稳定读到官方 factory 的 traced 代理，**完全落在已知形状内**，没有"未知形状"这回事。
- **已修**：`lib/trace.js` 改为**每次调用**解析路径；`DSH_MULTI_ACP_TRACE`
  显式设为 `''`/`0`/`off` = 关闭；兜底**`node:test` 下绝不写默认路径**（`NODE_TEST_CONTEXT`）。
  `test/plugin-smoke.test.mjs` 显式关闭 trace。验证：`npm test` 后 trace **delta 0**。
- **长效规则（已写入 `AGENTS.md` §3）**：**任何用假 ctx 调 `apply()` 的脚本必须先关掉/重定向 trace。**
  诊断数据被自己的测试污染，比没有诊断更糟 —— 它会让你去修一个不存在的问题。

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
