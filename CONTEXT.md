# 术语表 · dsh-multi-acp

> 本文件**只是术语表**。不放实现细节、不放设计决策、不放待办。
> 决策在 `docs/adr/`，设计在 `docs/DESIGN.md`，问题在 `docs/ISSUES.md`。
>
> 规则：**一个词只在这里定义一次**。其他文档用到这些词时，含义以本文件为准；
> 发现冲突就改冲突的那一方，并在 PR 里说明。
> 若某个词在代码里叫别的名字，本文件给出「代码名」，避免两套语言。

---

## 一、领域核心

### 引擎（Engine）
一个能说 **ACP over stdio** 的外部 CLI（omp / OpenCode / Command Code / Qoder CLI CN 等）。
本插件让 DSH 的一个会话由它作为**根 agent** 驱动。
不是「模型供应商」，也不是「子代理」——那是另外两条路线。

### 引擎行（Engine Row）
`Engine` 的**数据表示**：`{ id, label, command, args, cwdPolicy, mcp, enabled, sortOrder, … }`。
本项目的核心命题：**引擎是数据行，不是代码** —— 新增一个引擎 = 加一行，不改任何 `.js`。
代码名：`engine`（`lib/engines.js` 的 `BUILTIN` 与 `loadEngines()` 的产物）。

### 引擎来源（Engine Source）
引擎行的三个来源，按优先级：**内置 `BUILTIN`** → **`<stateDir>/engines.json`** → **插件 `config.engines`**。
按 `id` **整体覆盖**（不做深合并 —— 半覆盖会产出意外的组合）。

### 预设（Preset）
DSH 的「一层组合」：一份可挂载的插件行清单，决定某个会话拥有哪些能力。
**代码名**：`AgentPreset`。

### acp 预设（acp preset）
本插件为**每个引擎**注册的那一个 preset，id 形如 `acp-<engineId>`。
它是「这个会话交给哪个引擎」的**唯一入口**。
**不是** `standard` / `minimal` 那种通用预设，也不该被复制成第二套 `standard`。

### marker（预设标记）
acp preset 组合里的一行，只负责把 `engineId` 带进该 preset 的挂载上下文。
它**不发布任何服务**，因此不需要 `isolate` realm。

### 原生工具面（Native Tool Set）
acp preset 里那些**宿主提供**的模型面向工具（`read` / `write` / `edit` / `glob` / `grep` /
shell / `skill` / `todo` / `web`）。
存在的理由：preset 若只有 marker，会话的工具目录**只剩全局层**，原生工具一个都没有 ——
用户看到的是「模型自己乱试 `unknown tool "write"`」。

### 宿主半边 / 浏览器半边（Host Half / Browser Half）
一个 DSH 插件的两个运行面。宿主半边跑在 Host 进程里（Node）；浏览器半边跑在 Web 客户端里
（由 `window.__ModuleLoader__` 加载的 bundle）。二者**不同进程、不同模块系统**。

### Bundle / Patch / Profile / Entry / Fiber
Cordis 装配词汇，含义与官方一致，本仓库不另作解释：

- **Bundle** —— 通过 patch 参与 profile 装配的分发单元。本仓库自己就是一个 bundle。
- **Patch** —— 配置层。按 `id` 定位一个 Entry 并**替换其整个 `config`**，或插入新 Entry。
- **Profile** —— `$DSH_HOME/profiles/<name>` 下的一份可启动组合。本项目的目标宿主是 `desktop`。
- **Entry** —— 配置树里的一个装配项，本身不是插件。
- **Fiber** —— 一个 Entry 的运行时生命周期实例。**Fiber 停止 ≠ 包被卸载**，反之亦然。

---

## 二、会话与身份

### 根 agent（Root Agent）
驱动会话的那一个 agent。本项目让**外部引擎**当根 agent，取代 DSH 自己的 agent loop。

### factory 槽位（Factory Slot）
Host 上「谁负责造 agent」的那一个位置。官方 agent loop 构造时占用它；
本插件**替换**它以便把一部分会话路由到引擎。
**代码名**：`ctx.agents.factory`（宿主类型里是 `AgentRegistry` 的 **private** 成员，
官方入口是 `setFactory()`，但它拒绝被二次注册 —— 详见 ADR-0003）。

### DSH 会话 id / ACP 会话 id
两个**不同**的标识：前者是 DSH 的会话身份，后者是引擎自己的会话身份。
引擎只认后者，所以重启后要恢复同一会话，必须有一份映射。

### 回落（Fallback）
会话**没有**落到引擎时的走法：交回官方 DSH agent loop。
必须始终可用 —— 未声明引擎的会话、引擎未安装、握手失败都走它。

### 逃生路线（Escape Route）
与回落**不同**：回落是「按设计走另一条正常的线」，逃生是「已知自己没准备好，
所以明确报错、绝不静默降级」。本项目对**契约不满足**采用逃生，对**引擎不可用**采用回落。

---

## 三、注入与权限

### MCP 下发（MCP Injection）
把 DSH 里配置的 MCP 连接，随 `session/new` 与 `session/load` 交给引擎。
**协议层事实**：ACP 没有审批/授权字段，下发的 MCP 对引擎是**全量可用**的；
DSH 的 `tools.governance` 不随之生效。

### SKILLS 投递（Skill Delivery）
技能**不通过 ACP 协议共享**（协议里没有 skills 字段）。三条投递方式：

- **自扫（auto）** —— 引擎自己去扫通用技能目录，我们什么都不做；
- **挂载（args）** —— 启动时按模板把技能目录作为参数传给它；
- **不下发（none）** —— 隔离/排查用。

### 权限档（Permission Mode）
引擎侧的「要不要问」开关。三档：**默认问** / **免问** / **完全跳过检查**。
存在的理由：无人值守任务（定时任务）里「审批没人批」会被一律拒绝，
表现成「所有通道被拒，连写盘也不行」。

### 会话权限档（Session Permission Level）
DSH 侧的会话权限档（完全权限 / 工作区内修改 / 仅可查看）。
它与**权限档**是两件事；本插件只在「完全权限」时把它映射成引擎的「免问」，其余沿用以告警。

### 试连（Try Connect）
不建会话、不发 prompt 的一次性探测：起进程 → 握手 → 报能力 → 立刻回收。
用于回答「这个引擎现在能不能用」。

### 引擎四态（Engine State）
`可用` / `未安装` / `不可用` / `已停用`。
「不可用」与「未安装」必须分开：前者是探测到了但握手失败，后者是根本没找到可执行体。

---

## 四、时间与存活

### 空闲闸（Idle Gate）
「多久没有任何引擎 update 才算它卡死」。**主闸**。

### 总时长闸（Overall Gate）
「这次 prompt 最长允许跑多久」。**兜底**，默认不限。
两者不可混淆：把总时长闸设得比空闲闸短，会把**正在干活**的长任务误杀。

### 工具回显（Tool Echo）
引擎的工具调用被**翻译成 DSH 的会话事件**落盘。
不是「转发日志」——它必须满足 DSH 的会话日志契约（含 surface 标记），否则会话记录不合法。

### 会话日志契约（Session Log Contract）
任何写进会话日志的事件都必须满足的一组约束（事件类型 → 数据形状 → surface 标记）。
手工修历史文件也算「写事件」，同样受约束。

---

## 五、验证与证据

### 证据等级（Evidence Level）
每条陈述必须能带上其中之一。**写文档时必须标**：

| 标记 | 含义 |
| --- | --- |
| **实测** | 在本机读源码/跑命令**直接**验证过，附出处（路径、行号、命令、日志） |
| **参考实现** | 来自第三方实现的既有做法，**已读源码但未在本机复现** |
| **待验证** | 推断或未证。**未验证前不得作为实现依据** |

### 解析上下文（Resolution Context）
「这份宿主包是从哪儿解析出来的」。
**宿主进程内**与**宿主外**（裸 node / 验证脚本）会命中**不同**的宿主树 ——
因此任何「宿主契约」结论都必须连同解析到的**路径与版本**一起给出，否则它只是
关于某个不确定版本的说法。详见 ADR-0003。

### 回退树（Fallback Tree）
宿主外解析**最终落到的那棵树**。实测（2026-10-10）：`<DSH_HOME>/profiles/node_modules` 下
`@deepseek-ai/*` 有 244 条链接，全部指向 **nvm 全局安装**（实测钉死在 `v22.20.0`），
其中 197 条过期、**47 条已悬空**；而同一份 profile 的本地树只有 3 个实目录。
「解析上下文」讲的是**这件事会不会成立**，回退树讲的是**落到哪儿**。
测量入口：`node scripts/diagnose-host-resolution.mjs`（回退树审计段）。
详见 ADR-0003 与 `docs/ISSUES.md` ISSUE-14。

### 真实会话验证（Live Session Verification）
在**真实 DSH 宿主**里跑一次真会话，观察会话日志与进程，而不是只跑脚本。
脚本能证明「本插件的意图」，证明不了「宿主的语义」。

### 验收（Acceptance）
按项目当前阶段定义的可执行判据。**没有可执行判据的结论一律不算验收**。
具体判据见 `AGENTS.md`。

---

## 六、安全

### 中央脱敏（Central Redaction）
本插件**唯一**的诊断落盘点（`lib/trace.js` 的 `trace()`）在写盘前对整份 data 走的处理：
按键名（`token`/`password`/…）、按值的形状（`sk-…`/`mcp_…`/JWT/Bearer/邮箱/…）与长度上限
三层脱敏。放在**收口点**而不是调用方，是为了让"下一个忘了脱敏的调用方"也过不去 ——
纵深防御，不是"调用方小心点"。见 ISSUE-13。

### 诊断开关（Trace Switch）
决定要不要写、写到哪儿的配置项：`trace: true | false | 'off' | '<path>'`
（插件配置 > 环境变量 `DSH_MULTI_ACP_TRACE` > 默认路径）。**Desktop 下它是唯一可及开关** ——
从快捷方式启动的进程改不了环境变量。落盘内容**属于用户数据**，分享前应先关闭或改道。
