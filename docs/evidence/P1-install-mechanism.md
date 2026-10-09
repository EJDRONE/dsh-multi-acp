# 证据：DSH Desktop 插件安装机制（实测）

> 全部结论均来自 2026-10-07 在 DSH Desktop 0.2.0-rc.2 上的实测与失败复盘。
> 环境：`DSH_HOME = D:\Ecode\.dsh`，profile = `desktop`，app = `D:\Programs\Deepseek\`

---

## 1. 插件树的实际来源：`package.json → dsh.profile.bundles`

**这是最重要的发现，也是第一轮失败的根因。**

```
<profile>/package.json
├── dependencies { ..., "dsh-multi-acp": "file:..." }   ← 包的存在
└── dsh.profile.bundles [ ..., "dsh-multi-acp" ]        ← 真正决定"加载谁"
```

| | 加在哪 | 效果 |
| --- | --- | --- |
| `cordis.patch.yml` 里加一行 `- id: x / name: y` | 只是**配置覆盖** | ❌ 指向一个从未被加载的包 → **什么都不会发生** |
| `dsh.profile.bundles` 里加一项 | 决定插件树 | ✅ 生效 |

**证据**：对比 4 个工作正常的插件（`experts-management` / `dsh-opencode-go` / `dsh-tabbit` /
`@wingsky-1/dsh-mcp-manager`）—— **全部同时出现在 `dependencies` 和 `dsh.profile.bundles`**。
我们最初只在 `cordis.patch.yml` 加行 → 插件页根本不认识它。

**推论**：`cordis.patch.yml` 里的行（如 `- id: opencode-go`）是对 **bundle 自带 patch 所插入行**的
config 覆盖，不是加载入口。grok 的 `dsh.bundle.patch` 用 `insert:` 插入自己的行，属同一机制。

---

## 2. 插件必须经 **pnpm** 安装

profile 是 pnpm 管理的：

```
<profile>/pnpm-lock.yaml            ✅
<profile>/node_modules/.pnpm        ✅  虚拟存储
<profile>/node_modules/.modules.yaml ✅
<profile>/.plugin-manager/logs/**/pnpm.log   ← 插件管理器驱动的就是 pnpm
```

**手工建 junction 绕过 pnpm 簿记 → loader 看不见**（第二轮失败的根因）。
正确做法：把依赖写进 `package.json`，然后 `pnpm install`。

---

## 3. ⚠️ pnpm 用**硬链接** —— 这决定了迭代方式

`node_modules/dsh-multi-acp/` 里的文件与插件源码是**硬链接**（同一 inode）。
实测证据：`Copy-Item` 会报 **"无法用自身覆盖项 / cannot overwrite an item with itself"**。

### 由此推出的迭代规则

| 改动方式 | 是否保留硬链接 | 是否自动同步到已安装位置 |
| --- | --- | --- |
| **`Edit`（原地修改）** | ✅ 保留 | ✅ **自动生效** |
| **`Write`（整体重写）** | ❌ **断链** | ❌ **不会同步** |
| 手工 `copy /y` | — | ❌ 常被"文件被占用"挡住，**不可靠** |

**真实踩到**：用 `Write` 写诊断桩后，桩根本没进应用 —— 白等一轮。
**真实踩到**：用 `copy /y` 同步 8 个文件，7 个因"being used by another process"失败 →
已安装位置处于**新旧混合**状态 → 该次测试结论无效。

### 正确的同步方式

```powershell
# package.json 变了，或想强制重同步：
cd <profile>; pnpm install
# 或彻底重建：
Remove-Item -Recurse -Force <profile>\node_modules\dsh-multi-acp; pnpm install
```

**绝不要手工 copy。**

---

## 4. 宿主侧插件的日志**无法从文件获取**

| 尝试 | 结果 |
| --- | --- |
| `AppData\Roaming\DSH Desktop\logs\` | 最新 08-22，旧 |
| `AppData\Roaming\dsh-desktop\logs\main.log` | **路径不存在** |
| `--enable-logging --v=1` + stdout/stderr 重定向 | 只有 Chromium verbose + **渲染进程** console（能看到 `[dsh-mcp-manager]` 这类**客户端**插件日志） |
| `NODE_ENV=development` + 重定向 | 同上 |
| stdout | 仅 124~2076 字节，是自动更新器的输出 |

**结论**：宿主侧（主进程）插件的加载日志**没有落盘、也没进我们可捕获的通道**。
插件页只显示「异常 / 运行中」，不给错误细节，且**点不开**。

### 唯一的可靠出路：让插件**自己报错**

`lib/index.js` 是一个**薄加载器**：

```js
export const name = 'dsh-multi-acp'
export const inject = ['agents', 'agentPresets', 'sessions', 'commands']  // 静态声明

export async function apply(ctx, config) {
  try {
    const impl = await import('./index.impl.js')   // ← 动态 import，失败可捕获
    return await impl.apply(ctx, config)
  } catch (error) {
    report(`FAILED at "${stage}"\n${error?.stack}`)  // → <DSH_HOME>/multi-acp/load-report.txt
  }
}
```

**原理**：Cordis 用静态 import 时，模块求值期抛错**根本无法捕获** —— 插件只会静默变成
「启动失败」。动态 import 把错误变成**可捕获的 Rejection**，从而能落盘完整堆栈。

**这一招直接定位到了根因**（见 §5）。**建议长期保留此结构**。

---

## 5. 从这次失败里得到的两个 Cordis 陷阱

```js
// ❌ 陷阱 1：对 Cordis traced 代理做 JSON.stringify
`shape (${JSON.stringify(originalSlot)})`
// → Error: cannot get property "toJSON" without inject
//    at JSON.stringify  at index.impl.js:163:69
//    Cordis 对**未声明 inject 的属性直接抛错**，`.toJSON` 也不例外
//    后果：防御性错误信息自身崩溃 → 插件恒定「启动失败」→ 真正的故障被掩盖

// ❌ 陷阱 2：AgentFactory 是对象，不是函数
if (typeof slot.target !== 'function') { /* 误判！ */ }
// → 官方类型：AgentFactory = { createAgent(...), resume(...) }
//   正常情况被判为异常，进而走进陷阱 1 的那个会崩的分支
```

**修法**：

```js
const looksLikeFactory =
  target !== null && typeof target === 'object' &&
  typeof target.createAgent === 'function' && typeof target.resume === 'function'

// 描述未知值一律用安全函数：只读自有属性名与 typeof，绝不 JSON.stringify
const describeShape = (v) => { /* ... Object.getOwnPropertyNames + typeof ... */ }
```

**通用教训**：
1. **错误处理路径本身必须绝对安全** —— 它只在异常时执行，一旦崩掉就永久掩盖真因
2. **不要对宿主框架的代理对象做序列化**
3. 类型判断要照**官方类型定义**，不要凭直觉（`AgentFactory` 是对象）

---

## 6. 诊断方法论：最小桩 + 二分法

```
step 1  最小桩：inject: []、不 import 任何自家模块、apply() 只写标记文件
        → ✅ 通过 ⇒ 包清单 / 入口 / 注册 都没问题
step 2  桩 + 真实 inject 列表（4 个服务名）
        → ✅ 通过 ⇒ 服务名全部有效，排除 "Cordis 永等未满足的 inject"
step 3  恢复真实实现 + 动态 import 加载器
        → ❌ 拿到确切堆栈 ⇒ 定位到 JSON.stringify / 类型守卫
```

**每一步都让插件"自己写文件报告"**，从而**无需人工目视**即可判定 —— 这是宿主侧插件
在日志不可得时的唯一高效路径。

---

## 7. 其他实测事实

| 项 | 值 |
| --- | --- |
| Desktop 是否自带 CLI | ❌ `app.asar\dsh` 是 `@deepseek-ai/dsh-desktop-runtime`，**没有 bin**；全局 `@deepseek-ai/dsh` 也已不在 npm 目录 |
| `ELECTRON_RUN_AS_NODE=1` + 应用 exe | ✅ 可当 Node 运行时用（Node v24.18.1） |
| 启动参数结构 | `DeepSeek Harness.exe --expose-internals <desktop-host 入口> <dshRoot> <profileDir> <runtime> <pnpm> <bin>` |
| **DSH 的 Web UI** | 启动日志里有 `dsh web: http://127.0.0.1:19387/?token=…`（**有本地 HTTP 接口**，但曾观察到无监听端口，需进一步确认） |
| 插件页显示 | 包级版本号 + 组件级「运行中 / 异常 / 启动失败」，**异常点不开** |
| 会话持久化 | `sessions\**.jsonl.zstd` 持续落盘 → **重启不丢会话** |

---

## 8. 最终确立的流程

```powershell
# 安装（首次）
powershell -File tools\install.ps1        # 备份 → 写 package.json → pnpm install → 追加配置行 → 校验

# 日常迭代（改源码后）
#   1. 改 lib\*.js —— 优先用 Edit（保留硬链接，自动同步）
#   2. 若用了 Write 或改了 package.json：
cd D:\Ecode\.dsh\profiles\desktop; pnpm install
#   3. 升版本号（package.json version）  ← 用户明确要求，唯一可靠的"新版是否加载"判据
#   4. 重启 DSH Desktop

# 回滚（覆盖全部 4 处改动）
powershell -File tools\rollback.ps1
```

**版本号是唯一可靠的判据**：pnpm 硬链接让"已生效"和"没生效"在文件层面无法区分，
只有插件页显示的版本号能证明应用读到了哪一版。
