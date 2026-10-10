#!/usr/bin/env node
/**
 * 回答一个此前**完全不可见**的问题：**profile 的 patch 到底让哪个配置生效？**
 *
 * ── 为什么需要它（ISSUE-16）
 *
 * 官方 `publish.zh.md` 的装配语义：非 `insert` 的 patch 行按 `id` 定位一个 Entry，
 * **整体替换它的 `config`**（不做深合并）。
 *
 * 于是 `tools/install.ps1` 早期追加的那段
 *
 * ```yaml
 * - id: multi-acp
 *   config:
 *     defaultEngine: ""
 *     verboseStartup: true
 * ```
 *
 * 并不是"只覆盖这两项" —— 它把 bundle patch 里的**其余所有键都清成了代码默认值**，
 * 其中包含 A16 那个关键调参 `promptTimeoutMs: 0`（不限总时长）。
 * 结果是：A16 修的"墙钟误杀长任务"在**本机从未生效**，而且没有任何地方会报错。
 *
 * 本脚本把「bundle 想要的」与「profile 实际生效的」逐键对比，并**区分**两种情况：
 *   · profile **显式**写了这个键（那是有意覆盖）
 *   · profile **没写**这个键（那是被静默清掉 —— 就是 ISSUE-16 的形态）
 *
 * 用法：
 *   node scripts/verify-profile-config.mjs
 *   node scripts/verify-profile-config.mjs --profile desktop
 *   node scripts/verify-profile-config.mjs --patch <某个 cordis.patch.yml>   # 对比历史/备份
 *   node scripts/verify-profile-config.mjs --json
 *
 * 退出码：0 = 生效配置与 bundle 意图一致（或差异都是**显式**覆盖）；1 = 存在被静默清掉的键。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import YAML from 'yaml'

import { dshHome, dshProfile } from '../lib/dsh-imports.js'
import { normalizeConfig, DEFAULT_CONFIG } from '../lib/config.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY_ID = 'multi-acp'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback
}
const profile = argOf('--profile', dshProfile())
const patchPath = argOf('--patch', join(dshHome(), 'profiles', profile, 'cordis.patch.yml'))

/** bundle patch 里有 `!!js` 表达式 —— 声明一个把它当字符串的 tag。 */
const JS_TAG = { tag: '!!js', resolve: (v) => String(v) }

function readPatch(file) {
  if (!existsSync(file)) return { file, doc: null, error: '文件不存在' }
  try {
    return { file, doc: YAML.parse(readFileSync(file, 'utf8'), { customTags: [JS_TAG] }) }
  } catch (error) {
    return { file, doc: null, error: `YAML 解析失败：${String(error?.message ?? error)}` }
  }
}

/** 从 patch 文档里按 id 找一行（`insert:` 里的也算）。 */
function findEntry(doc, id) {
  if (!Array.isArray(doc)) return undefined
  for (const row of doc) {
    if (Array.isArray(row?.insert)) {
      const hit = row.insert.find((r) => r?.id === id)
      if (hit) return hit
    }
    if (row?.id === id) return row
  }
  return undefined
}

const bundle = readPatch(join(repoRoot, 'cordis.patch.yml'))
const target = readPatch(patchPath)

const bundleCfg = findEntry(bundle.doc, ENTRY_ID)?.config
const targetCfg = findEntry(target.doc, ENTRY_ID)?.config

const bundleNorm = bundleCfg ? normalizeConfig(bundleCfg).config : null
const effectiveNorm = targetCfg ? normalizeConfig(targetCfg).config : bundleNorm

/**
 * 这些键在 **profile 里留空是受支持的等价形态**，不算"被清掉"：
 *   · `stateDir: ''` → `apply()` 会算成 `<DSH_HOME>/multi-acp`（见 `lib/index.impl.js`），
 *     与 bundle patch 里那个 `!!js` 表达式的结果一致（且多支持 `USERPROFILE` 兜底）。
 * 之所以要显式列出：bundle 里的值是 `!!js` 表达式，静态比较只能比**原文**，
 * 不列出来就会永远误报。**只列确实等价的，不要把这里当"忽略差异"的白名单。**
 */
const EQUIVALENT_WHEN_EMPTY = new Set(['stateDir'])

/** 逐键对比；`explicit` 表示 target 的 patch 里**显式**写了这个键。 */
const differences = []
if (bundleNorm && effectiveNorm) {
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const want = JSON.stringify(bundleNorm[key])
    const got = JSON.stringify(effectiveNorm[key])
    if (want === got) continue
    const explicit = Boolean(targetCfg && key in targetCfg)
    if (!explicit && EQUIVALENT_WHEN_EMPTY.has(key) && effectiveNorm[key] === '') continue
    differences.push({
      key,
      bundleValue: bundleNorm[key],
      effectiveValue: effectiveNorm[key],
      explicit,
    })
  }
}
const silent = differences.filter((d) => !d.explicit)
const ok = silent.length === 0

const report = {
  profile,
  patchFile: patchPath,
  bundlePatch: bundle.file,
  bundleEntryFound: Boolean(bundleCfg),
  targetEntryFound: Boolean(targetCfg),
  parseErrors: [bundle, target].filter((r) => r.error).map((r) => `${r.file}: ${r.error}`),
  usedDefaults: !targetCfg,
  differences,
}

if (asJson) {
  process.stdout.write(JSON.stringify({ ...report, ok }, null, 2) + '\n')
} else {
  const line = (s = '') => process.stdout.write(s + '\n')
  line('profile 生效配置核对（ISSUE-16）')
  line()
  line(`  profile patch   ${patchPath}${existsSync(patchPath) ? '' : '  ← 不存在'}`)
  line(`  bundle patch    ${bundle.file}`)
  for (const e of report.parseErrors) line(`  ⚠️ ${e}`)
  line()

  if (!bundleCfg) {
    line('bundle patch 里没有 multi-acp 行 —— 无法对比（本脚本按本仓库的 patch 形态设计）。')
  } else if (!targetCfg) {
    line('profile 里**没有** multi-acp 覆盖行 → 生效配置 = bundle patch 的那份。')
    line('（这是最省心的形态：少一处要同步的地方。）')
  } else {
    const keys = Object.keys(targetCfg)
    line(`  profile 覆盖行显式写了 ${keys.length} 个键：${keys.join(', ')}`)
    line()
    if (differences.length === 0) {
      line('生效配置与 bundle 意图**完全一致**。')
    } else {
      line('与 bundle 意图的差异：')
      for (const d of differences) {
        const mark = d.explicit ? '显式覆盖' : '⚠️ 被静默清掉（profile 没写这个键）'
        line(`  · ${d.key}`)
        line(`      bundle 想要 : ${JSON.stringify(d.bundleValue)}`)
        line(`      实际生效   : ${JSON.stringify(d.effectiveValue)}   ← ${mark}`)
      }
    }
  }
  line()
  if (ok) {
    line('结论：✅ 没有被静默清掉的键。')
  } else {
    line(`结论：⚠️ 有 ${silent.length} 个键被 profile 的 patch **静默清成默认值**（ISSUE-16）。`)
    line('      处置：在该覆盖行里把要保留的每个键都重述一遍（整体替换语义），')
    line('            或者删掉这个覆盖行改用 bundle patch 的那份。')
    line('      注意：删掉覆盖行会丢掉它**有意**设的值（见上面标"显式覆盖"的项）。')
  }
}

process.exit(ok ? 0 : 1)
