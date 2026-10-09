# A10 — preset 原生工具组合 / resume 静默回落 / MCP 注入（2026-10-09）

> 触发：用户反馈四条 ——（1）引擎管理 UI 完善；（2）`dsh_multi_acp` 创建的 preset
> **没挂 DSH 原生 shell / 文件系统工具**，会话里报 `write{...} → FS_SANDBOX_DENIED`、
> `pwsh{...} → error`；（3）ACP 会话下引擎 **skill 发现与回显**；
> （4）**随 preset / 会话注入 MCP servers**。
>
> 本文件记录查证过程与实测数据；改动清单见 `CHANGELOG.md` 0.1.15。

---

## 0. 结论速览

| # | 用户判断 | 查证结论 |
| --- | --- | --- |
| 2a | preset 里没挂原生工具 | ✅ **成立**。`acp-*` preset 的组合只有 `preset-marker` 一行 → 该会话的 preset 层工具为空，只剩部署层插件工具。实测模型探到 `unknown tool "write"`。 |
| 2b | `write → FS_SANDBOX_DENIED` | ⚠️ **不是本插件造成的**，但确实由"没有工具"这条链放大。该报错来自宿主 `dsh-fs-sandbox`（workspace-write 模式下写工作区外路径被拒），发生在 `agentPreset=standard` 的会话里。 |
| 2c | `pwsh → error` | ⚠️ **宿主 sandbox 缺陷**：`dsh-sandbox-windows-acl` 在自己的工作目录上 `SetNamedSecurityInfoW failed (Win32 5)`。与 preset / 引擎无关。 |
| 附加 | —— | 🔴 **新发现（未在用户清单里）**：`factory.resume` 上 `presetId` 恒为 `null` → **每次重开会话都静默回落到官方 agent-loop**。这才是"acp preset 会话实际没在跑引擎"的机制。 |
| 3 | ACP 会话 skill 发现 / 回显 | 引擎的 `available_commands_update` 此前被当 unknown update 丢掉；现已捕获（`lib/engine-runtime.js` + UI 诊断行 + `GET /:id/commands`）。原生侧 preset 补了 `skill-filesystem`/`tool-skill`。 |
| 4 | 随会话注入 MCP | ✅ 数据源 = `<DSH_HOME>/storages/mcp_connector.json`；已接线到 `session/new` 与 `session/load`。引擎侧接受性待实测。 |

---

## 1. 用户报错的两处**原文出处**

在 `D:\Ecode\.dsh\sessions` 全量扫描 `FS_SANDBOX_DENIED` / `SetNamedSecurityInfoW`，
命中会话 `session-6634c37c`（项目 `--D-Ecode-研发管理-新闻追踪-娱乐新闻--`，
`agentPreset=standard`，cron 任务「每日AI资讯早报（10:00）」，provider `qoder-cn`）：

- 事件序 32：`tool/call write{file_path:"D:\Ecode\workspace\DSH_Desktop\_news\_aihot.ps1", content:"…"}`
  → `tool/result` 报 `[sandbox: file access denied under workspace-write mode]`。
  **会话 cwd = `D:\Ecode\研发管理\新闻追踪\娱乐新闻`**，目标文件在**另一个工作区** ——
  这条拒绝是 DSH 沙箱**按设计**给出的（`dsh-fs-sandbox`）。
- 事件序 50：`tool/call pwsh{command:"& \"D:\Ecode\研发管理\新闻追踪\娱乐新闻\_tmp_news\aihot.ps1\"", description:"Fetch AI HOT selected items last 24h"}`
  → `tool/result` 报 **`Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\Ecode\研发管理\新闻追踪\娱乐新闻)`**。
  同类错误在 `session-88c449e1`（`grantWrite(D:\Ecode\workspace\DSH_Desktop)`）也出现过 ——
  **`dsh-sandbox-windows-acl` 给工作目录授写权限失败（Win32 5 = ERROR_ACCESS_DENIED）**。

⇒ 这两条报错的会话都是 `standard` preset、原生 loop、工具**在位**，
与"preset 没挂工具"无关；但用户会同时看到它们，是因为他的 acp 会话**确实没有工具**
（下节），两条线索被合并成了一条印象。

## 2. 关键证据：`acp-*` 会话的 preset 层是**空的**

`session-144c11b2`（`agentPreset=acp-commandcode`，project `--D-Ecode-tools-Dsh_Plugins-dsh_multi_acp--`）：

- `request/header` 里共 **164** 个工具，全部是部署层插件工具
  （`browser_*` / `vision_*` / `zotero_*` / `mnemon_*` / `agent_sync_*` / `task_board_*` …），
  **没有** `read` / `write` / `edit` / `glob` / `grep` / `pwsh` / `skill` / `web_search` / `todo_write`。
- 模型的探索过程（原话）：

  > 「我没有 pwsh/bash，也没有 read/write」

  随后依次调用 `bash` / `read` / `write`，全部返回 `unknown tool`。

对照 `session-45e84066`（同为 `acp-commandcode`）：工具表 **215** 个且**含** `pwsh`/`read`/`edit`/`glob`/`skill` ——
该会话是先把 preset 设为 `standard`（拿到原生工具层）之后才切到 `acp-commandcode`，所以两种形态都见过。

⇒ 结论：**preset 层决定 DSH 原生工具，部署层决定插件工具**；
`acp-*` preset 如果只写 marker 行，agent 就真的没有 shell / 文件系统能力。

## 3. 机制证据：resume 路径上的 preset 是 `null`

`<stateDir>/trace.log`（`D:\Ecode\.dsh\multi-acp\trace.log`，2026-10-09 01:28–05:55，两个 pid）：

```
factory.createAgent {"presetId":"standard","engineId":null,"metaKeys":["cwd","agentPreset"]} → fallback-native
factory.resume     {"presetId":null,"engineId":null,...} → fallback-native   ← 每一次都是
```

`@deepseek-ai/dsh-agent/lib/types/index.d.ts`：

```ts
interface CreateAgentOptions { meta?: { agentPreset?: string; cwd?: string } ... }
interface ResumeAgentOptions { resumeSessionId: string; agentOptions?; signal?; setup? }   // ← 没有 agentPreset
```

⇒ 重开会话时工厂拿不到 preset，只能 fallback。而官方 loop 会按持久化的 `agentPreset`
（= 我们的 `acp-*`）挂 preset —— 以前那个 preset 只有 marker 行，
于是**用户得到一个既没引擎、又没工具的空壳会话**。

修复：`MultiAcpFactory._presetIdOf()` 在 resume 分支回落查
`<stateDir>/session-map.json` 的 `engineId`（该映射本来就有，是 A4 为 session/load 建的）。

## 4. 组合行从哪抄：官方 preset 是唯一权威

权威源：`@deepseek-ai/dsh/config/agent-presets/{standard,minimal,code,cordis}/agent.cordis.yml`
（本机 `C:\Users\29096\AppData\Local\nvm\v22.20.0\node_modules\@deepseek-ai\dsh\config\agent-presets`）。

- `standard/agent.cordis.yml` 252 行：persona / skill-filesystem + tool-skill / plan-mode /
  tool-pwsh|tool-bash / tool-fs + tool-fs-search / tool-jobs / tool-todo / tool-ask-user /
  tool-web / compaction(entry-local group) / tool-subagent 等。注释明确：
  「Both register into the host `tools` registry」、「confinement comes from the host policy，
  which records one canonical approval identity per tool name」。
- `minimal/agent.cordis.yml`：**用 `isolate: {fs:true}` 组**把 `dsh-fs-local` 与消费它的
  `str_replace_editor` 放进同一个 entry-local realm，注释原文：
  「The bare local filesystem shadows the host's sandboxed provider only for this preset.
  **The editor shares that realm and requires absolute paths.**」
  ⇒ `unsandboxedFs` 若只把 `fs-local` 单独放进组里是**无效的**，消费侧必须同组
  （`lib/preset-native.js#fsLocalGroup` 已按此修正）。

我们只抄"模型面向的工具行"，不抄 persona / plan-mode / compaction / delegation：
本插件的 preset 是**引擎入口**，不是第二套 standard；多抄一行就多一份挂载失败面。

## 5. MCP：数据形状与映射

`<DSH_HOME>/storages/mcp_connector.json` → `tables.connections`（本机 4 条，全部 enabled）：

| 连接 | transport | 关键字段 |
| --- | --- | --- |
| weknora | `streamable-http` | `url` + `auth:{mode:'bearer',bearerToken}` |
| chrome-devtools | `stdio` | `command:'npx'` + `args[]` |
| drawio | `streamable-http` | `url` + `headers:{Accept}` |
| dingtalk | `stdio` | `command` + `args[]`（`serverName=dingtalk-workspace`） |

ACP 侧形状（`@agentclientprotocol/sdk@0.25.1` `types.gen.d.ts`）：

```ts
McpServerStdio = { name, command, args: string[], env?: Array<{name,value}> }
McpServer = (McpServerHttp & {type:'http'}) | (McpServerSse & {type:'sse'}) | (McpServerStdio & {type:'stdio'}) | (McpServerAcp & {type:'acp'})
```

⇒ 必须做显式映射：`env`/`headers` **对象 → `[{name,value}]` 数组**、bearer token → `Authorization` 头。
别名集合 = `{ACP 名, name, serverName, serverKey, connectionId}`，
因为用户排除时写的是 `dingtalk`，而 ACP 名是 `dingtalk-workspace`。

治理边界：DSH 的 `tools.governance`/grants 是宿主审计层，ACP 没有对应字段 ⇒
注入即**全量可用**。默认全量继承 + 提供 `mcp.include/exclude` 与 `engine.mcp='none'`。

## 6. 验收（可复跑）

```
node tmp/verify-preset-mcp.mjs      # 21/21 PASS
node tmp/verify-ui.mjs              # 38/38 PASS
node --check lib/{preset-native,mcp-servers,engine-runtime,routes,engines,acp-agent,index.impl,client}.js
```

- `verify-preset-mcp.mjs` 的**逐条对照**是重点：它把 `nativeToolRows()` 产出的每个 `name`
  拿去和官方 `standard/minimal` preset 里出现过的模块名集合比对 —— 写错一个包名会让 preset
  挂载失败，这是本改动最容易犯的错。
- `verify-ui.mjs` 自带 mini-React（路径稳定的 hook + 同步重渲染），因此能**真的点按钮**，
  并对保存产生的 PUT body 做断言（`env.OPENCODE_TOKEN === null`、`args[2]` 含引号整段、
  `mcp === 'none'`）。

## 7. 下午续：三个"只有真跑才会出现"的缺陷（同一会话连着揪出来）

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| A10-1 | `factory.createAgent` 走到最后一步抛 `cannot get property "sessionProjections" without inject`，引擎都 spawn 了却回落原生 | 插件没（也不该）硬 inject 这个**可选**服务，却用了会抛错的 `ctx.xxx` 属性访问 | 改 `ctx.get('sessionProjections')`（与 `readApproval`/`readPersistence` 一致），`createAcpInbox` 本来就对 undefined 兜底 |
| A10-2 | 切换 preset 三个都报 `session "…" is already owned by an active write handle` → 会话卡死 | ① `ResumeAgentOptions` **没有 agentPreset**，切 preset 时 UI 只改 `session.agentPreset` 再 `resume`，而我们的 map 回落把**旧引擎**当目标（切到哪都还是 omp）；② 我们为该会话创建的 agent 还活着 = 仍持写句柄，而 `agents.resume()` 是**无条件转发**给工厂、没有"已有活 agent 就 attach"的分支 | ① `_presetIdOf()` 优先读活会话的 `session.agentPreset`（trace `factory.resume.preset-from-live`）；② 新增 `_live` 表 + `_disposeStale()`，在 create/resume **分支之前**释放本工厂旧 agent；③ `_diagnoseHandleConflict()` 记 `ours=` / `hostHasLiveAgent=` |
| A10-4 | **宿主进程崩溃**（两次，07:15:29 / 07:16:41）：`dsh: fatal load failure: Error: cannot get property "systemPrompt" without inject` at `dsh-experimental-tool-agent-team` 的 `install()`/`maybeInstall()` | `dsh-scope#createScope(ctx,key)`："the scoped context **inherits the minting plugin's dependency API**"。我们用 `createScope(rootCtx, agent)` 造 `agent.ctx`，而本插件 inject 里没有 `systemPrompt`/`tools`/`llm` → 别人按官方约定访问 `agent.ctx.systemPrompt` 直接抛，且**发生在插件装载路径上 → 宿主退出** | 插件 `inject` 与官方 AgentLoop 对齐：`['agents','agentPresets','sessions','commands','tools','systemPrompt','llm']` |

### 7.1 一句话经验

**替代官方 factory 时，我们造出来的 agent 必须在"依赖 API 面"上与官方 agent 完全一致**
（inject 对齐 + 用 `ctx.get()` 拿可选服务 + 自己开的写句柄自己关）。
差一个服务名，轻则该 agent 建不起来（回落原生），重则**别人插件一碰就崩宿主**。

### 7.2 修复后的实测（15:18 重启）

```
07:18:30.816 factory.resume {engine=omp, preset=acp-omp}
07:18:30.825 session.mcp {sid=e877352c, count=4}      ← 早先卡死的会话，MCP 4/4
07:18:33.169 acp.available_commands {engine=omp}      ← 引擎上报命令清单
（无 error-fallback、无崩溃；DSH pid 40828 持续存活）
```

## 8. 待查：ACP 会话「导出 session.log → HTTP 500」（2026-10-09 15:30）

**现象**：ACP 会话（`session-fb54ccef`，`agentPreset=acp-omp` → 用户又切到 `acp-opencode`）点导出，
UI 弹 `Session 导出失败 / Export failed: HTTP 500`。

**已定位的代码路径**（DSH 自带插件 `@deepseek-ai/dsh-session-log-export`，从 `app.asar` 取出，
见 `tmp/asar2.mjs`）：

- 客户端先发 **`HEAD /api/session.export?sessionId=…&includeDescendants=true`** 做探针，失败即弹这个提示（所以提示里没有细节）。
- 服务端 handler 的 500 只可能来自三处：
  1. `deps` 缺服务 → `session log export is unavailable`（与具体会话无关，先排除）；
  2. `flushLiveSessionLog()`：`deps.sessions.get(id)` → **`await deps.sessions.flush(session)`**
     —— `dsh-session#flush` 先 `liveEntryFor(session)`（**不是本 store 的 live entry 就抛
     `session "…" is not live in this store`**），再等 `session/flush` 回调；
  3. `readSessionLogText(persistence, id)` 读落盘日志。

**为什么怀疑与本插件有关**：这两条都要求"活会话 + 写句柄"状态自洽 —— 而 ACP 会话的
session/handle/agent 全是我们自己建的（本轮刚修了"切 preset 时释放写句柄"）。

**为什么还没定论**：无法复现 —— DSH 的 HTTP 路由要应用内 connection 鉴权
（外部 curl 试了 query/bearer/cookie/x-dsh-token 全部 `401 unauthorized`），
且当前实例没有开远程调试端口（CDP 9222-9224 都不通），进不了页面上下文。

**下一步（二选一即可）**：
1. **对照组**：导出一个 `standard` preset 的会话。若同样 500 → 是导出功能自身/DSH 侧问题；
   只有 ACP 会话失败 → 坐实是本插件，再按下面 2 抓栈。
2. 用 `--remote-debugging-port=9223` 重启（`tools/restart-and-capture.ps1` 保留原参数，加一个 flag 即可），
   我就能在页面里跑 `fetch('/api/session.export?...')` 拿到错误体/栈。

**顺带发现（同一份日志）**：`session-fb54ccef` 那次跑的是 omp 引擎（33 次 `tool/call` 都按 A1 回显了），
但 turn 以
`turn/end{reason:{kind:'error',error:{message:'acp[omp]: session/prompt: timed out after 300s'}}}`
结束 —— 即**我们桥的 300s prompt 超时**先炸了，需要单独排（要么阈值可配，要么看清楚是引擎没回还是被审批卡住）。
另外 `tool/call.name` 目前映射的是 ACP 的 `title`（如 `"Finding WeKnora base URL in configs"`），
语义上应是**工具名**，下轮把它改成真正的 tool name（title 另存）。

**结论（2026-10-09 16:2x，用 `--remote-debugging-port=9223` + CDP 在页面上下文里复现）**：

```
86ea4fda (acp-commandcode)  HEAD=200 GET=200
c65875d3 (acp-omp)          HEAD=500 GET=500 (session log export failed to read the stored log)
fb54ccef (acp-omp, 300s 超时那次) HEAD=500 GET=500 (同一条)
e859bb49 (standard)         HEAD=200 GET=200
e877352c (acp, 曾被写句柄卡死) HEAD=500 GET=500 (同一条)
c2601ea1 (回落原生的 acp 会话) HEAD=200 GET=200
```

- 服务端错误体明确：**`session log export failed to read the stored log`**。
- **不是日志损坏**：逐帧 zstd 解压 6 个会话，`frames ok == frames`（0 bad，`tmp\zcheck-frames.mjs`）。
- **不是本插件**：用户用 `standard` 会话对照也是 500（image-9），且 6 个样本里 ACP/standard/原生三种都有 200 有 500。
- **相关性 = 会话当前是否"live"**：
  * 500 的三个是用户当下**打开/正在用**的会话（`fb54ccef` 是 WeKnora 正在跑的、`e877352c` 是 15:18 刚被 resume 的、`c65875d3` 是当时新建的）；
  * 200 的两个大会话（`86ea4fda`/`e859bb49`）与 `c2601ea1` 都是**没打开**的。
  机制上说得通：`flushLiveSessionLog()` 只对 live 会话生效 —— `deps.sessions.get(id)` 拿到会话后
  `await sessions.flush(session)`；`dsh-session#flush` 先 `liveEntryFor(session)`
  （不是本 store 的 live entry 就抛 `session "…" is not live in this store`），
  或者 `session/flush` 回调抛 → 两者都被 handler 的同一个 catch 收敛成 500。

**⇒ 定性：DSH 自带导出功能对"当前 live 的会话"失败（与 preset/引擎无关）。**
**用户侧可用规避**：先把会话切走/关掉（或在重启后、打开之前）再导出；我这边也能直接解出日志
（`node tmp\zread-any.mjs <session.v4.jsonl.zstd> <out.jsonl>`）。
**要百分百钉死"live"这条**：把任意一个现在返回 200 的会话在 UI 里打开，再导一次 → 若变 500 即证实（我只差这一步，你 10 秒能验）。

## 9. 🟢 MCP 注入**闭环验证**（2026-10-09 16:34，preset=`acp-omp`）

任务 4 的最后一块拼图：不再是"映射正确 + 调用点已接线"，而是**引擎真的用上了注入的 MCP**。

**证据链（四条，互相独立）**

1. **下发**（`trace.log`，pid 41996，08:34:20Z）：

   ```json
   {"event":"session.mcp","data":{"engineId":"omp",
     "sessionId":"session-e877352c-…","count":4,
     "summary":"MCP：4 个 — weknora-dc328ba5(http), chrome-devtools(stdio), drawio(http), dingtalk-workspace(stdio)"}}
   {"event":"session.mcp.note","data":{"engineId":"omp","note":"继承 DSH MCP：4/4 个"}}
   ```

2. **引擎侧认了这批服务器**：omp 自己的会话目录里出现按 **我们注入的服务器名** 命名的工具日志
   （`C:\Users\29096\.omp\agent\sessions\--D-Ecode-workspace-DSH_Desktop--\2026-10-09T07-04-32-829Z_…/`）：

   ```
   0.mcp__weknora_dc328ba5_search_knowledge.log
   1.mcp__weknora_dc328ba5_search_knowledge.log
   ```

   注意 `weknora_dc328ba5` 正是 `lib/mcp-servers.js` 由连接的 `serverName`（`weknora-dc328ba5`）
   净化后给 ACP 的名字（omp 把 `-` 显示成 `_`）。

3. **DSH 会话轨迹里有调用与结果**（`session-e877352c`，10 次 MCP 调用 **10/10 成功**）：

   | seq | 工具（omp 的 `xd://` URI） | 结果（截断） |
   | --- | --- | --- |
   | 13 | `xd://mcp__weknora_dc328ba5_list_knowledge_bases` | `{"knowledge_bases":[{"id":"e89c8f05-…","name":"翼界知识库",…},{"id":"e196462b-…","name":"司风",…}]}` |
   | 16 | `xd://mcp__weknora_dc328ba5_search_knowledge` | `<search_results count="10" mode="hybrid">` … 真实 chunk |
   | 19 | `xd://mcp__weknora_dc328ba5_list_documents` | `{"documents":[{"id":"edb68a48-…","title":"…低空巡检成果亮相GMS…"},…]}` |
   | 44 | `xd://mcp__weknora_dc328ba5_list_documents`（读 schema） | 工具说明 + schema 原文 |

4. **归因**：omp 自己的配置（`~/.omp`、`~/.config/omp`、`%LOCALAPPDATA%\omp`）里
   **没有 weknora 配置**（命中的只有它自己的 session/run 日志），所以这个知识库连接**只能**来自
   我们在 `session/new` 里下发的 `mcpServers`。

**顺带闭环 C1（任务 3）**：同一实例的 trace 里

```json
{"event":"acp.available_commands","data":{"engineId":"omp","total":166,"names":["security","model","switch",…]}}
```

即 **omp 在 ACP 会话里上报了 166 个命令/技能**，UI 诊断行与 `GET /multi-acp/engines/omp/commands`
都能看到 —— 文档 §6.1 说的"引擎到底有没有发现 skill"从此可判定（count=0 才是没发现）。

**复跑方式**：`node tmp\mcp-loop-proof.mjs session-e877352c`（打印 MCP 调用 ↔ 结果配对）；
`pwsh -File tmp\mcp-loop-attribution.ps1`（下发记录 + 引擎配置归因 + 子进程）。

### 9.1 三家引擎对 `mcpServers` 的接受性（2026-10-09 傍晚，用 `tmp\probe-mcp-engine.mjs` 直连实测）

探针复用了生产路径（`lib/acp-client.js` + `lib/mcp-servers.js` 同一份映射），不打扰 DSH：

| 引擎 | `session/new` 带 4 个 mcpServers | 是否真的连上 | 证据 |
| --- | --- | --- | --- |
| **omp** (`oh-my-pi`) | ✅ 接受 | ✅ **已证** | 会话目录 `0.mcp__weknora_dc328ba5_search_knowledge.log`；DSH 轨迹 10/10 调用成功返回真实知识库数据（§9） |
| **Command Code** 1.76.0 | ✅ 接受 | ✅ **已证（探针直连）** | `session/new ok` → 引擎自己 `search_tools{"query":"select:mcp__weknora-dc328ba5__list_knowledge_bases"}` → 调 `mcp__weknora-dc328ba5__list_knowledge_bases` → 最终回答 **「翼界知识库, 司风, 标准知识库」**（真实数据） |
| **OpenCode** 2.0.23 | ✅ 接受（`session/new ok`，sessionId `ses_ee0304204ffe…`） | ⚠️ **未观察到**（不是协议问题） | prompt 阶段引擎直接回 `Insufficient account funds` —— 该 opencode 账号余额为 0，跑不了模型回合；`mcpServers` 已被接受且**同一代码路径**与 Command Code 完全一致 |

```powershell
# 复跑（任选引擎；commandcode 需要显式入口，因为它在 Windows 是 .cmd shim）
node tmp\probe-mcp-engine.mjs omp
node tmp\probe-mcp-engine.mjs commandcode --command "C:\nvm4w\nodejs\commandcode.cmd" --args "acp" --init-secs 120
node tmp\probe-mcp-engine.mjs opencode            # 会被余额挡住，但 session/new 已能验证接受性
```

### 9.2 顺带修的一个映射细节（A11-1 的补丁）

探针暴露了一个反例：**Command Code 的 `title` 就是工具名**
（`title = "mcp__weknora-dc328ba5__list_knowledge_bases"` / `"search_tools"`），
而 omp 的 `title` 是人话（`"Finding WeKnora base URL in configs"`）。
所以 `resolveAcpToolName()` 的兜底改成"**title 像标识符就用它**"（无空白、只含 `\w.-_:/`、≤80 字符），
否则才退回 `kind`。新增 5 条单测（`tmp\verify-toolname-timeout.mjs` 现 **22/22**）。

### 仍未验证（诚实边界）

0. 🟢 **2026-10-09 14:43 增补 —— 已在真实会话里验到（并揪出另一个致命 bug）**
   用户重启后新建 `preset=acp-omp` 会话（`session-c2601ea1`，cwd `D:\Ecode\workspace\DSH_Desktop`）：

   - ✅ 首个 `request/header` = **602 个工具**，含 `read/write/edit/glob/grep/pwsh/skill/web_search/todo_write/job_list`
     （同一天旧代码的 acp 会话是 164 个且无一原生工具）→ **本文件的第 2 节结论闭环**。
   - ✅ `preset.register` 的 `nativeToolRows` 9 行全部注册成功。
   - ✅ 引擎路由生效：`factory.createAgent {presetId:'acp-omp', engineId:'omp'}` +
     `factory.createAgent.spawning {command:'omp'}`。
   - ✅ **MCP 注入生效**：`session.mcp {count:4, summary:'MCP：4 个 — weknora-dc328ba5(http),
     chrome-devtools(stdio), drawio(http), dingtalk-workspace(stdio)'}`。
   - ❌ 但随后 `factory.createAgent.error-fallback {"message":"cannot get property
     \"sessionProjections\" without inject"}` —— 引擎都 spawn 了，仍在建 agent 的最后一步抛错回落原生。
     **修复**：`acp-agent.js` 的 `rootCtx.sessionProjections` → `rootCtx.get('sessionProjections')`
     （可选服务，不能硬 inject；`createAcpInbox` 已对 undefined 兜底）。

   ⇒ 教训（与 v0.1.12 客户端 `inject:['slots','locale']` 同源）：**插件碰任何宿主服务都要先问"它在不在 inject 里"**；
   不在就一律走 `ctx.get()`，因为 `ctx.xxx` 是**抛错**访问器，`?.` 也救不了（取值那一步就抛了）。

1. **DSH 内的一次真实引擎会话**（ISSUE-06）：上面那条已在 14:43 跑到"引擎已 spawn"，剩下 `sessionProjections`
   修复后的最终确认（预期：不再出现 `error-fallback`，且会话里出现引擎自带的工具调用回显）。
2. **引擎是否接受 `mcpServers`**：ACP 规范允许，但 omp / opencode / command-code 的实现
   需要各自实测（判定方法：会话里调用被注入 MCP 提供的工具，或用 `session/new` 响应里的
   报错 —— 不支持时引擎会直接报 invalid params）。
3. **`pwsh` ACL 失败**：属宿主 `dsh-sandbox-windows-acl`。规避路径：把权限模式调到
   危险/完全访问档，或把会话工作目录设成能授予 ACL 的目录（本机 `D:\Ecode\研发管理\...`
   与 `D:\Ecode\workspace\DSH_Desktop` 都失败过，说明与路径中文无关，更像 ACL 继承/所有者问题）。
