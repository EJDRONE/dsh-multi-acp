#!/usr/bin/env node
/**
 * 宿主包解析诊断 —— 说清"这个进程解析到的是哪一份宿主"。
 *
 * ── 为什么需要它（ADR-0003）
 *
 * 本插件的宿主包解析有**三条路**，只有一条是真的：
 *
 * | 上下文                  | 实测命中                                   | 结论 |
 * | ----------------------- | ------------------------------------------ | ---- |
 * | 宿主进程内（真实运行）  | 宿主自带运行时 0.2.0-rc.2                  | ✅   |
 * | 宿主外裸 node（本脚本） | `profiles/node_modules` junction →         | ❌   |
 * |                         | 全局 `@deepseek-ai/dsh@0.1.1-rc.2`         |      |
 *
 * 后果实例：同一个 `probeHostSymbols()` 在裸 node 下报
 * `@deepseek-ai/dsh-llm 缺 AssistantStreamAccumulator`，而该符号在 0.2.0-rc.2 里
 * 由 `export * from './assistant-stream.ts'` 提供 —— **假阴性**。
 *
 * 因此：**任何在宿主外取得的"宿主契约"结论，都必须先跑本脚本**确认解析到的
 * dsh 版本 == 宿主版本；否则结论无效。
 *
 * 用法：
 *   node scripts/diagnose-host-resolution.mjs
 *   node scripts/diagnose-host-resolution.mjs --expect 0.2.0-rc.2
 *   node scripts/diagnose-host-resolution.mjs --json
 *
 * 环境变量：`DSH_HOST_VERSION` 等价于 `--expect`（宿主内运行时自动来自 runtime.json）。
 *
 * 退出码：
 *   0 = 解析到的 dsh 版本 == 宿主版本（结论**可用于验收**）
 *   1 = 不一致（结论不可用于验收 —— 这是"宿主外跑验证脚本"的常态）
 *   2 = 无法判定（宿主版本未知：裸 node 且未给 --expect）
 *
 * 另有一段**宿主外回退树审计**（ISSUE-14）：枚举整棵 `profiles/node_modules/@deepseek-ai`，
 * 报告条目数 / 悬空链接 / 过期包 / **其中本仓库会解析到的** / nvm 硬绑定。
 * 它**只测量、不处置，且不影响退出码**（那棵树由 DSH 维护，见 ADR-0003）。
 */

import { existsSync, readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  hostResolveAnchor,
  resolveHostPackage,
  expectedHostVersion,
  probeHostSymbols,
} from '../lib/dsh-imports.js'

/** dsh 家族 —— 它们与宿主同版本线，是唯一能做"版本 == 宿主"判定的集合。 */
const DSH_FAMILY = /^@deepseek-ai\/dsh-/
/** 独立版本线的包 —— 记录实际值，但不拿宿主版本去比。 */
const PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-llm',
]

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const expectIndex = argv.indexOf('--expect')
if (expectIndex !== -1 && argv[expectIndex + 1]) {
  process.env.DSH_HOST_VERSION = argv[expectIndex + 1]
}

/** 宿主自带的 `runtime.json`（只有进程真的跑在宿主里时才存在）。 */
function desktopRuntime() {
  try {
    const file = join(dirname(process.execPath), 'resources', 'runtime', 'runtime.json')
    if (!existsSync(file)) return null
    return { file, ...JSON.parse(readFileSync(file, 'utf8')) }
  } catch {
    return null
  }
}

const runtime = desktopRuntime()
const expected = expectedHostVersion()

/** nvm 版本目录（`…\nvm\v22.20.0\…`）—— 解析链可能**钉死**在某个版本上。 */
const NVM_VERSION_RE = /[\\/](v\d+\.\d+\.\d+)[\\/]/

/**
 * 审计一棵 `node_modules/@deepseek-ai`。
 *
 * @param {string} nm `…/node_modules`
 * @param {string | undefined} expectedVersion 宿主版本基准
 * @param {Set<string>} consumed 本仓库会解析的包名集合
 */
function auditTree(nm, expectedVersion, consumed) {
  const root = join(nm, '@deepseek-ai')
  if (!existsSync(root)) return { nm, root, present: false }

  /** @type {{name:string,kind:string,target:string|null,version?:string,dangling:boolean}[]} */
  const entries = []
  let names
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name)
  } catch (error) {
    return { nm, root, present: true, error: String(/** @type {any} */ (error)?.message ?? error) }
  }

  for (const name of names) {
    const link = join(root, name)
    let kind = 'dir'
    try {
      kind = lstatSync(link).isSymbolicLink() ? 'link' : 'dir'
    } catch {
      kind = 'gone'
    }
    let target = null
    try {
      // realpath 会跟着 junction/symlink 走；目标不存在 → 抛 → 视为悬空。
      target = realpathSync(link)
    } catch {
      target = null
    }
    let version
    if (target) {
      try {
        version = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version
      } catch {
        version = undefined
      }
    }
    entries.push({ name, kind, target, version, dangling: target === null })
  }

  const stale = entries.filter(
    (e) => expectedVersion !== undefined && e.version !== undefined && e.version !== expectedVersion,
  )
  let totalInNm = 0
  try {
    totalInNm = readdirSync(nm).length
  } catch {
    totalInNm = 0
  }
  return {
    nm,
    root,
    present: true,
    /** 该 node_modules 的**顶层条目数**（`profiles/node_modules` 上有近 250 条）。 */
    totalInNm,
    total: entries.length,
    links: entries.filter((e) => e.kind === 'link').length,
    resolvable: entries.filter((e) => e.target).length,
    dangling: entries.filter((e) => e.dangling).length,
    danglingSample: entries.filter((e) => e.dangling).slice(0, 8).map((e) => e.name),
    stale: stale.length,
    staleSample: stale.slice(0, 12).map((e) => `${e.name}@${e.version}`),
    /** 影响面：本仓库会解析到的那些包里，有多少是过期的。 */
    consumedStale: stale.filter((e) => consumed.has(`@deepseek-ai/${e.name}`)).map((e) => e.name),
    versions: [...new Set(entries.map((e) => e.version).filter(Boolean))].sort(),
    nvmTargets: [...new Set(entries.map((e) => NVM_VERSION_RE.exec(e.target ?? '')?.[1]).filter(Boolean))],
  }
}

/**
 * 回退树的整体审计（ISSUE-14 的测量段）。
 *
 * **关键区分**（实测 2026-10-10，本轮修正）：`profiles/node_modules/@deepseek-ai` 只有 3 条
 * **实目录**、零链接；真正提供旧版宿主包的是**上一级的共享树** `profiles/node_modules`
 * （40+ 插件共享，见 ADR-0003）→ 解析链落到 nvm 全局安装的嵌套依赖里。所以要**两棵都扫**。
 *
 * nvm 绑定不看树内条目，而看**解析结果**：路径里带版本号，钉死在哪一个 nvm 版本上。
 */
function auditFallbackTrees(anchor, expectedVersion, consumed, resolvedPaths) {
  const profileNm = join(anchor, 'node_modules')
  // DSH_HOME/profiles/node_modules —— 插件共享的扁平树（ADR-0003）。
  const sharedNm = join(dirname(anchor), 'node_modules')
  const trees = [profileNm, sharedNm]
    .filter((nm, i, all) => all.indexOf(nm) === i && existsSync(nm))
    .map((nm) => auditTree(nm, expectedVersion, consumed))

  const nvmVersionsInResolution = [
    ...new Set(resolvedPaths.map((p) => NVM_VERSION_RE.exec(p)?.[1]).filter(Boolean)),
  ]
  return {
    trees,
    /** 解析链钉死在哪个 nvm 版本（来自解析结果，不是树内条目）。 */
    nvmVersionsInResolution,
    activeNodeVersion: process.version,
    /** 解析链的 nvm 版本 ≠ 本进程 → 你一直在用**另一个版本**装的全局包。 */
    resolvedFromOtherNvm: nvmVersionsInResolution.length > 0 && !nvmVersionsInResolution.includes(process.version),
  }
}

const resolved = PACKAGES.map((specifier) => ({ specifier, ...resolveHostPackage(specifier) }))
const symbols = await probeHostSymbols()
const consumed = new Set([...PACKAGES, ...symbols.map((s) => s.pkg)])
const fallbackTrees = auditFallbackTrees(
  hostResolveAnchor(),
  expected.version,
  consumed,
  resolved.filter((r) => r.resolved).map((r) => /** @type {string} */ (r.resolved)),
)

const dshResolved = resolved.filter((r) => DSH_FAMILY.test(r.specifier))
const unresolved = resolved.filter((r) => !r.ok)
const mismatches = dshResolved.filter(
  (r) => expected.version !== undefined && r.version !== expected.version,
)
const dshVersions = [...new Set(dshResolved.filter((r) => r.ok).map((r) => r.version))]
const selfConsistent = dshVersions.length <= 1
const untrusted = symbols.filter((s) => !s.trustHost)

const undecidable = expected.version === undefined
const ok = !undecidable && mismatches.length === 0 && unresolved.length === 0 && selfConsistent

const report = {
  node: process.version,
  execPath: process.execPath,
  anchor: hostResolveAnchor(),
  desktopRuntime: runtime,
  expectedHostVersion: expected,
  resolved,
  fallbackTrees,
  dshVersionsResolved: dshVersions,
  selfConsistent,
  symbols,
  verdict: {
    ok,
    undecidable,
    mismatches: mismatches.map((m) => `${m.specifier}: 解析到 ${m.version}，宿主是 ${expected.version}`),
    unresolved: unresolved.map((u) => `${u.specifier}: ${u.error}`),
    untrustedSymbolProbes: untrusted.map((u) => u.pkg),
  },
}

if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exit(ok ? 0 : undecidable ? 2 : 1)
}

const line = (s = '') => process.stdout.write(s + '\n')
line('宿主包解析诊断')
line()
line(`  node              ${report.node}`)
line(`  process.execPath  ${report.execPath}`)
line(`  解析锚点          ${report.anchor}`)
line(
  `  宿主版本基准      ${expected.version ?? '(无法判定)'}` +
    (expected.source ? `  ← ${expected.source}` : ''),
)
line()
line('  各包实际解析结果：')
for (const r of resolved) {
  const family = DSH_FAMILY.test(r.specifier)
  const mark = !r.ok ? '✗' : !family ? '·' : expected.version && r.version !== expected.version ? '⚠' : '✓'
  line(`    ${mark} ${r.specifier.padEnd(38)} ${r.ok ? (r.version ?? '?') : `(${r.error})`}`)
  if (r.ok && r.resolved) line(`        ${r.resolved}`)
}
line()
line('  宿主符号自检：')
for (const s of symbols) {
  line(
    `    ${s.ok ? '✓' : '✗'} ${s.pkg.padEnd(38)} ${s.ok ? 'ok' : `missing [${s.missing.join(', ')}]`}` +
      `  trustHost=${s.trustHost}`,
  )
}
line()

if (fallbackTrees.trees.length > 0) {
  line('  宿主外回退树审计（ISSUE-14 的测量段 —— 只测量、不处置）：')
  for (const t of fallbackTrees.trees) {
    if (!t.present) continue
    line(`    ${t.nm}`)
    line(
      `      顶层条目 ${t.totalInNm} · @deepseek-ai ${t.total}（链接 ${t.links}）` +
        ` · 可解析 ${t.resolvable} · 悬空 ${t.dangling}` +
        (expected.version !== undefined ? ` · 过期 ${t.stale}` : ''),
    )
    if (t.versions.length > 0) {
      const shown = t.versions.slice(0, 6)
      line(
        `      版本：${shown.join(', ')}` +
          (t.versions.length > shown.length ? ` …（共 ${t.versions.length} 种）` : ''),
      )
    }
    if (t.staleSample.length > 0) line(`      过期样本：${t.staleSample.join(', ')}`)
    if (t.danglingSample.length > 0) line(`      ⚠️ 悬空样本：${t.danglingSample.join(', ')}`)
    if (t.consumedStale.length > 0) {
      line(`      ⚠️ 其中**本仓库会解析到**的过期包 ${t.consumedStale.length} 个：${t.consumedStale.join(', ')}`)
    }
    if (t.nvmTargets.length > 0) line(`      树内链接指向 nvm：${t.nvmTargets.join(', ')}`)
  }
  const nvm = fallbackTrees.nvmVersionsInResolution
  line(
    `    解析链的 nvm 绑定：${nvm.join(', ') || '(不在 nvm 版本目录下)'}；本进程 ${fallbackTrees.activeNodeVersion}` +
      (fallbackTrees.resolvedFromOtherNvm
        ? '  ⚠️ 不一致 —— 解析到的是**另一个 nvm 版本**装的全局包（钉死带版本号的绝对路径，' +
          '换版本不会悬空，但会一直用错的那一份）'
        : '  ✓ 一致'),
  )
  line('    说明：这些树由 **DSH 维护**、40+ 插件共享，本插件**从不写它**（ADR-0003）。')
  line()
}

if (ok) {
  line(`结论：解析到的 dsh ${dshVersions.join(', ')} == 宿主 ${expected.version} —— 本进程内的宿主契约结论**可用于验收**。`)
} else if (undecidable) {
  line('结论：宿主版本**无法判定**（进程不在宿主体内且未给 --expect）—— 不能据此验收任何宿主契约结论。')
  line('      裸 node 想判定，请显式给出基准：')
  line('        node scripts/diagnose-host-resolution.mjs --expect 0.2.0-rc.2')
  line('      而"解析到的不是宿主那一份"这一点本身已经可由下面的自洽性看出。')
  if (dshVersions.length === 1) {
    line(`      （dsh 家族自洽：全部 ${dshVersions[0]}）`)
  }
} else {
  line('结论：⚠️ 解析到的**不是宿主那一份** —— 本进程内取得的宿主契约结论**不可用于验收**。')
  for (const m of report.verdict.mismatches) line(`  · ${m}`)
  for (const u of report.verdict.unresolved) line(`  · ${u}`)
  if (!selfConsistent) line(`  · dsh 家族内部不一致：${dshVersions.join(', ')}`)
  if (mismatches.length > 0) {
    line()
    line('  成因：profiles/node_modules 下的 @deepseek-ai/* 是指向*全局 npm 安装*的绝对路径链接，')
    line('        内容取决于"谁在什么时候装的"；当前那棵树的宿主包来自旧版本线。')
    line('  处置：见 docs/adr/0003-host-package-resolution.md —— **不要手工改那棵树**。')
    line('  注意：宿主进程内解析是**正确**的（实测 contract ok:true ×12/12），真实会话不受影响；')
    line('        受影响的是**验证工具本身** —— 它的结论只对某个不确定版本成立。')
  }
}

process.exit(ok ? 0 : undecidable ? 2 : 1)
