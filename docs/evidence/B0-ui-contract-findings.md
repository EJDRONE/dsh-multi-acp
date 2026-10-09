# B0 · 引擎管理 UI 契约核实

> 执行日期：2026-10-08
> **主源**：官方源码稀疏克隆 `refs/harness`（`packages/host` / `packages/client`，HEAD `dsh-v0.2.1-alpha.1`）
> **活样例**：已安装的 `@weibaohui/experts-management@0.5.10`（host `src/index.js` + client `client/bundle.js` / `client/index.js`）

---

## 1. 宿主 HTTP 路由：`ctx.webServer`

`packages/host/webserver/src/index.ts:125,166`

```ts
export class WebServer extends Service { constructor(ctx){ super(ctx, 'webServer') } }

register(route: {
  kind: 'exact' | 'prefix'          // prefix p 匹配 p 与 p/<anything>
  path: string                      // 绝对路径，无尾斜杠
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}): () => void                       // 返回 disposer
```

- **handler 自己拥有完整响应生命周期**（写 head / body / 保持连接）。
- 路由是精确/前缀两表，**重复 (kind,path) 抛错**。
- 活样例：`experts-management/src/index.js:868`
  ```js
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/experts-management/api', handler }), '…')
  ```
  handler 内按 `req.method` + `new URL(req.url).pathname` 自己分发。
- `inject` 里声明 `'webServer'`。
- 认证/同源由外层（SPA 的 auth 中间件）负责；路由 handler 不做鉴权（样例亦如此）。

## 2. 客户端插件：加载器与挂载

### 2.1 打包产物形态（loader 约定）

活样例 `experts-management/client/bundle.js` 的**首尾**即是约定：

```js
window.__ModuleLoader__.load({
  id: "@weibaohui/experts-management",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")          // ← loader 提供的平台模块（seeded require table）
    /* … bundle 正文（其余依赖已内联）… */
    return module.exports
  }
})
```

- `require('react')` / `require('react-dom/client')` / `require('@deepseek-ai/dsh-client-ui-primitives')`
  由**加载器的 seeded require table** 提供，**不打进 bundle**。
- `window.__ModuleLoader__` 由 `@deepseek-ai/dsh-client-modules` 提供。
- 样例用 esbuild 生成 bundle；**但约定只要求这层 wrapper** —— 手写（无 JSX，用 `React.createElement`）
  同样成立，可省掉构建工具链。

### 2.2 客户端插件导出与注册

活样例 `client/index.js:1368`

```js
module.exports = {
  name: CLIENT_NAME,
  inject: ['slots', 'locale'],         // ⚠️ 必须静态声明（见下）
  apply(ctx) { … },                    // 注册 slot / locale
  __boot(container, opts) { … },       // 可选：独立挂载
}
```

> ⚠️ **必须静态声明 `inject`**：Cordis 对**未声明 inject 的服务属性访问直接抛错**
> （`cannot get property "locale" without inject`），且**`ctx.locale && …` 这类守卫救不了** ——
> 抛错发生在**属性读取**那一刻。本插件曾漏声明 `['slots','locale']`，导致客户端入口激活失败、
> **web boot 整体中止、DSH 无法启动**（见 CHANGELOG 0.1.12）。**要用的服务一律写进 `inject`。**

注册一个设置分区（样例用它做「专家管理」页）：

```js
ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: CLIENT_NAME,
  order: 91,
  locale: NS,
  label: () => t('title'),
  inject: () => ({}),
}, function SettingsSectionSlot() { return h(SettingsSlotComponent, { __t: t }) })), '…')
```

- **slot 名以字符串传入**；`ctx.slots.inject(name, () => register(spec, Component))`。
- 已知 slot（来自活样例）：**`settings.section`**（设置页分区）、`conversation.input.left`（输入框工具栏）。
- i18n：`ctx.locale.register(ns, 'zh'|'en', dict)`；`ctx.locale.bind(ns)` 取绑定翻译。
- 数据面：客户端 `fetch('/<plugin>/api/...')` 打回 host 路由（同源）。

## 3. package.json 清单约定

活样例：

```jsonc
{
  "main": "src/index.js",
  "exports": { ".": "./src/index.js", "./client": "./client/bundle.js", "./package.json": "./package.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }
}
```

→ 本插件需补：`exports['./client']`（指向 bundle）与 `dsh.client.platform = 'web'`。

## 4. ⚠️ 发现：**反向索引「绑定此引擎的专家」没有数据源**

UI-DESIGN §3.2 假设专家包 `plugin.json` 里有 `agentPreset === 'acp-<engineId>'`。
**实测不成立**：`D:\Ecode\.dsh\experts\*\*.codebuddy-plugin\plugin.json` 的字段是
`expertType / agentName / teamInfo / agents / skills / members / displayName / …`，
**没有 `agentPreset`、也没有任何 `preset`/`engine` 绑定字段**（全库 grep `agentPreset|acp-*` = 0 命中）。

→ B2 的 `GET /:id/bound-experts` 目前只能返回**空集 + 说明**；要真正实现，需先定义
"专家 ↔ 预设/引擎" 的绑定机制（另立设计项）。

## 5. 其它事实

- `@deepseek-ai/*` 包在 `profiles\node_modules` 里是**悬空 junction**（目标 `nvm\…\dsh\node_modules\…` 不存在）；
  host 包在**运行时**可解析（asar 里含 `NODE_PATH` 处理），但**普通 Node 解析不到** ——
  所以 B0 的源码读自 clone，而非安装目录。
- `@deepseek-ai/dsh-client-ui-slots` 同属悬空 junction；其上 `SlotMap` 是 **module-augmentation** 空接口，
  真实 slot 名由各 `ui-*` 包声明 —— 因此**读活样例**是最可靠的取法。
