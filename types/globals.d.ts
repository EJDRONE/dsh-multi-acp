/**
 * 手写全局声明 —— 只声明**运行时真实存在但 Node/DOM 类型里没有**的东西。
 *
 * 这里声明的是 `lib/client.js` 依赖的浏览器半边加载器契约。
 * 证据（实测）：`docs/evidence/B0-ui-contract-findings.md` §2.1 ——
 * 活样例 `@weibaohui/experts-management/client/bundle.js` 的首尾就是这条约定，
 * `window.__ModuleLoader__` 由 `@deepseek-ai/dsh-client-modules` 提供。
 */

/** 加载器注入的 require：只解析 seeded require table 里的平台模块（如 `react`）。 */
type ModuleLoaderRequire = (id: string) => unknown

interface ModuleLoaderSpec {
  /** 包名。必须与 package.json 的 `name` 一致 —— 加载器用它做模块表键。 */
  id: string
  /**
   * 惰性 CJS 工厂。**不在 load 时执行**；模块正文的副作用（含 CSS 注入）在
   * 模块被物化时才跑。
   */
  factory: (require: ModuleLoaderRequire) => unknown
}

interface Window {
  __ModuleLoader__: {
    load(spec: ModuleLoaderSpec): void
  }
}
