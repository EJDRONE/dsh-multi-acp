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
 */

import { existsSync, readFileSync } from 'node:fs'
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
const resolved = PACKAGES.map((specifier) => ({ specifier, ...resolveHostPackage(specifier) }))
const symbols = await probeHostSymbols()

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
