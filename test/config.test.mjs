/**
 * 配置面测试 —— `lib/config.js`。
 *
 * 这个模块的两条硬要求（见 ADR-0004）：
 *   1. **求值期绝不抛** —— 它挂在插件入口的静态 import 链上，
 *      抛一次就是"插件启动失败"（本插件最贵的事故形态）。
 *   2. **响亮降级** —— 拿不到/建不了 schema 时 `Config === undefined` 并留诊断，
 *      不静默、也不假装有校验。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config, DEFAULT_CONFIG, normalizeConfig, validateCrossField, schemaDiagnostics } from '../lib/config.js'

/** 把 diagnostics 压成便于断言的形式。 */
const msgs = (list) => list.map((d) => `${d.level}: ${d.message}`).join('\n')

test('config: 模块求值期不得抛（它挂在插件入口的静态 import 链上）', () => {
  assert.ok(Array.isArray(schemaDiagnostics))
  for (const d of schemaDiagnostics) {
    assert.ok(['info', 'warn', 'error'].includes(d.level))
    assert.equal(d.source, 'config')
    assert.ok(d.message.length > 0, '诊断必须有话说')
  }
})

test('config: DEFAULT_CONFIG 的值必须与文档/README 一致（改这里等于改用户可见行为）', () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    defaultEngine: '',
    stateDir: '',
    engines: [],
    verboseStartup: true,
    presetTools: true,
    unsandboxedFs: false,
    mcp: { enabled: true, include: [], exclude: [] },
    promptTimeoutMs: 300000,
    idleTimeoutMs: 180000,
    permissionModeFromSession: true,
  })
})

test('config: 空输入 → 全默认，且不产生诊断', () => {
  const { config, diagnostics } = normalizeConfig(undefined)
  assert.deepEqual(diagnostics, [])
  assert.equal(config.defaultEngine, '')
  assert.equal(config.verboseStartup, true)
  assert.deepEqual(config.presetTools, ['skills', 'shell', 'fs', 'jobs', 'todo', 'ask-user', 'web'])
  assert.deepEqual(config.mcp, { enabled: true, include: [], exclude: [] })
})

test('config: 非对象输入 → 默认值 + 一条明确诊断（不抛）', () => {
  const { config, diagnostics } = normalizeConfig('nonsense')
  assert.equal(config.idleTimeoutMs, 180_000)
  assert.match(msgs(diagnostics), /配置期望对象/)
})

test('config: 字符串数字被接受（历史行为，用户 YAML 常见写法）', () => {
  const { config } = normalizeConfig({ promptTimeoutMs: '0', idleTimeoutMs: ' 60000 ' })
  assert.equal(config.promptTimeoutMs, 0)
  assert.equal(config.idleTimeoutMs, 60_000)
  // 非数字字符串 → 回落默认，而不是变成 NaN
  assert.equal(normalizeConfig({ promptTimeoutMs: 'abc' }).config.promptTimeoutMs, 300_000)
})

test('config: unsandboxedFs 接受字符串 "true"（历史行为）', () => {
  assert.equal(normalizeConfig({ unsandboxedFs: 'true' }).config.unsandboxedFs, true)
  assert.equal(normalizeConfig({ unsandboxedFs: 'false' }).config.unsandboxedFs, false)
  assert.equal(normalizeConfig({ unsandboxedFs: true }).config.unsandboxedFs, true)
})

test('config: mcp 的三种写法（false / true / 对象）', () => {
  assert.deepEqual(normalizeConfig({ mcp: false }).config.mcp, { enabled: false, include: [], exclude: [] })
  assert.deepEqual(normalizeConfig({ mcp: true }).config.mcp, { enabled: true, include: [], exclude: [] })
  assert.deepEqual(normalizeConfig({ mcp: { enabled: false, include: ['a'], exclude: ['b'] } }).config.mcp, {
    enabled: false,
    include: ['a'],
    exclude: ['b'],
  })
  // 对象里的非数组字段 → 空数组，不当成字符串
  assert.deepEqual(normalizeConfig({ mcp: { include: 'a' } }).config.mcp.include, [])
})

test('config: 未知 presetTools 分组必须**响亮**（旧行为是静默丢弃）', () => {
  const { config, diagnostics } = normalizeConfig({ presetTools: ['fs', 'shell', 'mcp'] })
  assert.deepEqual(config.presetTools, ['shell', 'fs'])
  const text = msgs(diagnostics)
  assert.match(text, /未知分组 \[mcp\]/)
  assert.match(text, /skills \/ shell \/ fs/, '诊断里要列出可用分组，否则用户无法自救')
})

test('config: promptTimeoutMs < idleTimeoutMs → 告警（空闲闸会形同虚设）', () => {
  const d = validateCrossField({ ...DEFAULT_CONFIG, promptTimeoutMs: 60_000, idleTimeoutMs: 180_000 })
  assert.equal(d.length, 1)
  assert.equal(d[0].level, 'warn')
  assert.match(d[0].message, /总时长闸会先触发/)
})

test('config: promptTimeoutMs=0（不限）是最推荐的长任务配置 → 不告警', () => {
  const d = validateCrossField({ ...DEFAULT_CONFIG, promptTimeoutMs: 0, idleTimeoutMs: 180_000 })
  assert.deepEqual(d, [])
})

test('config: idleTimeoutMs=0 关闭空闲判定 → 告警（卡死的引擎会一直占着会话）', () => {
  const d = validateCrossField({ ...DEFAULT_CONFIG, idleTimeoutMs: 0 })
  assert.ok(d.some((x) => /关闭了空闲判定/.test(x.message)))
})

test('config: mcp include/exclude 同一名字 → 告警并说明 exclude 优先', () => {
  const d = validateCrossField({ ...DEFAULT_CONFIG, mcp: { enabled: true, include: ['x'], exclude: ['x'] } })
  assert.ok(d.some((x) => /exclude 优先/.test(x.message)))
})

test('config: 自带 cordis.patch.yml 的完整 config 必须能被 schema 求值（否则插件加载失败）', () => {
  // 这是本仓库真正会跑的配置形态。schema 一旦不再容忍它，插件就在用户机器上起不来。
  const shipped = {
    defaultEngine: 'omp',
    idleDisposeMs: 30000, // 注：插件级其实是死配置（见 ISSUES），但 schema 不能因此拒绝它
    disposeGraceMs: 6000,
    stateDir: 'D:/x/multi-acp',
    engines: [],
    presetTools: true,
    unsandboxedFs: false,
    mcp: { enabled: true, include: [], exclude: [] },
    promptTimeoutMs: 0,
    idleTimeoutMs: 180000,
    permissionModeFromSession: true,
  }
  if (Config) {
    const validated = Config(shipped)
    assert.equal(validated.promptTimeoutMs, 0, 'promptTimeoutMs: 0 必须原样保留')
    assert.equal(validated.defaultEngine, 'omp')
    // normalizer 必须对 schema 的输出仍然可用（两条路径收敛到同一结果）
    const { config } = normalizeConfig(validated)
    assert.equal(config.promptTimeoutMs, 0)
    assert.equal(config.defaultEngine, 'omp')
  }
  // schema 不可用时也必须不抛
  assert.ok(Config === undefined || typeof Config === 'function')
})

test('config: schema 若存在，必须拒绝真正写错类型（而不是照单全收）', () => {
  if (!Config) return // 宿主 schemastery 缺席时跳过（CI 无 profile 情况下合法）
  assert.throws(() => Config({ promptTimeoutMs: {} }))
  assert.throws(() => Config({ engines: 'not-an-array' }))
})
