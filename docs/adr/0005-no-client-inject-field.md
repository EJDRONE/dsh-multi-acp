# ADR-0005 · 客户端半边不声明 `dsh.client.inject`

- **状态**：已接受（2026-10-10）
- **证据等级**：实测
- **相关**：`lib/client.js`、`test/client-bundle.test.mjs`、discussion #5899

## 背景

社区讨论 #5899（「out-of-tree browser-half bundle 模板」）里的回复建议插件在
`package.json` 声明：

```json
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-ui-conversation", ...] } }
```

我最初据此把它列为待补字段。但读宿主自己的实现后，**语义与那个建议的解读相反**。

实测（在 `D:\Programs\Deepseek\resources\app.asar` 内检索到两处）：

1. 宿主的源码注释原文：

   > Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client
   > package as a module; **`dsh.client.inject` entries only order activation and stay allowed**.

   —— 即：`inject` 是**激活顺序**，**不是**"模块导入白名单"。

2. 宿主加载器的校验代码：

   ```js
   const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject)
   const external = optionalStringArray(pkgName, "dsh.client.external", decl.external)
   ```

   即二者都是**可选**的字符串数组。

3. 活样例对照：本机 `@weibaohui/experts-management@0.5.10`（同为 `slots` + `locale` 用法）
   的 `dsh.client` **只有 `{ platform: "web" }`**，没有 `inject`。

4. 本仓库的 `lib/client.js` 只 `require('react')`（加载器 seeded require table 提供的平台模块），
   **不 import 任何 `@deepseek-ai/*` 客户端包**；全部宿主集成走 `ctx.slots` / `ctx.locale`
   这两个**运行时服务**。

## 决定

**不声明 `dsh.client.inject`**，保持 `dsh.client = { platform: "web" }`；并用测试把它钉住：

- 断言 `pkg.dsh.client` 就是 `{ platform: 'web' }`；
- 断言 bundle 源码里**不出现** `require('@deepseek-ai/...')`。

同时保留一条**真正的**客户端契约检查（这才是当年真正出过事故的地方）：
`factory()` 返回的模块必须**静态声明** `inject: ['slots', 'locale']` ——
Cordis 对未声明 inject 的服务属性访问**直接抛错**，且 `ctx.locale && …` 这类守卫救不了
（抛在读属性那一刻）。漏过一次 → 客户端入口激活失败 → **整个 web boot 中止、DSH 无法启动**。

## 后果

**正面**

- 不做无意义（而且可能有害）的声明：空数组虽可能无害，但一旦有人照抄去填真实包名，
  就变成"声明了并不 import 的东西"，语义与激活顺序耦合起来更难推理。
- 用一条**可执行的**契约测试替代"照社区建议抄字段"。

**负面 / 已知代价**

- 若未来 bundle 开始 import Harness Client 包（例如要用 `dsh-client-ui-primitives`），
  **必须**重新评估本 ADR —— 那时 `inject` 才有意义。
- 手写 bundle 没有构建器帮忙保证 wrapper 形状。**缓解**：`test/client-bundle.test.mjs`
  真的把 bundle 在假 `window` 里跑一遍，断言 `id` / `factory` 形状 / `apply` 注册行为，
  而不是断言源码文本。

## 替代方案与为何不选

| 方案 | 为何不选 |
| --- | --- |
| 照抄一份真实包名列表进 `inject` | 会声明并不 import 的包，制造语义错误的先例；且 #5899 那条建议本身是"模板示例"，不是本插件的事实。 |
| 声明空数组 `inject: []` | 与"不声明"在当前加载器下等价，但会让人以为字段已被有意配置过。少写一个字段比写一个空字段更诚实。 |
| 引入 esbuild 生成 bundle | 约定只要求 `__ModuleLoader__.load({ id, factory })` 这层 wrapper；手写（无 JSX，用 `React.createElement`）实测可行，省掉整条构建链与断链风险。 |

## 补记（2026-10-10）：**不做文件级拆分**

Q6 批次二在拆 `acp-agent.js` 的同时，评估过把 `client.js` 拆成
`state` / `render` / `transport` / `editors` 四块。**结论：不拆，保持单文件。**

**为什么这不是"暂时没做"，而是结构性不可行**：

`window.__ModuleLoader__.load({ id, factory })` 里的 `factory(require)` —— 那个 `require`
解析的是**加载器 seeded 的 require table**（`react` / `react-dom/http` / Harness Client 平台模块），
**不是文件系统**。浏览器里没有 fs，bundle 也拿不到自己的兄弟文件。
所以 `factory` 内部**无法** `require('./state.js')`。

⇒ 拆文件的前提是**引入开发侧构建**（把多源文件合成一个 bundle）。
而这恰好推翻本 ADR 的原始决定：`lib/client.js` 会从「可原地编辑的源」变成「生成物」，
从此每次改动都要 *改源 → 构建（换 inode）→ `install.ps1 -Sync`*，
直接踩上 `AGENTS.md` §2 记录的那条**断链陷阱**。

**收益/代价**：B 把最大单文件从 1287 行降到 ~300 行、源文件可在 Node 里单测；
代价是把一条已验证的改码循环换成一条更容易出错的。
**判断：不划算。** 单文件本身不是缺陷 —— 它内部已有清晰分段，
且有 `test/client-bundle.test.mjs` 的 7 条契约测试护着。

**若将来要翻这个决定**，触发条件应当是「客户端半边复杂度显著上升」或「确实需要 piecewise 单测」，
而不是"文件太长"。翻的时候必须同时：加构建脚本、把 `lib/client.js` 标记为生成物、
并在 `AGENTS.md` 的改码循环里写清"改客户端要构建 + 重新硬链接"。
