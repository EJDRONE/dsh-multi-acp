# P0 验证方案（go / no-go）

> 配套文档：[DESIGN.md](./DESIGN.md) · [ENGINE-SPEC.md](./ENGINE-SPEC.md)
> **本阶段只做验证，不写实现代码。**
> 证据等级标记沿用 DESIGN.md §0（✅实测 / 📖参考实现 / ❓待验证）

---

## 0. 为什么要先验证

📖 `dsh-grok-acp` 是**针对 DSH 0.1.1-rc.2** 开发的，而本机是 **0.2.0-rc.2**。它自己的 README 第 193 行警告：

> DSH 预发布版本可能改变内部 **AgentFactory** 或客户端 Slot API；升级 DSH 后先运行测试。

而本插件的命门**就是** `agents.factory` 这个内部槽位（DESIGN §4.2）。**这一条不通过，整个项目作废。**

因此 P0 的顺序是：**先验证最致命且最便宜的那一条。**

---

## 1. 验证纪律（红线）

| 禁止 | 理由 |
| --- | --- |
| ❌ 改写 `cordis.patch.yml` | ✅实测该文件含 MCP 行的明文凭据（云效 token / 钉钉 secret）。手改也要先备份 |
| ❌ 在 live profile（`desktop`）上做破坏性试验 | 用户正在用 |
| ❌ 为验证而卸载/替换现有插件 | 同上 |
| ❌ 把"没测"写成"不支持" | 两者是不同的结论，必须分开记 |
| ❌ 落盘任何凭据 | 探测输出要脱敏 |

**安全顺序**：静态读取 → 独立脚本 → 沙箱 profile → （最后才）live profile。

---

## 2. Step 0：静态验证 `agents.factory` 槽位（R1）🔴 致命

**目标**：确认 0.2.0-rc.2 里 `agents` 服务仍有可替换的 `factory` 槽位，且形状为 `{ target }`。

### 方法 A：在 app.asar 内搜索符号（零风险，首选）

✅实测 DSH 应用在 `D:\Programs\Deepseek\`，主逻辑在 `resources\app.asar`（121 MB）。

**已有工具可复用**：`D:\Ecode\tools\Dsh_Plugins\dsh_tabbit\tools\asar-find.mjs`（用户已有，先读它的用法）。

要检索的符号（按优先级）：

```
agents.factory
factory.target
AgentFactory
agentPresets
resolvedRoots
HarnessRouterFactory        ← 若命中，说明 grok 版用的类名仍在
```

**输出要求**：记录每个符号的命中位置，并**摘出定义处的上下文**（工厂槽位的赋值/解构代码）。

### 方法 B：最小探针插件（若 A 不可行）

写一个最小 cordis 插件，只做一件事——在 `activate` 时打印 `ctx.agents.factory` 的运行时形状：

```js
export const inject = ['agents', 'agentPresets']
export function apply(ctx) {
  const agents = ctx.agents
  console.log('[probe] agents keys =', Object.keys(agents))
  console.log('[probe] agents.factory =', agents.factory)
  console.log('[probe] factory.target type =', typeof agents.factory?.target)
  const presets = ctx.agentPresets
  console.log('[probe] agentPresets keys =', Object.keys(presets ?? {}))
  console.log('[probe] resolvedRoots =', presets?.resolvedRoots)
}
```

⚠️ 装到 **live profile** 属于有副作用操作，**需用户明确同意**；优先用方法 A。

### ✅ 通过标准

- `agents.factory` 存在，且可通过 `agents.factory = { target: <fn> }` 替换
- `ctx.agentPresets` 存在，且 `resolvedRoots` 可读写

### ❌ 不通过则

**终止本项目**，退回 provider 路线（`codex-plugin-dsh` 模式）——那条路只依赖公开的 `LlmAdapter` 路由注册，不碰内部 factory。

---

## 3. Step 1：静态验证 `agentPresets` API（R2）🔴 高

**目标**：确认以下三个东西的**确切签名**：

1. `agentPresets.resolvedRoots` 的读取/写入语义
2. `agentPresets.recompose(agentCtx, presetId)` 的参数与返回（📖 grok 版用法）
3. `presets/<name>/` 目录的加载约定（`preset.yml` + `agent.cordis.yml` 的必需字段）

**额外要回答的（DESIGN §7 D4 / §14-3）**：多引擎时 preset 怎么摆？

| 方案 | 做法 | 风险 |
| --- | --- | --- |
| D4-a | 每个引擎物化一个 preset 目录 `presets/acp-<engineId>/` | 与 grok 版同构，最低 |
| D4-b | 单个 preset + marker 区分引擎 | 需确认 marker 能携带引擎 id |

**采集**：✅实测本机已有 3 个非标准 preset 可作样本——
`D:\Ecode\.dsh\.agent-presets\{router-standard, crew, liangshen}\`
逐字段对照它们的 `preset.yml` / `agent.cordis.yml`，确认**最小可用 preset 的必需字段集**。

---

## 4. Step 2：`agents.factory` 替换语义验证（R1 补充）

若 Step 0 走方法 A 通过了，还需确认**替换的运行时语义**：

- ❓ 替换 `agents.factory` 后，**已存在的会话**是否受影响？
- ❓ 官方 factory 保存为 `originalSlot.target` 后，调用它是否需要特定 `this` 绑定？
- ❓ 并发创建 agent 时，router 是否会被重入？

**做法**：读 0.2.0-rc.2 中 `agents.factory` 的**调用点**代码，确认调用约定。

---

## 5. Step 3：ACP 握手探测（R5 / R6）🟠

**目标**：拿到 `opencode acp` 与 `cmd acp` 的**能力清单**，填满 [ENGINE-SPEC.md](./ENGINE-SPEC.md) §4 的表格。

### 3.1 请求形状的来源

⚠️ **不要凭记忆写 `initialize` 的 JSON**。以官方 SDK 的类型定义为唯一真源：

```powershell
# 在临时目录
npm i @agentclientprotocol/sdk
# 然后查它的 InitializeRequest / InitializeResponse 类型
```

📖 已知 grok 版用的是 `@agentclientprotocol/sdk@0.25.1`。

### 3.2 探测脚本骨架

```js
// probe-acp.mjs  —— 独立脚本，不依赖 DSH
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const [command, ...args] = process.argv.slice(2)   // 例: opencode acp

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
const rl = readline.createInterface({ input: child.stdout })

const raw = []
rl.on('line', (line) => {
  raw.push(line)
  let msg; try { msg = JSON.parse(line) } catch { return }   // 非 JSON 行也保留（方言素材！）
  if (msg.id === 1) {
    console.log('=== initialize 响应 ===')
    console.log(JSON.stringify(msg, null, 2))
    // 记录 capabilities / authMethods / agentInfo 原文
  }
})

child.stderr.on('data', d => process.stderr.write('[stderr] ' + d))

// 第 1 步：initialize（参数照 SDK 类型构造）
child.stdin.write(JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { /* ← 照 @agentclientprotocol/sdk 的 InitializeRequest 填 */ },
}) + '\n')

// 第 2 步：session/new
// 第 3 步：同一进程内**再发一次** session/new   ← 这同时验证 R3（多会话复用）
// 第 4 步：session/prompt 一次最小请求，观察流事件形状
// 第 5 步：故意调一个不存在的方法，确认返回的是 method_not_found（而不是崩掉）
```

### 3.3 要跑的两条命令

```powershell
node probe-acp.mjs "C:\Users\29096\.opencode\bin\opencode.exe" acp
node probe-acp.mjs "C:\nvm4w\nodejs\commandcode.ps1" acp      # ⚠️ .ps1，见 Step 5
```

### 3.4 采集纪律

- **原始行逐字保留**（这是方言档案的唯一合法来源，见 ENGINE-SPEC §5）
- 落盘前**脱敏凭据**
- `method_not_found` ≠ "没测"——分别记录
- 记录 `initialize` 的**耗时**（对照 ENGINE-SPEC §2 的 `initBudget`）

---

## 6. Step 4：多会话复用（R3）🟠

**目标**：确认一个 ACP 进程能服务多个 session（决定 DESIGN §7 D6 是否成立）。

**做法**：Step 3 的脚本里，同一进程**连续发两次 `session/new`**，拿到两个 sessionId；然后对两个 session 各发一次 `session/prompt`，看是否都能正确返回各自的流事件。

**若不行** → 改为"每会话一进程"，`idleDisposeMs` 语义相应调整（DESIGN §12 R3 的退路）。

---

## 7. Step 5：Windows spawn 验证（R4）🟠

**目标**：确认 DSH 的 `subprocess` 服务能否拉起 `.ps1` shim。

### 5.1 先做独立验证（不经 DSH）

```powershell
# 记录 .ps1 能否被普通 spawn 拉起
node -e "const{spawn}=require('child_process');const c=spawn('C:\\nvm4w\\nodejs\\commandcode.ps1',['acp'],{stdio:'inherit'});c.on('error',e=>console.log('ERR',e.message))"
```

对照实验：换 `pwsh -File <shim> acp` 与 `cmd /c <shim> acp`。

### 5.2 再验证 DSH `subprocess` 服务的调用约定

❓ 待验证：`subprocess` 服务的 API 形态（📖 grok 版是 `inject: [... 'subprocess' ...]`，但具体调用未见）。

**优先规避**：若 `commandcode` 有原生 exe（非 `.ps1`），直接用原生 exe，跳过整个 shim 问题。✅实测 `opencode` 是原生 `.exe`，`commandcode` 目前是 `.ps1` —— **值得查一下 commandcode 是否有原生安装方式**。

---

## 8. 判定矩阵

| Step | 风险 | 通过 | 不通过 |
| --- | --- | --- | --- |
| 0 · `agents.factory` | R1 🔴 | 继续 | **终止项目**，退 provider 路线 |
| 1 · `agentPresets` | R2 🔴 | 继续 | 评估能否只用 factory 替换（不要 preset 注册）——**很可能不行，因为预设要挂载** |
| 2 · 替换语义 | R1 补充 | 继续 | 按实际调用约定调整 router 设计 |
| 3 · ACP 能力 | R5/R6 🟠 | 按实现能力降级设计 | 若**缺 `session/prompt`** → 该引擎不可用，换目标 |
| 4 · 多会话复用 | R3 🟠 | 保持 D6（进程复用） | 改"每会话一进程" |
| 5 · Windows spawn | R4 🟠 | 保持配置 | 改写 shim 策略 / 换原生 exe |

**P0 全部通过后才进入 P1。**

---

## 9. P0 产出物清单

验证完成后必须留下：

1. `docs/evidence/` —— 每步的原始输出（脱敏后），带时间戳与命令
2. `ENGINE-SPEC.md` §4 的能力矩阵**填满**（可含"未测"）
3. `DESIGN.md` §7 D4 的方案选定（a 还是 b）
4. `DESIGN.md` §12 风险登记表更新（每条 → 已消除 / 仍存在 / 新增）
5. `DESIGN.md` §14 开放问题逐条收敛

---

## 10. 与 experts-management PLUS 版的关系

**两条线互不阻塞**（DESIGN §11）：

- 本插件 P0 失败 → PLUS 版的 gap **1（模型槽位）/ 4（启用停用）/ 6（技能引用）仍然全部有效**，只是 gap 3′ 的选项里少掉"外部 ACP 引擎"这一支
- 本插件 P0 通过 → PLUS 版的 `agentPreset` 字段才真正有外部引擎可选

**所以 P0 验证可以和 PLUS 版并行推进**，不必串行等待。

---

## 11. P0 执行记录 · Step 3 / 4 / 5 已完成（2026-10-07）

**工具**：`probe/probe-acp.mjs`（自建，用官方 `@agentclientprotocol/sdk@0.25.1`）
**证据**：`docs/evidence/probe-*.json`
**结果详情**：见 [ENGINE-SPEC.md](./ENGINE-SPEC.md) §8

### 状态更新

| Step | 验证项 | 状态 | 结论 |
| --- | --- | --- | --- |
| **0** | **`agents.factory` 槽位（R1 🔴）** | ✅ **已完成** | **✅ 通过**：`AgentFactory` 接口在；`agents.factory` 是普通实例属性、形状 `{ target }`，与 grok 依赖一致 → 直接赋值替换成立 |
| **1** | **`agentPresets` API（R2 🔴）** | ✅ **已完成** | **✅ 通过（需换 API）**：`resolvedRoots` 已移除；改用 `agentPresets.register(definition)`（程序化注册，返回 disposer）+ 官方 `select(agent, presetId)`（内建锁门） |
| 2 | factory 替换语义（R1 补充） | 🟡 **部分** | 槽位形状已确认；`factory.target` 的 `this` 绑定与替换时机仍待实测 |
| **3** | **ACP 握手 + 能力**（R5/R6） | ✅ **已完成** | **两个引擎均跑通完整往返；0 条方言解析失败** |
| **4** | **多会话复用**（R3） | ✅ **已完成** | **两者均支持同进程多 session** → DESIGN D6 成立 |
| **5** | **Windows spawn `.ps1`**（R4） | ✅ **已完成** | **`pwsh -NoProfile -ExecutionPolicy Bypass -File <shim> acp` 可用** |

### 关键成果（三个引擎全部跑通）

| 引擎 | 版本 | `initialize` | prompt 往返 | 备注 |
| --- | --- | --- | --- | --- |
| **omp（oh-my-pi）** | 18.3.5 | **579 ms** | **5.2 s** | **三者中最完整**：唯一 MCP over SSE；同时给 `modes` + `configOptions`；复用 `~/.omp` 本地凭据 |
| **OpenCode** | 2.0.23 | 782 ms | 15.8 s | `setSessionConfigOption` **per-session 切模型实测生效**；能力最宽（`session/delete`·`additionalDirectories`） |
| **Command Code** | 1.76.0 | 3130 ms | 19.3 s | **5 档原生权限 mode**；`.ps1` shim 路径已验证 |

- 三者 `initialize` 均在 3.1s 内 → **暂无冷启动惩罚**（都不是 npx 拉起）
- 三者**方言解析失败均为 0**
- ⚠️ **omp 同时暴露 `modes` 与 `configOptions`** → 适配层必须支持两种风格，**不能二选一**（详见 ENGINE-SPEC §8.3）

### 新增待验项（由实测产生）

| 项 | 说明 |
| --- | --- |
| Command Code / omp 的 `session/set_config_option` | 两者的 mode 切换路径未实测（**仅 OpenCode 验证过**） |
| `request_permission` / `fs/*` / `tool_call` / `plan` 事件 | trivial prompt 未触发，需构造真实任务 |
| `session/cancel` | 未测 |
| 未知事件类型的容忍 | omp 独有 `session_info_update` → 适配层必须容忍未知类型而不报错 |
| 异常路径下的方言行为 | 本轮 0 解析失败，但只覆盖了正常路径 |

---

## 12. P0 执行记录 · Step 0 / 1 已完成（2026-10-07）

**方法**：纯静态检索 `D:\Programs\Deepseek\resources\app.asar`（115.7 MB），用 `dsh_tabbit\tools\asar-find.mjs`。
**零副作用**：未安装、未修改、未启动任何东西。
**证据**：`docs/evidence/P0-step0-asar-findings.md`

### 🎉 结论：两道致命门槛**全部通过**

| 风险 | 结果 | 关键证据 |
| --- | --- | --- |
| **R1** `agents.factory` | ✅ **通过** | `setFactory()` 内部就是 `this.factory = { target }`；`requireFactory()` 返回该对象由消费方读 `.target` → **grok 的直接赋值写法在 0.2.0-rc.2 成立** |
| **R2** `agentPresets` | ✅ **通过（换 API）** | `resolvedRoots` **已移除**；但 `register(definition)`（程序化注册、返回 disposer）与 **`select(agent, presetId)`**（内建锁门 + 并发串行化）均在 |

### 三项设计决策据此修订

| # | 原设计 | 修订为 |
| --- | --- | --- |
| **D2** | 不写 `cordis.patch.yml` | **不变，且更有底气**——`register()` 让 preset 无需进配置文件 |
| **D4** | 物化 preset 目录 + `resolvedRoots` | **`agentPresets.register({ id, name, description, order, plugins })`**，保存返回的 `unregister` |
| **D5** | 自写 `sessionBlank()` 闸门 | **官方 `agentPresets.select()`**——锁门判定用 `turnBoundary` projection，比 `sessionBlank()` 更精确，且抛可透传的 `RemoteError("agent-preset/locked", …)` |

### 🚨 附带发现（需用户确认）

`.agent-presets/` **目录式 preset 在 0.2.0-rc.2 已废弃**（包内迁移文档原话：*"Nothing reads that directory any more"*），且 `cordis.yml` / `cordis.patch.yml` 中 **grep `preset` 均为 0 匹配**。

→ 本机 `D:\Ecode\.dsh\.agent-presets\{router-standard, crew, liangshen}\` 三个 preset **很可能已失效**。需向用户确认。

### 仍未验证

| 项 | 说明 |
| --- | --- |
| `factory.target` 的 `this` 绑定 | 它可能是 Cordis traced service（`factory[symbols.original] ?? factory`），调用时是否需绑定 |
| `register(definition)` 的完整字段 schema | 目前只确认有 `id`；`name`/`description`/`order`/`plugins` 的确切字段名待查 |
| 替换 `agents.factory` 的时机 | 需在 agent-loop 注册之后 |
| 已存在会话是否受 factory 替换影响 | §4 原待验项 |

### 下一步

**P0 已无致命阻塞 → 可进入 P1（最小可用）。** 建议第一步做最小探针插件：只做「替换 factory + register 一个 preset + 一个会话跑通 `omp acp`」，验证端到端链路。

---

## 13. 回归验收脚本（2026-10-09 · v0.1.15 起）

三个**零依赖**（不需要 DSH、不需要装 react）脚本，改动后随手可跑：

```powershell
# 1) 语法（所有被改过的文件；ESM + package.json 无 "type":"module"，用 --check 即可）
pwsh -File tmp\syntax2.ps1

# 2) preset 原生工具组合 + MCP 映射 + SKILLS 投递（30 项）
node tmp\verify-preset-mcp.mjs
#    · 逐条把 nativeToolRows() 的模块名对照官方 standard/minimal preset 的 name 集合
#      —— 写错包名会让 preset 挂载失败，这是本类改动最大的坑
#    · ACP McpServer 形状（env/headers 对象→数组、bearer→Authorization 头）、
#      include/exclude 别名匹配、engine.mcp 短路
#    · SKILLS：auto/none 不追加参数、args 按 skillArgsTemplate 追加 `--skill <dir>`（多目录可重复）、
#      describeSkills() 的三种摘要与真实目录探测（~/.agents/skills 下应报 119 个）
#    · 默认读 D:\Ecode\.dsh\storages\mcp_connector.json，可传自定义 DSH_HOME

# 3) 引擎管理 UI 行为（45 项，自带 mini-React：路径稳定 hook + 同步重渲染）
node tmp\verify-ui.mjs
#    · 契约：inject=['slots','locale']、apply() 不抛、注册 settings.section
#    · B4-②：👁 明文切换 / 🗑 删除 → PUT body 里该键必须是 null / ＋ 新增键写入
#    · B4-①：覆盖启动方式的 command·args·cwdPolicy → PUT 字段（args 支持引号整段）
#    · SKILLS 块：投递方式下拉（auto/args/none）、目录行（"已找到 N 个 skill"）、
#      改路径 + ＋添加目录 → PUT body 的 skillDelivery / skillsDirs
#    · 过滤桶 / 搜索 / 诊断行 / 默认徽章 / 能力徽章

# 4) 工具名解析 + prompt 超时（2026-10-09 新增，17 项）
node tmp\verify-toolname-timeout.mjs
#    · A11-1：ACP 句子式 `title` 绝不能当工具名；真名解析链（toolName/_meta.*/rawInput.*）
#    · A11-2：DEFAULT_PROMPT_TIMEOUT_MS=300s、withTimeout(ms<=0)= 不超时、超时文本格式

# 5) 会话日志契约自检 + 历史修复（2026-10-09 新增 · ISSUE-12）
node tmp\scan-orphan-toolcalls.mjs
#    · 扫描所有会话：找出"有 tool/call 但没被 assistant/message 广告"的日志（会历史加载失败）
node tmp\repair-orphan-toolcalls.mjs <sessionDir>            # dry-run
node tmp\repair-orphan-toolcalls.mjs <sessionDir> --apply    # 写入（自动备份 *.bak-<时间戳>）
node tmp\repair-orphan-toolcalls.mjs <sessionDir> --reframe --apply   # 仅重排帧布局/seq
pwsh -File tmp\reframe-all.ps1
#    · 对 4 个受影响会话核对 6 条契约：① 广告块 ② 第一帧仅一行 ③ seq 从 0 连续
#      ④ source.kind ⑤ message.id ⑥ step/turn 结束前无悬空 tool/call
```

> **给后续写"日志修复/离线改写"工具的人**：DSH 的 `.jsonl.zstd` 有 6 条硬契约（见上），
> 任何手工改写都要先过 `tmp\reframe-all.ps1` 那套自检。校验器源码可从 `app.asar` 取出
> （`node tmp\asar2.mjs <asar> cat <innerPath> <outFile>`；参考 `tmp\fmt-v3v4.js`、
> `tmp\persist-worker.cjs`）。

### 仍属"必须真跑"的项目（脚本无法替代）

| 项目 | 判定手段 |
| --- | --- |
| 新建 acp 会话是否路由到引擎 | `<stateDir>/trace.log` 里 `factory.createAgent` 的 `engineId` 非空；会话 `request/header` 的工具名不含 DSH 原生工具（引擎自带自己的工具） |
| resume 是否不再静默回落 | `factory.resume.engine-from-map` 命中，且不再出现 `factory.resume … fallback-native` |
| preset 工具是否生效 | acp preset 会话里 `pwsh`/`read`/`write`/`skill` 出现在 `request/header`；或回落原生时能写出文件 |
| 引擎是否接受 `mcpServers` | 会话里调用被注入 MCP 提供的工具；不支持时 `session/new` 直接报 invalid params |
| 引擎 skill 发现 | `GET /multi-acp/engines/:id/commands` 的 `commandCount > 0`，且 UI 诊断行显示「引擎命令/技能：N 个」 |
