/**
 * 宿主半边冒烟测试 —— 用**假 ctx** 跑一遍 `apply()`。
 *
 * 为什么必须有它：`apply()` 的四个 `ctx.effect` 是本插件与宿主的全部接触面
 * （注册 preset / 替换 factory / 回收进程 / 注册路由）。重构、改配置面、
 * 换注入顺序时，最容易坏的就是这里 —— 而它平时只能靠"重启 DSH 看插件页版本号"
 * 来验证，成本极高。本测试把这件事压到毫秒级。
 *
 * 它**不**替代真实宿主验证（真会话仍必须跑），但能挡住"装配层被改坏"。
 *
 * 证据等级：本测试证明的是**本插件的装配意图**，不是宿主的真实语义。
 * 宿主语义以 `docs/VERIFICATION.md` 的真机结论为准。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject } from '../lib/index.impl.js'
import { MultiAcpFactory } from '../lib/acp-factory.js'
import { assertAgentContract } from '../lib/agent-contract.js'

/**
 * ⚠️ **必须**先把 trace 关掉（或重定向到临时文件）。
 *
 * 假 ctx 调 `apply()` 会产生**假的** `install.factory-*` / `host.probe` 事件。
 * 若它们落进用户真正的 `<stateDir>/trace.log`，就会把"测试"读成"宿主行为"——
 * 2026-10-10 真实发生过：测试故意构造的 `{ target: 'not-a-factory' }` 让 13 个
 * pid 上出现 `install.factory-bad-shape`，被误判为"宿主返回了无法识别的形状"，
 * 差点据此放宽一项本来不该动的保守策略（见 docs/ISSUES.md ISSUE-18）。
 *
 * `lib/trace.js` 也内置了 `NODE_TEST_CONTEXT` 兜底；这里显式写出来是为了**说明意图**。
 */
process.env.DSH_MULTI_ACP_TRACE = ''

/** 一个够用的假 Cordis ctx：只实现本插件用到的那几样。 */
function makeFakeCtx() {
  /** @type {any[]} */
  const disposers = []
  const calls = { presetRegister: [], webRegister: [], logs: [], effects: 0 }

  const originalFactory = {
    target: { createAgent() {}, resume() {} },
  }

  const services = {
    agents: { factory: originalFactory },
    agentPresets: {
      async register(definition) {
        calls.presetRegister.push(definition)
        return async () => {
          calls.presetUnregistered = (calls.presetUnregistered ?? 0) + 1
        }
      },
    },
    sessions: {},
    commands: {},
    tools: {},
    systemPrompt: {},
    llm: {},
    webServer: {
      register(spec) {
        calls.webRegister.push(spec)
        return () => {}
      },
    },
  }

  const logger = {
    info: (m) => calls.logs.push(['info', String(m)]),
    warn: (m) => calls.logs.push(['warn', String(m)]),
    error: (m) => calls.logs.push(['error', String(m)]),
  }

  const ctx = {
    logger,
    ...services,
    effect(fn) {
      calls.effects += 1
      const out = fn()
      if (typeof out === 'function') disposers.push(out)
      return () => {}
    },
    inject(deps, cb) {
      // Cordis 在依赖可用时用子上下文回调；这里依赖都在，直接回调。
      cb(ctx)
      return () => {}
    },
    get(name) {
      return services[name]
    },
  }

  return {
    ctx,
    calls,
    originalFactory,
    async disposeAll() {
      for (const d of disposers.splice(0)) await d()
    },
  }
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-multi-acp-smoke-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** `apply()` 内的 preset 注册是 `void (async …)`，等一拍再断言。 */
const settle = () => new Promise((r) => setTimeout(r, 60))

test('smoke: inject 列表必须覆盖官方 agent-loop 的 inject（否则 agent.ctx 会缺服务）', () => {
  // 背景：宿主崩溃实录 —— dsh-experimental-tool-agent-team 访问 agent.ctx.systemPrompt
  // 时报 `cannot get property "systemPrompt" without inject`，把宿主进程打死。
  // 根因就是 createScope 造的 scoped ctx 继承了**本插件**的 inject 列表。
  const loopInject = ['agents', 'sessions', 'llm', 'tools', 'systemPrompt']
  for (const name of loopInject) {
    assert.ok(inject.includes(name), `inject 缺少官方 loop 也声明的 "${name}"`)
  }
  assert.ok(inject.includes('agentPresets'), '本插件自己还要注册 preset')
})

test('smoke: apply() 替换 factory，并保留官方 factory 作为回落', () => {
  withTmp(async (stateDir) => {
    const { ctx, calls, originalFactory } = makeFakeCtx()
    apply(ctx, { stateDir, verboseStartup: false })

    assert.equal(calls.effects, 4, '应当恰好注册 4 个 effect（preset/factory/pool/routes）')
    assert.ok(ctx.agents.factory.target instanceof MultiAcpFactory, 'factory 未被替换')
    assert.notEqual(ctx.agents.factory.target, originalFactory.target)

    // 官方 factory 必须被保存 —— 未声明引擎的会话要能回落到原生 loop
    const factory = ctx.agents.factory.target
    assert.equal(factory.originalTarget, originalFactory.target)
    assert.equal(typeof factory.createAgent, 'function')
    assert.equal(typeof factory.resume, 'function')
  })
})

test('smoke: 每个启用的引擎注册一个 acp-<id> preset，且组合里带 marker + 原生工具行', () => {
  withTmp(async (stateDir) => {
    const { ctx, calls } = makeFakeCtx()
    apply(ctx, { stateDir, verboseStartup: false })
    await settle()

    assert.ok(calls.presetRegister.length >= 3, `至少应为 3 个内置引擎注册 preset，实际 ${calls.presetRegister.length}`)
    for (const def of calls.presetRegister) {
      assert.match(def.id, /^acp-/, 'preset id 必须以 acp- 开头（引擎路由靠它识别）')
      const names = def.plugins.map((r) => r.name ?? r.id)
      assert.ok(names.includes('dsh-multi-acp/preset-marker'), `${def.id} 缺 marker`)
      // 只有 marker 的 preset 会让会话失去全部原生工具（实测 164 个工具里零原生工具）
      assert.ok(names.includes('@deepseek-ai/dsh-tool-fs'), `${def.id} 缺原生工具行`)
    }
    const ids = calls.presetRegister.map((d) => d.id)
    assert.equal(new Set(ids).size, ids.length, 'preset id 不能重复（重复注册会被宿主审计拒绝）')
  })
})

test('smoke: 引擎管理路由挂在 ctx.webServer 的 /multi-acp 前缀上', () => {
  withTmp(async (stateDir) => {
    const { ctx, calls } = makeFakeCtx()
    apply(ctx, { stateDir, verboseStartup: false })
    assert.equal(calls.webRegister.length, 1)
    assert.equal(calls.webRegister[0].kind, 'prefix')
    assert.equal(calls.webRegister[0].path, '/multi-acp')
    assert.equal(typeof calls.webRegister[0].handler, 'function')
  })
})

test('smoke: 卸载时 factory 复原、preset 注销（不留残骸）', () => {
  withTmp(async (stateDir) => {
    const { ctx, calls, originalFactory, disposeAll } = makeFakeCtx()
    apply(ctx, { stateDir, verboseStartup: false })
    await settle()
    assert.notEqual(ctx.agents.factory, originalFactory)

    await disposeAll()
    assert.equal(ctx.agents.factory, originalFactory, 'factory 未复原')
    assert.ok(calls.presetUnregistered >= 3, 'preset disposer 未全部调用')
  })
})

test('smoke: 配置面被归一化 —— 未知 presetTools 分组必须报 diagnos，不能静默丢掉', () => {
  withTmp(async (stateDir) => {
    const { ctx, calls } = makeFakeCtx()
    apply(ctx, { stateDir, verboseStartup: false, presetTools: ['fs', 'shell', 'mcp'] })
    const warned = calls.logs.filter(([level, m]) => level === 'warn' && m.includes('未知分组'))
    assert.equal(warned.length, 1, `应有一条"未知分组"告警，实际日志：${JSON.stringify(calls.logs)}`)
    assert.match(warned[0][1], /mcp/)
  })
})

test('smoke: promptTimeoutMs < idleTimeoutMs 时告警（否则空闲闸形同虚设）', () => {
  withTmp(async (stateDir) => {
    const { ctx, calls } = makeFakeCtx()
    apply(ctx, { stateDir, verboseStartup: false, promptTimeoutMs: 1000, idleTimeoutMs: 180_000 })
    const warned = calls.logs.filter(([, m]) => m.includes('总时长闸会先触发'))
    assert.equal(warned.length, 1)
  })
})

test('smoke: factory 槽位形状不对时不替换，且报错而不是炸掉', () => {
  withTmp(async (stateDir) => {
    const { ctx, calls } = makeFakeCtx()
    // 官方 AgentFactory 是带方法的对象，**不是函数** —— 早期误判成函数会导致
    // "防御性错误信息自身崩溃"（对 Cordis traced service 做 JSON.stringify 会抛）。
    ctx.agents.factory = { target: 'not-a-factory' }
    apply(ctx, { stateDir, verboseStartup: false })
    assert.equal(ctx.agents.factory.target, 'not-a-factory', '形状不对时不应替换')
    assert.ok(calls.logs.some(([level, m]) => level === 'error' && m.includes('unexpected ctx.agents.factory shape')))
  })
})

test('smoke: factory 槽位为空（官方 loop 尚未注册）时明确报错，不静默', () => {
  withTmp(async (stateDir) => {
    const { ctx, calls } = makeFakeCtx()
    ctx.agents.factory = undefined
    apply(ctx, { stateDir, verboseStartup: false })
    assert.equal(ctx.agents.factory, undefined)
    assert.ok(calls.logs.some(([level, m]) => level === 'error' && m.includes('factory is empty')))
  })
})

test('contract: assertAgentContract 的每条结论必须带解析来源与版本（Q5d）', async () => {
  const contract = await assertAgentContract({ refresh: true })
  assert.equal(typeof contract.ok, 'boolean')
  assert.equal(typeof contract.scope, 'string')
  assert.ok(contract.report.length >= 4)
  for (const entry of contract.report) {
    assert.ok('version' in entry, `${entry.pkg} 缺 version —— 无法判断结论对谁成立`)
    assert.ok('expected' in entry, `${entry.pkg} 缺 expected`)
    assert.ok('trustHost' in entry, `${entry.pkg} 缺 trustHost`)
  }
  // 在宿主外（CI / 裸 node）解析到的不是宿主那一份 → 必须自曝其短
  if (!contract.report.every((r) => r.trustHost)) {
    assert.match(contract.scope, /版本不匹配|不代表宿主/)
  }
})
