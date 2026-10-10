/**
 * ISSUE-16 的回归测试 —— `scripts/verify-profile-config.mjs`。
 *
 * 为什么值得一个永久测试：这条链上的失败**完全静默**。
 * patch 行是"整体替换 config"，所以一份只写了两三个键的覆盖会把它没写的键
 * **清成代码默认值**，而且没有任何地方会报错。本机就因此让 A16 的
 * `promptTimeoutMs: 0`（不限总时长）从未生效过，表现却是"长任务莫名被杀"。
 *
 * 测试只断言**行为**：给定一份部分覆盖，工具必须报出被静默清掉的键并非零退出；
 * 给定一份完整覆盖，必须零退出。不涉及报告文案。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const script = join(repoRoot, 'scripts', 'verify-profile-config.mjs')

/** 跑工具并解析它的 `--json` 输出。 */
function runVerifier(patchText) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-multi-acp-vpc-'))
  try {
    const file = join(dir, 'cordis.patch.yml')
    writeFileSync(file, patchText, 'utf8')
    const r = spawnSync(process.execPath, [script, '--patch', file, '--json'], { encoding: 'utf8' })
    assert.equal(r.status === 0 || r.status === 1, true, `意外退出码 ${r.status}: ${r.stderr}`)
    return { status: r.status, report: JSON.parse(r.stdout) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 从仓库的 bundle patch 里挑出会被"部分覆盖"清掉的键，避免把测试绑死在具体数值上。 */
const bundlePatch = readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8')

test('verify:profile · 部分覆盖 → 必须报出被静默清掉的键，并非零退出', () => {
  // 刻意复刻 install.ps1 早期写出的那份（只含 2 个键）
  const partial = [
    '- id: multi-acp',
    '  name: dsh-multi-acp',
    '  config:',
    '    defaultEngine: ""',
    '    verboseStartup: true',
    '',
  ].join('\n')

  const { status, report } = runVerifier(partial)
  assert.equal(status, 1, '部分覆盖必须被判定为有问题')
  const silent = report.differences.filter((d) => !d.explicit)
  assert.ok(silent.length > 0, '必须报出至少一个被静默清掉的键')
  assert.ok(
    silent.some((d) => d.key === 'promptTimeoutMs'),
    `promptTimeoutMs 必须被报出来（A16 就是栽在这一个上）；实际：${JSON.stringify(silent.map((d) => d.key))}`,
  )
  assert.equal(silent.find((d) => d.key === 'promptTimeoutMs').effectiveValue, 300000)
  // 有意的覆盖不能被算成"被清掉"
  assert.equal(report.differences.find((d) => d.key === 'defaultEngine').explicit, true)
})

test('verify:profile · 完整重述每个键 → 零退出，且不把有意覆盖当成问题', () => {
  const complete = [
    '- id: multi-acp',
    '  name: dsh-multi-acp',
    '  config:',
    '    defaultEngine: ""',
    '    verboseStartup: true',
    '    presetTools: true',
    '    unsandboxedFs: false',
    '    mcp:',
    '      enabled: true',
    '      include: []',
    '      exclude: []',
    '    promptTimeoutMs: 0',
    '    idleTimeoutMs: 180000',
    '    permissionModeFromSession: true',
    '',
  ].join('\n')

  const { status, report } = runVerifier(complete)
  assert.equal(status, 0, `不应报警；实际差异 ${JSON.stringify(report.differences)}`)
  assert.equal(report.differences.filter((d) => !d.explicit).length, 0)
  // defaultEngine 仍然与 bundle 意图不同，但那是**显式**的，应保留在报告里
  assert.equal(report.differences.find((d) => d.key === 'defaultEngine').explicit, true)
})

test('verify:profile · profile 没有覆盖行 → 生效配置等于 bundle，零退出', () => {
  const { status, report } = runVerifier('# 无 multi-acp 行\n- id: other\n  name: x\n')
  assert.equal(status, 0)
  assert.equal(report.targetEntryFound, false)
  // 没有覆盖行时不允许把任何键算成差异（否则工具本身就在误报）
  assert.equal(report.differences.length, 0)
})

test('verify:profile · bundle patch 自身必须包含 multi-acp 行（工具的前提）', () => {
  // 这个断言保护的是"工具的前提"：如果哪天 bundle patch 改了 entry id，
  // 工具会静默地什么都比不出来（usedDefaults 分支）。用文本粗检即可，
  // 真正的组合语义由上面三个用例覆盖。
  const hasEntry = bundlePatch.split('\n').some((line) => line.trim() === '- id: multi-acp')
  assert.ok(hasEntry, 'cordis.patch.yml 里必须有一行 `- id: multi-acp`')
})
