/**
 * `createCallbackSink` 的行为测试 —— ISSUE-17 的回归。
 *
 * 背景：这条"客户端回调计数"通道此前**两端都断着** ——
 * 未知回调走的 `rawLines?.recordCallback?.()` 永远没人传（phantom），
 * 而 `seen` 虽然被填充、也被返回，却零读者；`AcpClient._sinkCounts` 更是创建后从未使用。
 * 于是"引擎到底发过哪些回调"这个诊断问题**问不出来**。
 *
 * 现在：未知回调计入 `unknown:<name>`，`counts` 是活 Map，经 `capabilities().callbacks` 暴露。
 *
 * 这里同时钉住两条**安全默认**（它们比计数更重要，坏掉会静默放行）：
 *   · `requestPermission` 无 handler → 必须**拒绝**，不擅自放行；
 *   · `readTextFile` / `writeTextFile` 无 handler → 记警告并如实回空（`initialize` 已声明 fs:false）。
 *
 * 计数**只记名字与次数、不记 args** —— 参数里可能带凭据（见 ISSUE-13）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCallbackSink } from '../lib/acp-client.js'

/** 造一个 sink，并把 warn 调用收集起来。 */
function makeSink(opts = {}) {
  const warns = []
  const logger = { warn: (m) => warns.push(String(m)), debug() {}, info() {}, error() {} }
  const sink = createCallbackSink({ logger, ...opts })
  return { sink, warns }
}

test('sink: sessionUpdate 按事件类型计数，缺类型时记 unknown', async () => {
  const { sink } = makeSink()
  await sink.callbacks.sessionUpdate({ update: { sessionUpdate: 'agent_message_chunk' } })
  await sink.callbacks.sessionUpdate({ update: { sessionUpdate: 'agent_message_chunk' } })
  await sink.callbacks.sessionUpdate({ update: { sessionUpdate: 'tool_call' } })
  await sink.callbacks.sessionUpdate({})

  assert.equal(sink.counts.get('sessionUpdate:agent_message_chunk'), 2)
  assert.equal(sink.counts.get('sessionUpdate:tool_call'), 1)
  assert.equal(sink.counts.get('sessionUpdate:unknown'), 1)
})

test('sink: 未知回调被计数为 unknown:<name>，且返回值是 {}（不抛）', async () => {
  const { sink } = makeSink()
  const out = await sink.callbacks.someNonStandardCallback({ whatever: 1 })
  assert.deepEqual(out, {})
  assert.equal(sink.counts.get('unknown:someNonStandardCallback'), 1)

  await sink.callbacks.someNonStandardCallback({})
  assert.equal(sink.counts.get('unknown:someNonStandardCallback'), 2)
})

test('sink: counts 是**活**的（调用方持引用即可读到后续更新）', async () => {
  const { sink } = makeSink()
  const live = sink.counts
  assert.equal(live.size, 0)
  await sink.callbacks.sessionUpdate({ update: { sessionUpdate: 'x' } })
  assert.equal(live.get('sessionUpdate:x'), 1, 'hold 住的引用必须看到新计数')
})

test('sink: 只记名字与次数 —— args 里的内容绝不出现在 counts 里（ISSUE-13）', async () => {
  const { sink } = makeSink()
  const SECRET = 'mcp_superSecretToken_1234567890'
  await sink.callbacks.unknownThing({ token: SECRET, url: `https://x/?k=${SECRET}` })
  const keys = [...sink.counts.keys()]
  assert.deepEqual(keys, ['unknown:unknownThing'])
  assert.ok(
    !JSON.stringify(keys).includes(SECRET),
    'counts 的键里不得出现参数内容',
  )
})

test('sink: 安全默认 —— 无 onPermission 时必须拒绝，不擅自放行', async () => {
  const { sink } = makeSink()
  const res = await sink.callbacks.requestPermission({ options: [{ kind: 'allow_once' }] })
  assert.deepEqual(res, { outcome: { outcome: 'cancelled' } })
})

test('sink: 安全默认 —— 无 fs handler 时如实回空并记警告（initialize 已声明 fs:false）', async () => {
  const { sink, warns } = makeSink()
  assert.deepEqual(await sink.callbacks.readTextFile({ path: 'x' }), { content: '' })
  assert.deepEqual(await sink.callbacks.writeTextFile({ path: 'x' }), {})
  assert.equal(warns.length, 2)
  assert.match(warns[0], /readTextFile called although fs support was NOT advertised/)
})

test('sink: onPermission / onUpdate 存在时以它们为准（默认实现可被覆盖）', async () => {
  const seen = []
  const { sink } = makeSink({
    onUpdate: (p) => seen.push(p),
    onPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'ok' } }),
  })
  await sink.callbacks.sessionUpdate({ update: { sessionUpdate: 't' } })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].update.sessionUpdate, 't')
  const res = await sink.callbacks.requestPermission({})
  assert.equal(res.outcome.optionId, 'ok')
})
