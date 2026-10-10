# AGENTS.md · dsh-multi-acp

> 面向**用 AI Agent 开发本插件的会话**。开始任何任务前先读完本文件。
>
> 本仓库的全部代码由 AI Agent 编写和维护。因此本文件不是「建议」，
> 而是**会话的约束集**：它规定了读什么、跑什么、能改什么、以及什么叫做完。
>
> **优先级**：本文件 > `CONTEXT.md`（术语） > `docs/adr/`（决策） > 其他文档 > 习惯做法。
> 与源码冲突时，**先记录冲突**，再以源码 + 实测为准。

---

## 0. 三条不可协商的原则

1. **只声明有证据的东西。** 每条技术陈述必须能标上「实测 / 参考实现 / 待验证」（定义见 `CONTEXT.md` §五）。
   未验证的推断不得写成实现依据。
2. **不静默降级。** 失败要么明确报错，要么降级并**留下可见诊断**。宽泛 `catch` 吞异常一律视为缺陷。
3. **启动失败是最贵的事故。** 本插件历史上最痛的失败形态是「插件起不来」——
   `lib/index.js` 那个自报错加载器就是为它存在的。任何新增的模块求值期风险都要先证明不会抛。

---

## 1. 开工前必做（不要跳过）

```powershell
# 1. 术语与既有决策 —— 先读，别自己造词
Get-Content CONTEXT.md
Get-ChildItem docs/adr

# 2. 当前状态：能不能跑、有没有已知红灯
npm test
node scripts/diagnose-host-resolution.mjs

# 3. 你要改的那个模块，先看它的 @module 注释 —— 坑都记在那里
```

**必读文档按任务分流**：

| 你要做的事 | 先读 |
| --- | --- |
| 改引擎数据 / 加引擎 | `docs/ENGINE-SPEC.md` + `lib/engines.js` 的 `BUILTIN` |
| 改配置面 | `lib/config.js` + `docs/adr/0004-schemastery-config.md` |
| 改宿主包解析 / 诊断 | `docs/adr/0003-host-package-resolution.md` |
| 改安装 / 发布 | `docs/adr/0001-install-path-desktop.md` + 官方 `publish.zh.md` |
| 改客户端半边 | `docs/evidence/B0-ui-contract-findings.md` §2 |
| 碰 factory / agent 装配 | `docs/adr/0006-route-b-replaces-private-factory.md` + `lib/acp-factory.js`（路由）/ `lib/acp-agent.js`（装配） |
| 改回合驱动 / **事件桥** / 会话日志契约 | `lib/acp-turn-runner.js` + `docs/VERIFICATION.md` §13 |
| 改待处理输入（inbox） | `lib/acp-inbox.js`（`agent/inbox/spliced` 契约） |
| 宿主契约探测 / 错误分类 | `lib/agent-contract.js` |
| 写会话事件 | `docs/VERIFICATION.md` §13（会话日志契约） |

---

## 2. 环境事实（写错会浪费一整轮）

- **平台**：Windows + PowerShell 7。命令一律 `pwsh.exe`，**不要**退回 `powershell.exe`。
  含引号/多行脚本写临时 `.ps1` 用 `-File` 跑，不要深引号内联。
- **宿主**：DSH **Desktop**，`DSH_HOME = D:\Ecode\.dsh`，profile = `desktop`。
- **安装形态**：profile 用 pnpm 的 `file:` 依赖装本仓库，安装副本是**硬链接树**。
  - 用 **Edit** 改已有文件 = 原地写 → 硬链接自动同步；
  - 用 **Write** 重写整个文件 = **换 inode → 断链**，安装副本不会更新。
  - 所以：改已有文件优先 `Edit`；一旦用了 `Write` 或新建了文件，**必须**跑
    `pwsh -File tools\install.ps1 -Sync` 重新硬链接，否则你在测旧代码。
- **进程名**是 `DeepSeek Harness.exe`。`Get-Process dsh/electron` 找不到它。
- **`DSH_HOME` 必须显式存在，否则你启动的是另一个实例**（2026-10-10 实测事故，
  排查花了很久）：Desktop 用它决定加载哪个 profile。从"环境里没有 `DSH_HOME`"的进程
  （AI 会话、计划任务、别的 shell）启动 `.exe`，它会退回默认 `%USERPROFILE%\.dsh` ——
  那里**没有本插件**，而观测点（`trace.log` / `load-report.txt`）还停在原来的 `DSH_HOME`。
  现象是"插件突然不加载了"，而真机只是起错了 home。
  → `tools/restart-and-capture.ps1` 现在**拒绝**在没有 `DSH_HOME` 且未传 `-DshHome` 时启动。
- **`tools/install.ps1` 必须用宿主自带 pnpm**（`<Desktop>/resources/runtime/pnpm/bin/pnpm.cjs`，
  实测 11.7.0），不要用 PATH 上的 `pnpm`（实测 12.4.1）：不同大版本会重写 profile 的
  `node_modules/.modules.yaml` 与 `.pnpm/lock.yaml`，可能让加载器解析异常。
- **Node 版本陷阱**：nvm 里有多个版本，`C:\nvm4w\nodejs` 指向当前 active。
  `profiles/node_modules/@deepseek-ai/*` 是指向**某个具体 nvm 版本下全局 npm 安装**的
  绝对路径链接 —— `nvm use` 换版本会让整棵树悬空或换内容。见 ADR-0003。
- **Desktop 自带官方 CLI**（与宿主精确同版本，**不要另装**）：
  `D:\Programs\Deepseek\resources\runtime\cli\bin\dsh.cmd`

---

## 3. 验证：什么算证明

| 层次 | 命令 | 证明什么 |
| --- | --- | --- |
| 语法 | `npm run check` | 文件可被 Node 解析 |
| 行为（**唯一阻断门禁**） | `npm test` | 纯函数 / bundle 契约 / 装配意图 |
| 类型 | `npm run typecheck` | 与宿主 `.d.ts` 的一致性（**已清零，CI 阻断**） |
| 解析上下文 | `node scripts/diagnose-host-resolution.mjs --expect <宿主版本>` | **你接下来的宿主结论是否可信** |
| **实际生效的配置** | `npm run verify:profile` | profile patch 是否**静默清掉**了 bundle patch 的键（ISSUE-16） |
| 真实会话 | 见 `docs/VERIFICATION.md` | 宿主语义、端到端 |
| 官方安装路径 | CI 的 `official-install` job（ubuntu） | 包能被官方管线装进干净 profile |

### 铁律：宿主外的结论必须自曝其短

`npm test` 与任何裸 `node` 脚本跑在**宿主外**，解析到的宿主包**不是宿主那一份**（ADR-0003）。
因此：

- 断言宿主契约时，必须同时断言**解析到的路径与版本**（`trustHost`），否则那条断言只是
  「关于某个不确定版本的说法」。**2026-10-10 已因此产出过一次假阴性**。
- 涉及宿主真实语义的结论（factory 形状、事件模式、surface 契约）**只能**由真实会话给出。

### 铁律：用假 ctx 调 `apply()` 前必须关掉 trace

`lib/trace.js` 默认写 `<stateDir>/trace.log`（**用户的真实诊断数据**）。任何用假 ctx 调
`apply()` 的测试或脚本都会往里面写**假宿主事件**：

```js
process.env.DSH_MULTI_ACP_TRACE = ''      // '' / '0' / 'off' = 关闭
process.env.DSH_MULTI_ACP_TRACE = 'D:/tmp/my-trace.log'   // 或重定向
```

`lib/trace.js` 每次调用都读这个变量，并内置 **`node:test` 下绝不写默认路径** 的兜底
（`NODE_TEST_CONTEXT`）。但**新写的脚本**仍要自己显式关掉。

> 事故（2026-10-10，ISSUE-18）：测试里一条故意构造的
> `{ target: 'not-a-factory' }` 被写进真 trace，表现为 `install.factory-bad-shape`，
> 让人误判"宿主返回了无法识别的形状"，**差点据此放宽一项本来不该动的保守策略**。
> 诊断数据被自己的测试污染，比没有诊断更糟。

### 什么时候必须跑真实会话

改动了以下任一项，**必须**在真实 DSH 里跑一次真会话并在 PR/CHANGELOG 里贴证据：

- factory 替换逻辑、agent 装配、事件桥
- preset 注册或其工具组合
- 会话事件写入（工具回显 / 消息落盘）
- MCP 下发、skill 投递、权限档映射
- 任何 `ctx.effect` 的注册或清理顺序

---

## 4. 定义完成（DoD）

一项工作只有在**全部**满足时才算完成：

1. `npm test` 全绿；`npm run check` 通过。
2. 改动**行为**时，新增/更新了对应测试；测试是**行为断言**，不是文本匹配或快照。
3. 按 §3 判断需要的**真实会话**已跑，证据写进 CHANGELOG（会话 id + 观察到的现象）。
4. `package.json#version` 已 bump；`CHANGELOG.md` 有对应条目。
5. 若改了需要重新硬链接的东西 → 跑过 `tools\install.ps1 -Sync`，且用
   `tmp\verify-install.ps1` 确认 repo ↔ 安装副本一致。
6. 文档同步：新术语进 `CONTEXT.md`；新决策进 `docs/adr/`；新问题进 `docs/ISSUES.md`；
   改了架构就更新 `docs/architecture/system.architecture.json` 并重新交付 HTML。
7. 没有留下 `TODO`、占位实现、被注释掉的旧代码、或一次性调试脚本。

> **判据的唯一可靠信号**：插件页显示的版本号 = `package.json` 的版本。
> 看不到新版本号 = 加载的是旧代码，先解决同步，不要继续排查别的东西。

---

## 5. 能改什么 / 不能改什么

**可以改**：本仓库的 `lib/`、`test/`、`scripts/`、`docs/`、`cordis.patch.yml`、CI。

**不要改（改了必须先在对话里说明并得到同意）**：

| 对象 | 原因 |
| --- | --- |
| `$DSH_HOME/profiles/node_modules/**` | 由 DSH 维护（官方原文：不要手工复制）。40+ 已装插件共享它。见 ADR-0003。 |
| `$DSH_HOME/profiles/desktop/cordis.patch.yml` | **含明文凭据**（MCP token / 账号密码）。本插件永不写入该文件。 |
| `$DSH_HOME/profiles/desktop/cordis.yml` | 启动器维护为空根并用作模块解析锚点。 |
| `D:\Programs\Deepseek\**`（宿主本体） | 签名资源。要理解它就读，不要改。 |
| `tmp/` 之外的临时目录 | `tmp/` 已在 `.gitignore`（里面会有会话日志明文与用户隐私）。 |

**新增依赖**前必须 `npm view <pkg> versions` 确认版本存在，**且精确 pin**：
`latest` 标签实测指向损坏的版本线（`@deepseek-ai/dsh-tools@latest` → `0.0.1-rc.1`）。

**不要把宿主接口包放进 `dependencies`** —— 必须进 `peerDependencies`（开发用版本进
`devDependencies`）。否则旧版副本会遮蔽宿主，工具调用全挂、内置预设失效（市场规范 §6.6 的真实案例）。

---

## 6. 已记录的偏离（deviations）—— 不要"顺手修好"

这些是**有意的**，每一项都有 ADR。改之前先读 ADR，并在对话里说明理由。

| 项 | 偏离 | ADR |
| --- | --- | --- |
| 安装路径 | 用 `tools/install.ps1` 手工改 profile，而不是官方 `dsh plugin --profile desktop add` —— **因为公开 CLI 明确不管 Desktop profile** | ADR-0001 |
| 语言 | 纯 JS（JSDoc + `checkJs`），不迁 TypeScript | ADR-0002 |
| factory 替换 | 直接赋值 `ctx.agents.factory`（宿主类型里是 private）；官方 `setFactory()` 因「已注册即抛错」不可用 | ADR-0006 |
| 宿主包解析 | 锚定 profile 目录，**不**走进 `app.asar` —— 导致宿主外解析到旧版本 | ADR-0003 |
| 配置 | 用宿主 `@deepseek-ai/schemastery`，但**求值失败时降级为 `Config === undefined`** | ADR-0004 |
| 类型基线 | 已清零（2026-10-10，43 → 0），CI 中**阻断**；`Agent.status` 的 readonly 越界是**显式抑制**（带原因） | ADR-0002 / ADR-0006 |
| 无 `dsh.client.inject` | 该字段是**激活顺序**而非导入白名单；本 bundle 不 import 任何 Harness Client 包 | ADR-0005 |
| 客户端半边**单文件** | `lib/client.js` 不拆成多文件：`factory(require)` 只解析加载器 seeded 的 require table，拆文件必须引入构建步骤，会把"可原地编辑"变成"生成物 + 断链风险" | ADR-0005 补记 |

---

## 7. 反模式（全部来自真实事故，别再犯）

1. **对 Cordis 的 traced service 做 `JSON.stringify`** → 它会读 `.toJSON`，而对未声明
   inject 的属性读取**直接抛错**。于是「防御性错误信息自身崩溃」，真故障被完全掩盖。
   → 只读自有属性名与 `typeof`（见 `index.impl.js` 的 `describeShape`）。
2. **`inject` 少声明一个服务** → `createScope` 造出的 `agent.ctx` 会缺服务，
   别的插件一访问就把**宿主进程打死**（`cannot get property "x" without inject`）。
   → `inject` 必须包含官方 agent-loop 的全部条目。
3. **客户端插件漏声明 `inject`** → `ctx.locale && …` 这类守卫**救不了**（抛在读属性那一刻），
   客户端入口激活失败会**中止整个 web boot**。
4. **只报「缺什么」不报「对谁说的」** → 假阴性（§3 铁律）。
5. **用墙钟上限掐长任务** → 正在干活的引擎被误杀（实测：21 次工具调用全成功后仍被杀）。
   → 主闸用空闲闸。
6. **写会话事件不管 surface 契约** → 会话记录不合法，回放/导出/replay 全废。
7. **把 `todo_write` 的勾当进度** → 进度只属于 `todo` 工具，本文件不管进度。

---

## 8. 安全

- **绝不要**把密钥/token/密码写进源码、`cordis.patch.yml`、`engines.json`、测试或文档。
  凭据属于用户环境（环境变量、Harness Credentials、引擎自己的凭据目录）。
- **`!!js` 边界**（官方原文）：`!!js` 表达式在配置求值/重载时可能**重复执行**，
  必须是纯的、确定的、快的。禁止在其中做网络/子进程/写文件/读凭据/注册不可回收的资源。
- **落盘脱敏**：本插件会写 `<stateDir>/trace.log`。当前它记录引擎工具调用的**原标题**，
  因此可能含 token 与明文密码（**已知问题，见 `docs/ISSUES.md` 的凭据条目**）。
  改这块时：只记元数据、对值脱敏、并提供关闭开关。
- 新增网络/文件/子进程能力时，在 `docs/ISSUES.md` 或 ADR 里说明其**边界**（谁可调用、能否关闭）。

---

## 9. 收尾清单（每次会话结束前逐项核对）

```
[ ] npm test 全绿 + npm run check 通过
[ ] 需要的话：真实会话证据（会话 id + 现象）写进 CHANGELOG
[ ] version bump + CHANGELOG 条目
[ ] 硬链接同步（用了 Write / 新建文件时）
[ ] CONTEXT.md / docs/adr / docs/ISSUES 已同步
[ ] 架构有变 → 重新交付 docs/architecture/system.html
[ ] git status 里没有 tmp/ 产物、探测 JSON、会话日志
```

> 不要**只**改代码就交付。本仓库的历史教训是：**没写下来的结论，下一轮会被重新踩一遍**
> —— `docs/evidence/` 里那些文件就是这么来的。
