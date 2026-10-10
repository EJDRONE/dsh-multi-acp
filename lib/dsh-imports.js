/**
 * 宿主包解析工具。
 *
 * 插件不能假定 DSH 的包在自己的 node_modules 里 —— 必须从**正在运行的 profile** 解析。
 *
 * ⚠️ 与 grok 版的差异：
 *   - grok 硬编码 `profiles/web`；本插件按实际 profile 解析（桌面版是 `desktop`）
 *   - grok 用 `HOME`；Windows 上是 `USERPROFILE`
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ **解析到哪一份，取决于"谁在跑"** —— 完整记录见 `docs/adr/0003-host-package-resolution.md`
 *
 * | 上下文                     | 实际命中                              | 结论       |
 * | -------------------------- | ------------------------------------- | ---------- |
 * | 宿主进程内                 | 宿主自带运行时（实测 0.2.0-rc.2）      | ✅ 正确    |
 * | 宿主外（裸 node / 验证脚本）| `profiles/node_modules` 的 junction    | ❌ 旧版本  |
 *
 * 实测证据（2026-10-10）：
 *   - 宿主进程内 `trace.log` 的 `factory.createAgent.contract` = **ok:true ×12/12**；
 *   - 同一个 `probeHostSymbols()` 用**裸 node** 跑，报
 *     `@deepseek-ai/dsh-llm 缺 AssistantStreamAccumulator`；
 *   - 而该符号在 0.2.0-rc.2 里由 `export * from './assistant-stream.ts'` 提供
 *     （`npm pack @deepseek-ai/dsh-llm@0.2.0-rc.2` 核实）——**是假阴性**，
 *     根因是那棵 junction 指向全局 `@deepseek-ai/dsh@0.1.1-rc.2` 的 `node_modules`。
 *
 * 因此本模块的硬规矩：**任何"宿主契约"结论都必须连同 `resolved` + `version` 一起报告**。
 * 只报"缺什么"而不报"我对谁说的"，就只是关于某个不确定版本的说法。见 `resolveHostPackage()`。
 *
 * @module dsh-multi-acp/dsh-imports
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

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
 * 解析锚点目录 —— 依次尝试：profile 目录 → DSH home → cwd。
 *
 * 单独暴露是因为**报错信息需要它**：旧实现用 `req.resolve('./noop.js')` 去反推锚点，
 * 而那个文件并不存在 → `require.resolve` 自己抛 MODULE_NOT_FOUND，
 * 把真正的失败原因（"包解析不到"）盖成一个毫无信息量的错误。见下方 `importFromDsh`。
 */
export function hostResolveAnchor() {
  const home = dshHome()
  const roots = [join(home, 'profiles', dshProfile()), home, process.cwd()]
  return roots.find((r) => existsSync(r)) ?? process.cwd()
}

/**
 * 构造解析 DSH 宿主包的 require。
 *
 * 锚点是 profile 目录（官方文档的宿主共享语义就建立在这上面）。注意它**不会**
 * 走进 Desktop 的 `app.asar` —— 这正是上表里"宿主外解析到旧版本"的机制。
 */
export function hostRequire() {
  return createRequire(join(hostResolveAnchor(), 'noop.js'))
}

const moduleCache = new Map()

/**
 * 只做**解析**（不 import）：拿到绝对路径与版本，用于诊断/自检。
 *
 * @param {string} specifier 例如 '@deepseek-ai/dsh-agent'
 * @returns {{ ok: boolean, specifier: string, resolved?: string, version?: string, from: string, error?: string }}
 */
export function resolveHostPackage(specifier) {
  const from = hostResolveAnchor()
  try {
    const pkgJson = hostRequire().resolve(`${specifier}/package.json`)
    let version
    try {
      version = JSON.parse(readFileSync(pkgJson, 'utf8')).version
    } catch {
      version = undefined
    }
    return { ok: true, specifier, resolved: pkgJson, version, from }
  } catch (error) {
    return {
      ok: false,
      specifier,
      from,
      error: String(error?.code ?? error?.message ?? error),
    }
  }
}

/**
 * 从宿主解析并动态 import 一个 DSH 包。
 *
 * 每条缓存项同时记录**解析来源与版本**，供上层把"我对着谁说这话"讲清楚。
 *
 * @param {string} specifier 例如 '@deepseek-ai/dsh-agent'
 */
export async function importFromDsh(specifier) {
  if (moduleCache.has(specifier)) return moduleCache.get(specifier)
  const probe = resolveHostPackage(specifier)
  if (!probe.ok || !probe.resolved) {
    throw new Error(
      `dsh-multi-acp: cannot resolve host package "${specifier}" from ${probe.from} — ` +
        `is this plugin installed into the right profile? (${probe.error})`,
    )
  }
  const entry = hostRequire().resolve(specifier)
  const mod = await import(pathToFileURL(entry).href)
  moduleCache.set(specifier, mod)
  resolvedVersions.set(specifier, probe)
  return mod
}

/** specifier → 上一次解析到的路径/版本（诊断用）。 */
const resolvedVersions = new Map()

/** 已解析过的宿主包 → 来源与版本；`probeHostSymbols()` 把它并进报告。 */
export function resolvedHostPackages() {
  return Object.fromEntries(resolvedVersions)
}

/**
 * 形如 `0.2.0-rc.2` 的**具体版本**。范围/通配（`>=0.2.0-rc.2 <0.3.0`、`^1.2.3`、`*`）
 * 一律不算 —— 它们不能当"解析对了吗"的基准。
 */
const CONCRETE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * 宿主**期望**版本 —— 判断"解析对了吗"的基准，**只返回具体版本**。
 *
 * 顺序：
 *   1. `DSH_HOST_VERSION` 环境变量（给 CI / 脚本一个显式基准）；
 *   2. **宿主进程内**：`process.execPath` 旁的 `resources/runtime/runtime.json#desktopVersion`
 *      —— 它描述的就是**当前跑着的**宿主，最权威；
 *   3. 本插件 `package.json` 的 `engines.dsh` —— **只有在写成精确版本时**才可用；
 *   4. 都给不出 → `undefined`，即"基准未知"。
 *
 * ⚠️ 早期实现把 `engines.dsh` 的**范围**当基准去 `===` 比较，得到
 * "cordis 4.0.1 ≠ 宿主 >=0.2.0-rc.2 <0.3.0" 这种毫无意义的结论 —— 必须避免。
 * 拿不到具体版本时，正确行为是**说"无法判定"**，而不是假装判定了。
 */
export function expectedHostVersion() {
  const override = process.env.DSH_HOST_VERSION
  if (override) return { version: override, source: 'env DSH_HOST_VERSION' }

  // 候选顺序（**实测 2026-10-10，宿主进程内**）：
  //   Desktop 真正的那个在 `resources/runtime/primary-runtime/runtime.json`；
  //   `resources/runtime/` 下只有 `versions.json`（没有 desktopVersion）。
  //   第一版只试了后者 → 宿主内 `expected` 恒为 null，自检永远报"期望未知"（实测发现）。
  const runtimeCandidates = [
    join(dirname(process.execPath), 'resources', 'runtime', 'primary-runtime', 'runtime.json'),
    join(dirname(process.execPath), 'resources', 'runtime', 'runtime.json'),
  ]
  for (const runtimeFile of runtimeCandidates) {
    try {
      const parsed = JSON.parse(readFileSync(runtimeFile, 'utf8'))
      const version = parsed?.desktopVersion
      if (CONCRETE_VERSION.test(version ?? '')) return { version, source: runtimeFile }
    } catch {
      /* 试下一个候选；裸 node 下两个都不存在 —— 正常 */
    }
  }

  const pkgFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  try {
    const declared = JSON.parse(readFileSync(pkgFile, 'utf8'))?.engines?.dsh
    if (CONCRETE_VERSION.test(declared ?? '')) return { version: declared, source: `${pkgFile}#engines.dsh` }
  } catch {
    /* ignore */
  }

  return { version: undefined, source: undefined }
}

/**
 * 探测一组宿主符号是否可用 —— 供启动自检 / 试连报告使用。
 *
 * 用途：0.2.0-rc.2 相对 0.1.1-rc.2 变了若干内部结构
 * （例如 `Inbox` 已从 `@deepseek-ai/dsh-agent` 移出，成为 agent-loop 内部的
 * 持久化 projection）。本函数把这些差异**显式化**，避免静默失败。
 *
 * ⚠️ 报告里**必须**带 `resolved`/`version`/`expected`：见模块头部的解析上下文表。
 * 少了它们，一次裸 node 跑出来的"缺符号"会被当成宿主真的缺 —— 那正是 2026-10-10
 * 发生过的假阴性。
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
  const expected = expectedHostVersion()
  const report = []
  for (const { pkg, names } of REQUIRED_HOST_SYMBOLS) {
    const probe = resolveHostPackage(pkg)
    try {
      const mod = await importFromDsh(pkg)
      const missing = names.filter((n) => mod[n] === undefined)
      report.push({
        pkg,
        ok: missing.length === 0,
        missing,
        available: names.filter((n) => mod[n] !== undefined),
        resolved: probe.resolved,
        version: probe.version,
        expected: expected.version,
        // 只有"解析到的版本 == 期望版本"时，这条结论才代表宿主。
        trustHost: probe.ok && probe.version !== undefined && probe.version === expected.version,
      })
    } catch (error) {
      report.push({
        pkg,
        ok: false,
        missing: names,
        resolved: probe.resolved,
        version: probe.version,
        expected: expected.version,
        trustHost: false,
        error: String(error?.message ?? error),
      })
    }
  }
  return report
}

/**
 * 把一次探测压成给日志/UI 的一句话 —— 关键是**先说清"对着谁"**。
 *
 * @param {Awaited<ReturnType<typeof probeHostSymbols>>} report
 */
export function summarizeHostProbe(report) {
  const bad = report.filter((r) => !r.ok)
  const versions = [...new Set(report.map((r) => r.version ?? '?'))]
  const expected = report[0]?.expected
  const trusted = report.every((r) => r.trustHost)
  const scope =
    trusted && expected
      ? `宿主 ${expected}`
      : `版本未知/不匹配（实测解析到 ${versions.join(', ')}，期望 ${expected ?? '未知'}）—— ` +
        '本次结论**不代表宿主**，请在宿主进程内重跑'
  if (bad.length === 0) return `宿主符号自检 OK（${scope}）`
  return `${bad.length} 个包缺符号（${scope}）：` + bad.map((b) => `${b.pkg}[${b.missing.join(', ')}]`).join('; ')
}
