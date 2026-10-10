/**
 * `lib/trace.js` 的中央脱敏测试 —— ISSUE-13 的回归。
 *
 * 事故：`acp.tool-call` 记录引擎工具调用的**原标题**，实测含
 * `mcp_…` token、`sk-…` API key、账号邮箱与**明文密码**。而 trace.log 是
 * "出问题就贴进 issue"的那种旁路文件 —— 它记的东西比会话日志更容易外泄。
 *
 * 这一层的价值在于：它是**唯一**的落盘收口点，未来的新调用方即使误传敏感字段，
 * 也不会再把凭据写进磁盘（纵深防御）。但如果调用方**主动**传了，那仍然是缺陷 ——
 * 所以 `acp.tool-call` 那边同时改成了只记 `titleLen`（见 acp-turn-runner 的注释）。
 *
 * ⚠️ 本文件里的"凭据"**全是合成替身**（形状相同、值不是真的）——
 * 仓库里绝不出现真实 token/密码（AGENTS.md §8）。
 */

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { trace, configureTrace } from '../lib/trace.js'

/** 造一个临时 trace 文件路径；用完删目录。 */
const tmpDirs = []
function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-trace-'))
  tmpDirs.push(dir)
  return join(dir, 'trace.log')
}

/** 写一条事件并读回落盘的那一行（JSON.parse）。 */
function writeAndRead(file, event, data) {
  configureTrace({ enabled: true, file })
  trace(event, data)
  assert.ok(existsSync(file), '应当写入了 trace 文件')
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  return JSON.parse(lines[lines.length - 1])
}

afterEach(() => {
  configureTrace(null)
  while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true })
})

// 合成替身：形状对齐真实泄漏物，值都是假的。
const FAKE_MCP = 'mcp_SYNTHETlCkj3XkQ9vRb2LpZ7wTn4YhGd8Fm_q1'
const FAKE_SK = 'sk-SYNTHETlCfK3nQ9vRb2LpZ7wTn4YhGd8FmAbCdEf'
const FAKE_EMAIL = 'someone@example.com'
const FAKE_PWD = 'P4ssw0rd-lookalike-9f2a'
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWJTeW50aGV0aWMiOjF9.c2lnbmF0dXJlU3ludGhldGlj'

test('trace: 关闭开关下**一个字都不写**', () => {
  const file = tmpFile()
  configureTrace({ enabled: false })
  trace('should-not-appear', { engineId: 'e1', title: FAKE_MCP })
  assert.equal(existsSync(file), false, '关闭时不得创建文件')
})

test('trace: 键名命中（token/secret/password/apiKey/authorization/cookie）→ 整值脱敏', () => {
  const file = tmpFile()
  const line = writeAndRead(file, 'test.keys', {
    token: FAKE_MCP,
    accessToken: FAKE_SK,
    password: FAKE_PWD,
    passwd: FAKE_PWD,
    apiKey: FAKE_SK,
    api_key: FAKE_SK,
    secret: FAKE_SK,
    authorization: `Bearer ${FAKE_SK}`,
    credential: FAKE_SK,
    cookie: 'sid=abc',
  })
  for (const [k, v] of Object.entries(line.data)) {
    assert.equal(v, '<redacted>', `${k} 的值必须被脱敏`)
  }
  const raw = JSON.stringify(line)
  for (const secret of [FAKE_MCP, FAKE_SK, FAKE_PWD]) assert.ok(!raw.includes(secret), `${secret} 不得落盘`)
})

test('trace: 值里**嵌在自由文本**中的凭据也会被盖住（错误信息/URL 里的那种）', () => {
  const file = tmpFile()
  const line = writeAndRead(file, 'test.shapes', {
    message: `fetch failed: GET https://host/api?token=${FAKE_MCP}&x=1 (key=${FAKE_SK})`,
    note: `cmd: --password ${FAKE_PWD} --verbose`,
    jwt: FAKE_JWT,
    header: `Bearer ${FAKE_SK}`,
    owner: `联系 ${FAKE_EMAIL} 处理`,
  })
  const raw = JSON.stringify(line)
  for (const secret of [FAKE_MCP, FAKE_SK, FAKE_PWD, FAKE_JWT, FAKE_EMAIL]) {
    assert.ok(!raw.includes(secret), `${secret} 不得落盘（自由文本路径）`)
  }
  assert.match(line.data.message, /<redacted>/)
  assert.match(line.data.owner, /<(redacted|email)>/)
})

test('trace: 非敏感字段**必须原样保留** —— 脱敏不能毁掉诊断能力', () => {
  const file = tmpFile()
  const line = writeAndRead(file, 'acp.init', {
    sessionId: 'session-eca8ba23-9c1f',
    engineId: 'claude-code',
    name: 'Bash',
    kind: 'execute',
    callId: 'toolu_01ABC',
    count: 4,
    ok: true,
    names: ['weknora-dc328ba5'],
    titleLen: 42,
  })
  assert.deepEqual(line.data, {
    sessionId: 'session-eca8ba23-9c1f',
    engineId: 'claude-code',
    name: 'Bash',
    kind: 'execute',
    callId: 'toolu_01ABC',
    count: 4,
    ok: true,
    names: ['weknora-dc328ba5'],
    titleLen: 42,
  })
  assert.equal(line.event, 'acp.init')
  assert.equal(typeof line.t, 'string')
})

test('trace: **真实泄漏形状** —— 工具调用标题里同时含 token/key/邮箱/密码', () => {
  const file = tmpFile()
  // 这一条对应实测的那次泄漏（标题 = "设置 MCP: <url>，token=mcp_…，key=sk-…，账号 x@y 密码 …"）
  const leakedTitle = `设置 MCP:  https://weknora.example.com
token  ${FAKE_MCP}
key  ${FAKE_SK}
账号 ${FAKE_EMAIL}
密码 ${FAKE_PWD}`

  const line = writeAndRead(file, 'acp.tool-call', {
    engineId: 'omp',
    callId: 'toolu_01XYZ',
    name: 'setup_mcp',
    kind: 'other',
    titleLen: leakedTitle.length,
  })
  assert.equal(line.data.titleLen, leakedTitle.length)
  const raw = JSON.stringify(line)
  for (const secret of [FAKE_MCP, FAKE_SK, FAKE_PWD, FAKE_EMAIL]) {
    assert.ok(!raw.includes(secret), `${secret} 不得落盘`)
  }
  assert.equal(line.data.title, undefined, 'ISSUE-13：trace 不得再记 title（只记 titleLen）')

  // 纵深防御：**即使**某个调用方想当然地传了 title，也过不去脱敏那一层。
  const defence = writeAndRead(file, 'acp.tool-call', { title: leakedTitle })
  for (const secret of [FAKE_MCP, FAKE_SK, FAKE_PWD, FAKE_EMAIL]) {
    assert.ok(!JSON.stringify(defence).includes(secret), `纵深防御失效：${secret} 落盘了`)
  }
})

test('trace: 超长字符串被截断并标注原长（避免整篇 prompt 落盘）', () => {
  const file = tmpFile()
  const long = 'x'.repeat(1200)
  const line = writeAndRead(file, 'test.long', { blob: long })
  assert.equal(line.data.blob.length, 300 + '…(+900 chars)'.length)
  assert.match(line.data.blob, /…\(\+900 chars\)$/)
})

test('trace: 深层/超宽对象不抛，且有明确上限标记', () => {
  const file = tmpFile()
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } }
  const wide = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]))
  const line = writeAndRead(file, 'test.shape', { deep, wide })
  // 深过 MAX_DEPTH 的地方被折叠成标记，而不是抛栈溢出
  assert.match(JSON.stringify(line.data.deep), /<max-depth>/)
  assert.equal(Object.keys(line.data.wide).length, 41, '40 个字段 + 1 个截断标记')
  assert.match(String(line.data.wide['…']), /\+20 more fields/)
})
