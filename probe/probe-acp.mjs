#!/usr/bin/env node
/**
 * dsh_multi_acp · P0 探针
 * 目的：验证一个外部 CLI 的 ACP 实现覆盖度（对应 docs/VERIFICATION.md Step 3 / 4）
 *
 * 用法:
 *   node probe-acp.mjs <command> [args...]
 *   node probe-acp.mjs "C:\Users\29096\.opencode\bin\opencode.exe" acp
 *   node probe-acp.mjs "C:\nvm4w\nodejs\commandcode.ps1" acp
 *
 * 用官方 SDK 而非手搓 JSON-RPC；用 Proxy 捕获 agent 发起的全部客户端回调。
 * 只做只读探测：一个 trivial prompt，cwd 指向本目录。
 */
import { spawn } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EVIDENCE_DIR = join(__dirname, '..', 'docs', 'evidence')
const T = { init: 300_000, session: 120_000, prompt: 300_000 }

// ── 参数解析：把 --set-config 从目标命令参数里摘出来 ────────────
const argv = process.argv.slice(2)
const setConfigs = [] // ['model=deepseek/deepseek-v4-pro', ...]
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--set-config') setConfigs.push(argv[++i])
  else positional.push(argv[i])
}
const [rawCmd, ...rawArgs] = positional
if (!rawCmd) {
  console.error('usage: node probe-acp.mjs [--set-config id=value ...] <command> [args...]')
  process.exit(2)
}

// ── Windows shim 处理（VERIFICATION.md Step 5 / R4）─────────────
function resolveSpawn(cmd, args) {
  const l = cmd.toLowerCase()
  if (l.endsWith('.ps1')) {
    return { command: 'pwsh', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cmd, ...args], via: 'pwsh -File' }
  }
  if (l.endsWith('.cmd') || l.endsWith('.bat')) {
    return { command: 'cmd', args: ['/c', cmd, ...args], via: 'cmd /c' }
  }
  return { command: cmd, args, via: 'direct' }
}
const sp = resolveSpawn(rawCmd, rawArgs)

const report = {
  probe: 'dsh_multi_acp/probe-acp',
  startedAt: new Date().toISOString(),
  target: { command: rawCmd, args: rawArgs, spawnVia: sp.via, actual: { command: sp.command, args: sp.args }, setConfig: setConfigs },
  platform: process.platform,
  node: process.version,
  sdk: '0.25.1',
  spawn: { ok: false, pid: null, stderr: [], rawLines: 0, parseFailures: 0 },
  initialize: null,
  sessions: [],
  setConfig: [],
  prompt: null,
  clientCallbacks: {},
  errors: [],
}

// ── 启动子进程 ────────────────────────────────────────────────
const child = spawn(sp.command, sp.args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname,
  env: { ...process.env },
})
report.spawn.pid = child.pid

let stderrBuf = ''
child.stderr.on('data', (d) => {
  const s = d.toString()
  stderrBuf += s
  if (report.spawn.stderr.length < 50) report.spawn.stderr.push(s.slice(0, 500))
})
child.on('error', (e) => report.errors.push({ where: 'spawn', message: e.message }))
child.on('exit', (code, sig) => {
  if (code !== 0 && code !== null) report.errors.push({ where: 'exit', code, sig })
})

// ── 原始行计数：方言素材（ENGINE-SPEC.md §5）────────────────────
const origStdout = child.stdout
const tee = new Readable({ read() {} })
origStdout.on('data', (buf) => {
  for (const line of buf.toString().split('\n')) {
    if (!line.trim()) continue
    report.spawn.rawLines++
    try { JSON.parse(line) } catch { report.spawn.parseFailures++ }
  }
  tee.push(buf)
})
origStdout.on('end', () => tee.push(null))

// ── 客户端：Proxy 捕获**所有**回调 ─────────────────────────────
const seen = new Set()
let updatesByType = {}
const clientImpl = {
  async sessionUpdate(params) {
    const t = params?.update?.sessionUpdate ?? 'unknown'
    updatesByType[t] = (updatesByType[t] ?? 0) + 1
    if (!seen.has('sessionUpdate:' + t)) {
      seen.add('sessionUpdate:' + t)
      console.log(`  [update] ${t}  ${JSON.stringify(params.update).slice(0, 200)}`)
    }
  },
  async requestPermission(params) {
    const opts = params?.options ?? []
    const allow = opts.find((o) => /allow|approve|yes|once/i.test(o.kind ?? '') || /allow|approve|yes/i.test(o.name ?? ''))
    console.log(`  [permission] ${params?.toolCall?.title ?? '?'} → ${allow ? 'allow: ' + allow.optionId : 'CANCEL'}`)
    return allow
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : { outcome: { outcome: 'cancelled' } }
  },
  async readTextFile(params) {
    console.log(`  [fs/read] ${params?.path}`)
    return { content: '' }
  },
  async writeTextFile(params) {
    console.log(`  [fs/write] ${params?.path}`)
    return {}
  },
}

const client = new Proxy(clientImpl, {
  get(target, prop) {
    if (prop in target) return target[prop]
    if (typeof prop === 'symbol') return undefined
    return async (...args) => {
      report.clientCallbacks[prop] = (report.clientCallbacks[prop] ?? 0) + 1
      console.log(`  [callback] ${String(prop)} ${JSON.stringify(args).slice(0, 200)}`)
      return {}
    }
  },
})

// ── 建立连接 ──────────────────────────────────────────────────
const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(tee))
const connection = new acp.ClientSideConnection(() => client, stream)

const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT(${ms}ms) on ${label}`)), ms)),
  ])

async function main() {
  console.log(`\n=== PROBE ${rawCmd} (spawn via ${sp.via}) ===\n`)

  // ① initialize
  console.log('[1/5] initialize …')
  const t0 = Date.now()
  try {
    const r = await withTimeout(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      }),
      T.init, 'initialize',
    )
    report.initialize = {
      ok: true,
      latencyMs: Date.now() - t0,
      protocolVersion: r?.protocolVersion ?? null,
      agentInfo: r?.agentInfo ?? null,
      agentCapabilities: r?.agentCapabilities ?? null,
      authMethods: r?.authMethods ?? null,
      raw: r,
    }
    console.log(`  ✅ ok in ${report.initialize.latencyMs}ms  agentInfo=${JSON.stringify(r?.agentInfo ?? null)}`)
    console.log(`  authMethods=${JSON.stringify(r?.authMethods ?? null)}`)
    console.log(`  agentCapabilities=${JSON.stringify(r?.agentCapabilities ?? null)}`)
  } catch (e) {
    report.initialize = { ok: false, latencyMs: Date.now() - t0, error: String(e?.message ?? e) }
    console.log(`  ❌ ${String(e?.message ?? e)}`)
    throw e
  }

  report.spawn.ok = true

  // ② 第一个 session
  console.log('[2/5] session/new (#1) …')
  let s1
  try {
    s1 = await withTimeout(connection.newSession({ cwd: __dirname, mcpServers: [] }), T.session, 'newSession#1')
    report.sessions.push({
      index: 1, ok: true, sessionId: s1?.sessionId ?? null,
      modes: s1?.modes ?? null, models: s1?.models ?? null,
      configOptions: s1?.configOptions ?? null,     // ← 有些实现把配置挂在 newSession 响应里
      raw: s1,
    })
    console.log(`  ✅ sessionId=${s1?.sessionId}  modes=${JSON.stringify(s1?.modes ?? null)}`)
    if (s1?.configOptions) {
      console.log(`  configOptions: ${JSON.stringify(s1.configOptions).slice(0, 600)}`)
    }
  } catch (e) {
    report.sessions.push({ index: 1, ok: false, error: String(e?.message ?? e) })
    console.log(`  ❌ ${String(e?.message ?? e)}`)
    throw e
  }

  // ③ set_config_option（per-session 切模型/模式/思考档）
  if (setConfigs.length) {
    console.log('[3/5] session/set_config_option …')
    for (const spec of setConfigs) {
      const idx = spec.indexOf('=')
      const configId = idx < 0 ? spec : spec.slice(0, idx)
      const value = idx < 0 ? '' : spec.slice(idx + 1)
      try {
        const r = await withTimeout(
          connection.setSessionConfigOption({ sessionId: s1.sessionId, configId, value }),
          T.session, 'setSessionConfigOption',
        )
        report.setConfig.push({ configId, value, ok: true, raw: r })
        console.log(`  ✅ ${configId} = ${value}`)
      } catch (e) {
        report.setConfig.push({ configId, value, ok: false, error: String(e?.message ?? e) })
        console.log(`  ❌ ${configId} = ${value} → ${String(e?.message ?? e)}`)
      }
    }
  }

  // ④ 同进程第二个 session —— R3 多会话复用
  console.log('[4/5] session/new (#2)  ← R3 多会话复用测试 …')
  try {
    const s2 = await withTimeout(connection.newSession({ cwd: __dirname, mcpServers: [] }), T.session, 'newSession#2')
    report.sessions.push({ index: 2, ok: true, sessionId: s2?.sessionId ?? null, raw: s2 })
    console.log(`  ✅ 可复用：sessionId=${s2?.sessionId}`)
  } catch (e) {
    report.sessions.push({ index: 2, ok: false, error: String(e?.message ?? e) })
    console.log(`  ❌ 不可复用：${String(e?.message ?? e)}`)
  }

  // ⑤ 最小 prompt
  console.log('[5/5] session/prompt（trivial）…')
  const p0 = Date.now()
  try {
    const pr = await withTimeout(
      connection.prompt({ sessionId: s1.sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: PONG' }] }),
      T.prompt, 'prompt',
    )
    report.prompt = { ok: true, latencyMs: Date.now() - p0, stopReason: pr?.stopReason ?? null, raw: pr }
    report.prompt.updatesByType = updatesByType
    console.log(`  ✅ stopReason=${pr?.stopReason}  (${report.prompt.latencyMs}ms)`)
    console.log(`  updates: ${JSON.stringify(updatesByType)}`)
  } catch (e) {
    report.prompt = { ok: false, latencyMs: Date.now() - p0, error: String(e?.message ?? e), updatesByType }
    console.log(`  ❌ ${String(e?.message ?? e)}`)
  }

  report.clientCallbacks = { ...report.clientCallbacks }
  report.finishedAt = new Date().toISOString()
}

try {
  await main()
} catch (e) {
  report.fatal = String(e?.message ?? e)
} finally {
  report.stderrTail = stderrBuf.slice(-2000)
  if (!existsSync(EVIDENCE_DIR)) mkdirSync(EVIDENCE_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const safe = rawCmd.replace(/[^a-zA-Z0-9]+/g, '_').slice(-40)
  const out = join(EVIDENCE_DIR, `probe-${safe}-${stamp}.json`)
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\n=== 证据已落盘: ${out} ===`)
  console.log(`spawn.ok=${report.spawn.ok} rawLines=${report.spawn.rawLines} parseFailures=${report.spawn.parseFailures}`)
  try { child.kill() } catch {}
  setTimeout(() => process.exit(report.spawn.ok ? 0 : 1), 300)
}
