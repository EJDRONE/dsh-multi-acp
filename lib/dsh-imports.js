/**
 * 宿主包解析工具。
 *
 * 插件不能假定 DSH 的包在自己的 node_modules 里 —— 必须从**正在运行的 profile** 解析。
 * 参考实现：dsh-grok-acp 的 lib/dsh.js（📖 已读源码）。
 *
 * ⚠️ 与 grok 版的差异：
 *   - grok 硬编码 `profiles/web`；本插件按实际 profile 解析（桌面版是 `desktop`）
 *   - grok 用 `HOME`；Windows 上是 `USERPROFILE`
 *
 * @module dsh-multi-acp/dsh-imports
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Cordis 的 traced service 解包符号。
 *
 * ✅ 实测：DSH 0.2.0-rc.2 的 `agents.setFactory` 内部用
 *    `const target = factory[symbols.original] ?? factory`，符号就是 `Symbol.for('cordis.original')`。
 */
export const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/** 解包一个可能是 traced proxy 的 cordis 服务，拿到具体对象。 */
export function unwrapService(service) {
  if (service === null || service === undefined) return service
  return service[CORDIS_ORIGINAL] ?? service
}

/** 宿主 home 目录（跨平台）。 */
export function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd()
  return join(home, '.dsh')
}

/** 当前 profile 名。可用 DSH_PROFILE 覆盖；默认 desktop。 */
export function dshProfile() {
  return process.env.DSH_PROFILE ?? 'desktop'
}

/**
 * 构造解析 DSH 宿主包的 require。
 *
 * 依次尝试：profile 目录 → DSH home → 本插件自身。
 * 这样 bundle 里带的包（打包进 app.asar 的那些）能在两种部署下都解析到。
 */
export function hostRequire() {
  const home = dshHome()
  const roots = [
    join(home, 'profiles', dshProfile()),
    home,
    process.cwd(),
  ]
  const from = roots.find((r) => existsSync(r)) ?? process.cwd()
  return createRequire(join(from, 'noop.js'))
}

const moduleCache = new Map()

/**
 * 从宿主解析并动态 import 一个 DSH 包。
 * @param {string} specifier 例如 '@deepseek-ai/dsh-agent'
 */
export async function importFromDsh(specifier) {
  if (moduleCache.has(specifier)) return moduleCache.get(specifier)
  const req = hostRequire()
  let resolved
  try {
    resolved = req.resolve(specifier)
  } catch (error) {
    throw new Error(
      `dsh-multi-acp: cannot resolve host package "${specifier}" from ` +
        `${dirname(req.resolve('./noop.js') || process.cwd())} — ` +
        `is this plugin installed into the right profile? (${String(error?.message ?? error)})`,
    )
  }
  const mod = await import(pathToFileURL(resolved).href)
  moduleCache.set(specifier, mod)
  return mod
}

/**
 * 探测一组宿主符号是否可用 —— 供启动自检 / 试连报告使用。
 *
 * 用途：0.2.0-rc.2 相对 0.1.1-rc.2 变了若干内部结构
 * （例如 `Inbox` 已从 `@deepseek-ai/dsh-agent` 移出，成为 agent-loop 内部的
 * 持久化 projection）。本函数把这些差异**显式化**，避免静默失败。
 */
export const REQUIRED_HOST_SYMBOLS = [
  { pkg: '@deepseek-ai/dsh-agent', names: ['agentEvents', 'emitAgentEvent'] },
  { pkg: '@deepseek-ai/dsh-session', names: ['SessionPreparation', 'interruptedTurnClosers'] },
  { pkg: '@deepseek-ai/dsh-scope', names: ['createScope'] },
  {
    pkg: '@deepseek-ai/dsh-llm',
    names: ['createAssistantMessage', 'createUserMessage', 'createToolResultMessage', 'AssistantStreamAccumulator', 'errorChain'],
  },
]

export async function probeHostSymbols() {
  const report = []
  for (const { pkg, names } of REQUIRED_HOST_SYMBOLS) {
    try {
      const mod = await importFromDsh(pkg)
      const missing = names.filter((n) => mod[n] === undefined)
      report.push({ pkg, ok: missing.length === 0, missing, available: names.filter((n) => mod[n] !== undefined) })
    } catch (error) {
      report.push({ pkg, ok: false, missing: names, error: String(error?.message ?? error) })
    }
  }
  return report
}
