# ACP 接入 × DSH Preset 可配置面 · 集成分析

> 目的：说清「外部 ACP 引擎接入后，DSH 侧到底还能配什么」，以及 preset 工具面在 ACP 路线下的真实行为。
> 方式：只读分析 + 代码定位，不改动任何 preset / 代码。
> 证据等级沿用 DESIGN.md §0：✅实测（读本机源码/运行）/ 📖参考（读第三方源码未本机复现）/ ❓未验证。
> 关联：不足清单见 [ISSUES.md](./ISSUES.md)，总体设计见 [DESIGN.md](./DESIGN.md)，引擎能力矩阵见 [ENGINE-SPEC.md](./ENGINE-SPEC.md)。

---

## 1. 三条正交轴（务必分清）

| 轴 | 含义 | 取值示例 | 由谁决定 |
| --- | --- | --- | --- |
| **provider** | 模型供应商 | commandcode / opencode-go / deepseek | DSH 原生会话里由 preset/config 选 |
| **engine / harness** | 驱动会话的 agent 运行时 | 官方 dsh-agent-loop / 外部 ACP CLI | 本插件把它换成外部 CLI |
| **preset** | DSH 的 agent 行为组合（工具/委派/规划/persona） | 默认 / 各 `acp-*` | `agentPresets.register/select` |

**本插件只动了 engine 轴**（把根 agent 换成外部 ACP CLI）。provider 与 preset 两轴在 ACP 路线下被大幅削弱，原因见 §4。

MEMORY.md 实测佐证（原生路线）：DSH 的工具面**按会话 preset 分配，不是全局特性**——同一机器上不同 preset 的会话有/无 shell、文件读写、MCP 各异；task-board 卡片继承创建它的会话的 preset。这条只对**原生 loop** 成立，ACP 路线另说。

---

## 2. ACP 接入链路：五个接入点（代码位置）

| # | 接入点 | 代码 | 状态 |
| --- | --- | --- | --- |
| ① | 替换 `agents.factory`（换引擎本体） | [index.impl.js:204](../lib/index.impl.js) `agents.factory = { target: new MultiAcpFactory(...) }` | ✅ 含形状护栏 `describeShape`（防对 Cordis traced 服务 `JSON.stringify` 崩溃）；保存官方 factory 作 fallback |
| ② | 程序化注册 preset | [index.impl.js:111-120](../lib/index.impl.js) `presets.register({ id, name, description, order, plugins })` | ✅ register schema 已从 asar 逐字核实（P0 §2.3）；`resolvedRoots` 在 0.2.0-rc.2 已移除 |
| ③ | ACP 进程宿主（每引擎一进程、多会话复用、空闲回收） | [acp-host.js:121](../lib/acp-host.js) `openSession` / `:129` `resumeSession` | ✅ 三家探针均「同进程两次 session/new」成功 |
| ④ | 事件桥：ACP `session/update` → DSH 会话事件 | [acp-agent.js:900-979](../lib/acp-agent.js) | ✅ 契约已核实；🔴 运行时未验证（§5） |
| ⑤ | 权限桥：ACP `session/request_permission` → DSH `approval.request` | [acp-agent.js:1008-1036](../lib/acp-agent.js) | ✅ 已接线；无 approval 通道时 fail-closed 拒绝 |

---

## 3. Preset 在 ACP 路线下的真相：一个 marker 空壳

注册每条 `acp-*` preset 时，`plugins` 数组**只放了一行**：

```js
// index.impl.js:118
plugins: [{ name: 'dsh-multi-acp/preset-marker', config: { engineId: engine.id } }]
```

- `preset-marker`（[preset-marker.js](../lib/preset-marker.js)）用 WeakMap 给 agent 打 `engineId` 标记，**不发布任何服务**（刻意规避 isolate-realm 审计错误）。
- 因此从 DSH 视角，三条 `acp-*` preset 几乎不含工具/委派/规划/persona —— 它们在 GUI 卡片上的「卖点」文案实际来自 `engine.description`（[engines.js](../lib/engines.js)），**不是 preset 真配了能力**。

---

## 4. DSH 侧对 ACP 会话「真正可配」的三样

| 可配项 | 入口 | 说明 |
| --- | --- | --- |
| **选哪个引擎** | `agentPresets.select(agent, presetId)`；会话选定 `acp-<id>` | 官方负责锁门与并发（DESIGN §7 D5：会话开始后不可切引擎） |
| **进程启动参数** | `<stateDir>/engines.json`（`PUT /multi-acp/engines/:id`） | command / args / env / resolvedCommand / enabled / sortOrder；`commandOverrides.windows` 是本机路径（ISSUE-02） |
| **透传哪些 MCP servers** | `openSession({ mcpServers })`（管道已就绪，见下） | **当前未填**，缺的是 acp-agent 一侧 |

### 4.1 mcpServers 管道其实已经预留（关键订正）

调用链逐环确认（✅实测读码）：

```
acp-agent.js:399/408   host.openSession({ dshSessionId, cwd })      // ← 未传 mcpServers
acp-host.js:121        openSession({ dshSessionId, cwd, mcpServers = [] })
acp-host.js:123        client.newSession({ cwd, mcpServers })
acp-client.js:216      newSession({ cwd, mcpServers = [] })
acp-client.js:219      connection.newSession({ cwd, mcpServers })   // ← 真下发到 ACP 协议层
```

**结论**：ACP 协议原生支持 `session/new` 携带 `mcpServers`，且本插件的 host→client→connection 三层管道**已打通**；唯一缺口是 [acp-agent.js:399/408](../lib/acp-agent.js) 调用 `openSession` 时没把 DSH 会话的 MCP 配置读出来填进去。这是「让外部引擎吃到 DSH 工具/资源」最短、最正的一条路——补上 acp-agent 一处取值即可（前提：三家引擎真的支持 `session/new` 的 mcpServers 字段，❓未验证，见 §5）。

### 4.2 工具供给方向是「反向」的

原生路线：preset 插件行**把工具注入给** loop（DSH → 引擎）。
ACP 路线：外部 CLI 自带工具，其 `tool_call` 被**回显成** DSH 的 `tool/call`·`tool/result` 事件（引擎 → DSH，[acp-agent.js:950](../lib/acp-agent.js)）。

→ DSH 侧对 ACP 会话的工具只能「显示/审计」，**不能「供给/约束」**。原生 preset 的工具面、委派、规划、persona 对 ACP 会话不生效。

---

## 5. 能力协商与运行时验证缺口

### 5.1 Client 向 agent 声明的能力（✅读码）

```js
// acp-client.js:189
fs: { readTextFile: false, writeTextFile: false }   // ← DSH 这个 ACP client 不 advertise fs
```

- `readTextFile`/`writeTextFile` 回调（acp-client.js:47/53）只是**兜底 + 警告**：能力没声明，正常引擎不应调；真调了会 `logger.warn('fs support was NOT advertised')` 并返回空/`{}`。
- 这修正了「fs 回调静默 no-op」的说法：更准确是**能力层就没开**，把引擎的文件读写挡在外面。
- `requestPermission`（acp-client.js:42）是 client 侧实现的权限回调，agent 发 `session/request_permission` 时进入，再转 §2⑤ 的 approval 桥。

### 5.2 未验证的运行时面（🔴）

4 个探针里 `clientCallbacks` 全空、`errors:[]`，即以下从未在真实往返中触发：

| 面 | 影响 | 关联 |
| --- | --- | --- |
| 权限弹窗（A2） | 默认 fail-closed 拒绝 → 引擎写操作**静默失败** | ISSUE-04 |
| fs 读写 | 能力未 advertise，文件读写被挡 | §5.1 |
| `tool_call`/`plan` 流事件（A1） | 外部引擎工具能否正确回显未证 | ISSUE-04 |
| `session/cancel`（A3） | 取消语义未证 | ISSUE-04 |
| mcpServers 是否被三家引擎接受 | §4.1 扩展点的前提 | 新 |
| 各引擎原生 skill 目录 / DSH skill 持久可读路径 | §6 路径 D 的前提 | ✅ 已坐实（§6.1：三家均认 `~/.agents/skills`，DSH 现状已落该目录） |
| ACP 会话下引擎 skill 发现 + skill 工具回显（A1） | 路径 D 在 ACP 路线的**真正**缺口 | ❓未跑过真实 ACP 往返 |

---

## 6. Skills 的搬运：AionUi 用「路径 D」，不是协议透传

承接 §5：DSH 的 skill 是 harness 私有的 prompt 注入（靠 `skill` 工具按需读 `SKILL.md`），**ACP 协议里根本没有 `skill` 字段**（与 mcpServers 不同——mcpServers 是 `session/new` 的一等字段，见 §4.1）。所以 skill **不能像工具那样走协议透传**。

AionUi 实际用的这条路（既非塞 prompt、也非包成 MCP）：

> **把选定 skills 通过 symlink / junction 物化进每个引擎「自己原生会扫描的 skill 目录」，由引擎用它本就有的 skill 机制加载。可见性走文件系统约定，不走 ACP。**

四条候选搬运路径（记 A/B/C/D）：

| 路径 | 做法 | 代价 / 前提 | 语义保真度 |
| --- | --- | --- | --- |
| A. prompt 注入 | 发 prompt 前把选定 skill 正文拼进首条 user message | 最轻；丢失「按需加载」，外部引擎只当一段输入 | 低 |
| B. 包成 MCP server | 把 skills 做成 http/sse 型 MCP，走 §4.1 `mcpServers` 透传 | 依赖引擎 mcp 能力（omp={http,sse}、opencode/commandcode={http}、均无 stdio）；「按需读全文」要改成 MCP resource 粒度 | 中 |
| C. 反向可见 | 让 DSH 看到外部 CLI 自己的 skills | 不可行：ACP preset 是 marker 空壳，外部引擎 skill 加载对 DSH 不暴露 | — |
| **D. 文件系统物化** | skill 目录 junction 进各引擎原生 skill 扫描目录（AionUi 做法） | ✅ 三家实测均认 `~/.agents/skills`（见 §6.1），DSH 现状已落该目录，近乎零搬运；剩 ACP 往返未验证 | 高 |

证据（外部，按 AionCore/AionUi 公开资料）：
- **AionCore 物化层**：Skill Service 把内置/用户/外部 skills 统一进中央仓库，需要时用 `materialize_skills_for_agent` 以 Symlink（Windows 上 Junction）**链接**进 agent 工作区，源真相留在中央、不复制。
- **AionUi 映射层**：每个 ACP backend 在 `ACP_BACKENDS_ALL` 带一个 `skillsDirs` 字段（原独立 `AGENT_SKILLS_DIRS`，见 AionUi issue #1911→#1913 合并为单一数据源），指向该 CLI 原生读 skill 的目录（如 `~/.claude/skills`、`~/.agents` 一类约定位置）。
- **厂商能力 vs 用户偏好的边界**（本插件 ENGINE-SPEC §1 已记此原则）：AionCore 的 `CustomAgentAdvancedOverrides` 仅 4 字段，含 `native_skills_dirs`（用户可指定引擎的 skill 目录）与 `skill_delivery`；后者被一个专门测试钉死为「厂商能力声明，由 registry/probe 决定」，**禁止从用户侧设置**。

### 6.1 三家引擎原生 skill 目录 · ✅ 本机实测（2026-10-08）

上一版列的两道「未证实的坎」，现已逐一坐实，结论**比预期更省**——三家都认一个跨 agent 通用约定目录 `~/.agents/skills`：

| 引擎 | 原生 skill 发现 | 证据 |
| --- | --- | --- |
| **omp** | 全局 `~/.agents/skills`（+ 项目 `./.omp/agents`） | `omp skill list -g` 返回的 120 项 = 本会话 DSH 技能全集（agent-reach / arkcli-* / dingtalk-* …，逐条吻合）；help 有 `--no-skills`、`--skills=<glob>`、`omp skill` 子命令 |
| **OpenCode** | 官方明列 6 源，含**全局 `~/.agents/skills/<name>/SKILL.md`**（另 `~/.config/opencode/skills`、`~/.claude/skills` 及各项目级） | [opencode.ai/docs/skills](https://opencode.ai/docs/skills/) 中文页原文「全局代理兼容：`~/.agents/skills/<name>/SKILL.md`」；按需 `skill({name})` 工具加载 |
| **Command Code** | 自有 `~/.commandcode/skills`（实测存在，内容与通用约定高度重合）**＋ `--skill <path>`（可重复，接受单目录或目录的目录）** | help 原文 `--skill <path> Load extra skills from a path`、`--no-skills`、`cmd skills`、`/skills`；另有 `/import [claude\|codex\|cursor\|pi\|opencode\|gemini]` 直接导入他方 skills |

DSH 侧 skill 的持久路径也坐实：就在 **`C:\Users\29096\.agents\skills`（120 个子目录）**，是稳定磁盘路径，不是只在内存物化——「外部进程读不到持久 skill」这条担忧被推翻。

**推论**：路径 D 对这三家近乎「零搬运」。只要 skill 落在 `~/.agents/skills`（DSH 现状已如此），omp / OpenCode 原生就会发现，Command Code 可经 `--skill ~/.agents/skills` 显式挂载。`agent-sync` 插件（本机已装 `dsh-agent-sync`）正是把 skill 同步进这类通用目录的现成机制。

> 🟢 **2026-10-09 傍晚：ACP 特定的那一环已实测（`tmp\probe-mcp-engine.mjs` 直连三家 ACP 会话）**
>
> | 引擎 | ACP 会话下的 skills | 实测证据 |
> | --- | --- | --- |
> | **omp** | ✅ **零配置生效** | 问"列出你能用的 skills"→ 回答的前 20 个 = `C:\Users\29096\.agents\skills` 的 119 个（`agent-browser, agent-reach, archify, arkcli-*…`，逐条吻合）；再要求"加载 `agent-reach`"→ 引擎发起 `skill_call`（`tool_call: "Loading agent-reach skill"`, `rawInput={"path":"skill://agent-reach"}`）并**准确引用其真实描述**（"MUST USE when user wants to 调研/research/…"） |
> | **Command Code** 1.76.0 | ✅ **需显式挂载**：`args: ["acp", "--skill", "C:\\Users\\29096\\.agents\\skills"]` | 加 `--skill <dir>` 后 ACP 会话上报 129 个命令；要求加载 `agent-reach` → 发起 `activate_skill{"name":"agent-reach"}` 并引用真实描述（"16 平台、多后端…"） |
> | **OpenCode** 2.0.23 | ✅ 官方明认 `~/.agents/skills`（未跑模型回合，见下） | `session/new` 接受；prompt 被 `Insufficient account funds` 挡住 ⇒ 引擎侧发现未观察到 |
>
> 同一次 omp 往返里还顺带验到 **A1 回显可用**（6 条 `tool_call`/`tool_call_update` 被我们拿到）——
> §5.2 遗留的"「没调工具」vs「调了看不见」"从此刻区分。
>
> **可操作的落地配方**
> - 通用（omp / OpenCode）：**什么都不用做** —— 保证 skill 落在 `~/.agents/skills`（DSH 现状已如此）。
> - Command Code：在引擎行加参数即可（无需改代码；UI「覆盖启动方式 → args」也能填）：
>   ```jsonc
>   { "id": "commandcode", "args": ["acp", "--skill", "C:\\Users\\29096\\.agents\\skills"] }
>   ```
> - 三家都不需要"协议级透传"：ACP **没有** skills 字段，共享靠的是**磁盘数据**而非协议
>   （与 §6.2 的工具侧形成对照：实现类能力只能重新包成 MCP）。
>
> 🟢 **C1 观测（同日）**：引擎在 ACP 里上报命令/skill 走
> `session/update → available_commands_update`，此前被当 unknown update 丢掉；现在落进
> `lib/engine-runtime.js`，UI 诊断行显示「引擎命令/技能：N 个」（实测 omp 166 个、Command Code 129 个），
> 也可 `GET /multi-acp/engines/:id/commands` 直接取。

### 6.2 对照：工具为什么不能像 skills 那样共享（web_search 实例，本机实测）

用户观察到「ACP 会话里 web_search 之类的工具好像调不通」。这与 skills 能共享是**同一根因的两面**，但结论要修正——不是"所有工具都不能用"：

**根因**：skill 共享的是**数据**（`SKILL.md` 文件落 `~/.agents/skills`，各家引擎用自己的 skill 工具去扫读，不依赖 DSH）；而 DSH 的 `web_search` 是**运行时实现**（绑 DSH 的 `web` 服务 + provider 栈）。实现既无磁盘约定、ACP 协议也无 `tool` 字段，外部进程无法"扫到并继承"。所以**能不能搜网取决于引擎自己带不带**：

| 引擎 | 自带 web 工具? | 默认状态 / 开启条件 | 证据 |
| --- | --- | --- | --- |
| **omp** | `web_search` + `browser`（Puppeteer） | 需自配 provider key：EXA / Brave / Perplexity / Tavily / Firecrawl / TinyFish …（help 全列出） | ✅本机 help |
| **OpenCode** | `websearch` + `webfetch` | `websearch` **默认关闭**（隐私）；需 OpenCode provider 或 `OPENCODE_ENABLE_EXA=1`；用 `permission` 门控 allow/deny/ask | ✅[官方 docs](https://opencode.ai/v2/docs/websearch) |
| **Command Code** | 有；**headless 会 withhold 部分工具** | `--tools-all` 开全部 / `--tools-enable <names>` 按名开（ACP 即 headless 起，默认可能裁掉 web） | ✅本机 help |

> 即：在 omp ACP 会话搜不了，是因 **omp 侧没配 web key**，不是 DSH 没传；opencode/commandcode 默认关或被 withhold 同理。这解释了观察，也说明"工具不能共享"≠"工具不能用"。

**「DSH preset 能否声明/透传工具」——分两层，磁盘实证：**

- **层一（DSH 原生 preset）：能声明。** 直接看本机 `D:\Ecode\.dsh\.agent-presets\liangshen\agent.cordis.yml`——它就是逐行声明工具：`tool-web`(:358，即 web_search，还能 `config: fetch:false` 细配)、`tool-fs`(:168)、`tool-fs-search`(:170)、`tool-jobs`(:183)、`tool-skill`(:198)、`tool-todo`(:352)……这就是"preset 可配置工具"的真实含义，也是 `agentPresets.register({plugins})` 的正统用法。
- **层二（本插件的 `acp-*` preset）：不能透传，但**——⚠️ **2026-10-09 修正：仍必须声明工具行。**
  上一版写的"对 ACP 会话，preset 声明工具是无意义的"只对了一半，漏掉了**回落路径**：
  引擎没装 / 握手失败 / resume 时 preset 解析不到（ISSUE-09 实测：`factory.resume` 的
  `presetId` 恒为 `null`）→ 会话落到官方 agent-loop，此时 preset 的工具层就是**会话唯一的工具来源**。
  空壳 preset ⇒ 用户得到一个"没有 shell、没有文件系统"的会话（实测模型探到 `unknown tool "write"`）。
  所以现在的做法是：**声明原生工具行（`lib/preset-native.js`，抄官方 `standard` 的行）**，
  既能兜住回落路径，也不影响引擎路径（引擎不消费 DSH tools，多挂几行只是常驻插件）。
  "不能透传"依然成立：引擎不会因此获得 DSH 的 `web_search`/`fs` 实现。

**唯一能把 DSH 侧能力补给外部引擎的通道 = MCP**（把 `web_search` 包成 http/sse MCP server，经 §4.1 `mcpServers` 透传）。这与 skills 的路径 D 形成对称：**skills 靠"磁盘文件 + 各家自扫"共享（数据侧，近乎零成本）；工具靠"运行时实现"无法继承，只能重新包成 MCP 走协议（实现侧，实打实工程量）。**

> 诚实标注：`tool_call` 能否经 A1 桥回显进 DSH 事件流仍未跑过真实往返（§5.2）——"引擎没调工具"与"调了你看不见"是两种故障，需一次真实 ACP 会话才能区分。

---

## 7. 扩展点清单 —— **落地情况（v0.1.15 · 2026-10-09）**

| # | 扩展点 | 状态 | 落地位置 |
| --- | --- | --- | --- |
| 1 | 透传 MCP servers | ✅ **已落地**（引擎侧接受性待实测） | `lib/mcp-servers.js`：读 `<DSH_HOME>/storages/mcp_connector.json` → ACP `McpServer`；`session/new` + `session/load` 双通道；`mcp.include/exclude`、`engine.mcp` 收窄。UI 里有「MCP 随会话下发」下拉 |
| 2 | 搬运 Skills（路径 D） | 🟢 **已完成能做的部分** | (a) 原生侧随 preset 挂 `skill-filesystem` + `tool-skill`；(b) 引擎侧：三家本机实测都认 `~/.agents/skills`（§6.1），Command Code 可用 `args` 注入 `--skill`（数据行级，UI 的「覆盖启动方式」直接可填）；(c) **C1 回显**：`available_commands_update` 不再被丢，落进 `lib/engine-runtime.js` + UI 诊断行 + `GET /multi-acp/engines/:id/commands`。**真实 ACP 往返仍未跑** |
| 3 | preset 差异化 / 声明工具 | ✅ **已落地（且是必须的）** | `lib/preset-native.js`（`presetTools` 分组裁剪、`unsandboxedFs` 遮蔽）；理由见 §6.2 层二修正 |
| 4 | 能力徽章 + 降级 | ✅ 已落地（ISSUE-07） | `capabilities` 透传 + 客户端徽章；本轮再加**握手诊断行**（MCP 下发 / 引擎命令·技能 / 最近握手时间） |
| 5 | 权限模式映射 | ⛔ 未做 | 依赖 `session/set_config_option` 探针（ISSUE-05 已实测 omp/CC，OpenCode 未做） |

> 落地细节与实测数据：`docs/evidence/A10-preset-tools-mcp-2026-10-09.md`；
> 验收脚本 `tmp/verify-preset-mcp.mjs`（21/21）、`tmp/verify-ui.mjs`（38/38）。

---

## 8. 一句话结论

ACP 路线把「引擎」换成外部 CLI 后，**preset 的工具轴被反向化**：不是 DSH 把工具喂给外部引擎，而是外部引擎的工具调用被回显进 DSH 事件流。DSH 侧对一个 ACP 会话真正可配的四样——**选引擎、进程启动参数、透传的 MCP servers（v0.1.15 已落地）、以及回落时使用的原生工具组合（v0.1.15 已补齐）**；而委派/规划/persona 这些原生 preset 能力当前对 ACP 会话不生效，权限/工具/取消/mcpServers 桥接**仍未跑过真实运行时验证**（ISSUE-06）。**Skills 同样无 ACP 协议字段可透传**，现实做法是 AionUi 的路径 D——由引擎自己从其原生 skill 目录加载；✅ 实测三家均认通用约定 `~/.agents/skills`、DSH 现状已落该目录，故搬运近乎零成本；v0.1.15 又把「ACP 会话下引擎 skill 发现 + `skill` 工具回显」从**无观测**变成**可观测**（C1：`available_commands_update` + UI 诊断行），剩下的一步就是拿它跑一次真实会话。
