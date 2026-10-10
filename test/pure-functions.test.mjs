/**
 * 纯函数行为测试 —— `node --test`，零依赖。
 *
 * 选取标准（对应 ADR-0005「测试入库边界」）：
 *   ✅ 纳入：不依赖宿主进程、不依赖真实引擎子进程、不依赖 DSH profile 的**纯行为**。
 *   ❌ 不纳入：需要起 ACP 子进程的（`scripts/probe-*`，靠手动/`workflow_dispatch`）、
 *              需要真实宿主服务的（靠 `tmp/verify-*.mjs` 人工跑）。
 *
 * 每个 case 都对应一处"曾经错过的语义"，不是为覆盖率而写。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PRESET_ID_PREFIX, presetIdFor, engineIdFromPreset } from '../lib/preset-ids.js'
import { evaluateTimeout, DEFAULT_IDLE_TIMEOUT_MS } from '../lib/prompt-timeout.js'
import {
  NATIVE_TOOL_GROUPS,
  nativeToolRows,
  normalizeGroups,
} from '../lib/preset-native.js'
import { readSessionMap, writeSessionMap } from '../lib/session-map.js'
import {
  pairsToArray,
  toAcpMcpServer,
  readDshMcpConnections,
  resolveMcpServers,
  summarizeMcpServers,
} from '../lib/mcp-servers.js'
import {
  expandPathTemplate,
  resolveCommand,
  resolveSkills,
  skillArgsFor,
  permissionArgsFor,
  supportedPermissionModes,
  PERMISSION_MODES,
  SKILL_DELIVERIES,
} from '../lib/engines.js'

/** 每个用例一个独立临时目录；绝不碰真实 DSH_HOME。 */
function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-multi-acp-test-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * preset-ids —— preset 与引擎的双向映射（引擎是数据行 → id 即契约）
 * ══════════════════════════════════════════════════════════════════════ */

test('preset-ids: 引擎 id ↔ preset id 往返', () => {
  assert.equal(PRESET_ID_PREFIX, 'acp-')
  assert.equal(presetIdFor('omp'), 'acp-omp')
  assert.equal(engineIdFromPreset('acp-omp'), 'omp')
  assert.equal(engineIdFromPreset(presetIdFor('commandcode')), 'commandcode')
})

test('preset-ids: 非本插件的 preset 必须返回 undefined（不能误认领别人的会话）', () => {
  assert.equal(engineIdFromPreset('standard'), undefined)
  assert.equal(engineIdFromPreset(''), undefined)
  assert.equal(engineIdFromPreset(undefined), undefined)
  assert.equal(engineIdFromPreset(123), undefined)
})

/* ══════════════════════════════════════════════════════════════════════
 * prompt-timeout —— A16 双闸。曾经的墙钟单闸会误杀正在干活的长任务。
 * ══════════════════════════════════════════════════════════════════════ */

test('prompt-timeout: 空闲闸是主闸（引擎沉默才判卡死）', () => {
  const hit = evaluateTimeout({ startedAt: 0, lastActivityAt: 0, now: 180_000, idleMs: 180_000 })
  assert.equal(hit?.kind, 'idle')
})

test('prompt-timeout: 引擎仍在吐 update 时**不得**触发空闲闸', () => {
  // 实测 session-503ea973：omp 做了 21 次工具调用、仍在思考，却被墙钟 300s 掐断。
  const hit = evaluateTimeout({ startedAt: 0, lastActivityAt: 299_000, now: 300_000, idleMs: 180_000 })
  assert.equal(hit, null)
})

test('prompt-timeout: 总时长闸只在显式设置时生效，idleMs=0 关闭空闲判定', () => {
  assert.equal(evaluateTimeout({ startedAt: 0, lastActivityAt: 299_999, now: 300_000, overallMs: 0, idleMs: 0 }), null)
  const overall = evaluateTimeout({ startedAt: 0, lastActivityAt: 299_000, now: 300_000, overallMs: 300_000, idleMs: 0 })
  assert.equal(overall?.kind, 'overall')
})

test('prompt-timeout: 两闸同时满足时以空闲闸优先，且消息带"最后一次 update"', () => {
  const hit = evaluateTimeout({ startedAt: 0, lastActivityAt: 0, now: 400_000, overallMs: 300_000, idleMs: 180_000 })
  assert.equal(hit?.kind, 'idle')
  assert.match(hit.message, /session\/update/)
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 180_000)
})

test('prompt-timeout: lastActivityAt 缺失/非法时回落到 startedAt', () => {
  const hit = evaluateTimeout({ startedAt: 0, lastActivityAt: undefined, now: 200_000, idleMs: 180_000 })
  assert.equal(hit?.kind, 'idle')
})

/* ══════════════════════════════════════════════════════════════════════
 * preset-native —— acp-* preset 的原生工具组合
 * 缺陷背景：只有 marker 行时，会话的工具目录里一个原生工具都没有（实测 164 个
 * 全是部署层插件工具，模型自己探到 unknown tool "write"）。
 * ══════════════════════════════════════════════════════════════════════ */

test('preset-native: 默认组合必须含 shell / fs / skill 三组（否则会话等于没有手脚）', () => {
  const rows = nativeToolRows({ platform: 'win32' })
  const names = rows.map((r) => r.name ?? r.id)
  for (const required of ['@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-skill', '@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search']) {
    assert.ok(names.includes(required), `缺少 ${required}`)
  }
})

test('preset-native: shell 组按平台二选一（win32 → pwsh，其余 → bash）', () => {
  const win = nativeToolRows({ platform: 'win32' }).map((r) => r.id)
  const posix = nativeToolRows({ platform: 'linux' }).map((r) => r.id)
  assert.ok(win.includes('tool-pwsh') && !win.includes('tool-bash'))
  assert.ok(posix.includes('tool-bash') && !posix.includes('tool-pwsh'))
})

test('preset-native: unsandboxedFs 时 fs 工具必须与 fs-local 同组（否则遮蔽等于没做）', () => {
  const rows = nativeToolRows({ platform: 'linux', unsandboxedFs: true, cwd: 'C:/w' })
  const group = rows.find((r) => r.id === 'filesystem-local')
  assert.ok(group, '未生成 isolate 组')
  assert.deepEqual(group.isolate, { fs: true })
  const inner = group.config.map((r) => r.name)
  // 关键：消费 fs 的 tool-fs / tool-fs-search 必须在组内 —— 第一版把它们留在组外，
  // 结果 tool-fs 仍然注入宿主的 sandboxed fs，遮蔽无效。
  assert.ok(inner.includes('@deepseek-ai/dsh-fs-local'))
  assert.ok(inner.includes('@deepseek-ai/dsh-tool-fs'))
  assert.ok(inner.includes('@deepseek-ai/dsh-tool-fs-search'))
  assert.ok(!rows.some((r) => r.id === 'tool-fs'), 'tool-fs 不应再平铺在外层')
})

test('preset-native: 分组过滤只保留已知组', () => {
  const rows = nativeToolRows({ platform: 'linux', groups: ['skills'] })
  assert.deepEqual(rows.map((r) => r.id), ['skill-filesystem', 'tool-skill'])
})

test('preset-native: normalizeGroups 接受 bool / 数组 / 逗号串，并丢弃未知组', () => {
  assert.deepEqual(normalizeGroups(undefined), [...NATIVE_TOOL_GROUPS])
  assert.deepEqual(normalizeGroups(true), [...NATIVE_TOOL_GROUPS])
  assert.deepEqual(normalizeGroups(false), [])
  assert.deepEqual(normalizeGroups(['fs', 'nope', 'shell']), ['shell', 'fs'])
  assert.deepEqual(normalizeGroups('todo, fs ,bogus'), ['fs', 'todo'])
  assert.deepEqual(
    normalizeGroups(NATIVE_TOOL_GROUPS),
    [...NATIVE_TOOL_GROUPS],
    '全量输入必须原样返回，不能因顺序/去重逻辑丢组',
  )
})

/* ══════════════════════════════════════════════════════════════════════
 * session-map —— dshSessionId ↔ acpSessionId（resume 路由的持久化）
 * 契约：读失败一律降级为空表，**绝不抛**（写失败只影响重启后 resume）
 * ══════════════════════════════════════════════════════════════════════ */

test('session-map: 文件不存在 → 空表', () => {
  withTmp((dir) => {
    assert.deepEqual(readSessionMap(dir), {})
    assert.deepEqual(readSessionMap(''), {})
  })
})

test('session-map: 写入后可读回，并带 updatedAt', () => {
  withTmp((dir) => {
    writeSessionMap(dir, 'session-1', { engineId: 'omp', acpSessionId: 'acp-1', cwd: 'C:/w' })
    const map = readSessionMap(dir)
    assert.equal(map['session-1'].engineId, 'omp')
    assert.equal(map['session-1'].acpSessionId, 'acp-1')
    assert.match(map['session-1'].updatedAt, /^\d{4}-\d{2}-\d{2}T/)
    // 覆盖写不应丢掉别的会话
    writeSessionMap(dir, 'session-2', { engineId: 'opencode' })
    assert.deepEqual(Object.keys(readSessionMap(dir)).sort(), ['session-1', 'session-2'])
  })
})

test('session-map: 文件损坏 → 空表（不抛）', () => {
  withTmp((dir) => {
    writeFileSync(join(dir, 'sessions.json'), '{ 这不是 JSON', 'utf8')
    assert.deepEqual(readSessionMap(dir), {})
  })
})

/* ══════════════════════════════════════════════════════════════════════
 * mcp-servers —— DSH 的 mcp_connector.json → ACP McpServer
 * ══════════════════════════════════════════════════════════════════════ */

test('mcp-servers: pairsToArray 过滤空值并把值转字符串', () => {
  assert.deepEqual(pairsToArray({ A: 'b', C: 1, D: null, E: undefined }), [
    { name: 'A', value: 'b' },
    { name: 'C', value: '1' },
  ])
  assert.deepEqual(pairsToArray(null), [])
})

test('mcp-servers: stdio / http / sse 三种传输的字段形状', () => {
  assert.deepEqual(toAcpMcpServer({ transport: 'stdio', command: 'node', args: ['a'], env: { K: 'v' }, serverName: 's' }), {
    name: 's',
    command: 'node',
    args: ['a'],
    env: [{ name: 'K', value: 'v' }],
  })
  assert.deepEqual(toAcpMcpServer({ transport: 'sse', url: 'https://x', serverName: 'q' }), {
    type: 'sse',
    name: 'q',
    url: 'https://x',
    headers: [],
  })
  // bearer 必须变成 Authorization 头（ACP 没有 auth 字段）
  const http = toAcpMcpServer({
    transport: 'streamable-http',
    url: 'https://y',
    serverName: 'w',
    auth: { mode: 'bearer', bearerToken: 'tok' },
  })
  assert.deepEqual(http.headers, [{ name: 'Authorization', value: 'Bearer tok' }])
})

test('mcp-servers: 已有 Authorization 头时不再叠加 bearer', () => {
  const s = toAcpMcpServer({
    transport: 'http',
    url: 'https://y',
    headers: { authorization: 'X' },
    auth: { bearerToken: 'tok' },
  })
  assert.deepEqual(s.headers, [{ name: 'authorization', value: 'X' }])
})

test('mcp-servers: 不支持的传输 / 缺必要字段 / enabled:false → null（由调用方记 note）', () => {
  assert.equal(toAcpMcpServer({ transport: 'grpc', url: 'https://z' }), null)
  assert.equal(toAcpMcpServer({ transport: 'stdio' }), null)
  assert.equal(toAcpMcpServer({ transport: 'http' }), null)
  assert.equal(toAcpMcpServer({ transport: 'stdio', command: 'x', enabled: false }), null)
  assert.equal(toAcpMcpServer(null), null)
})

test('mcp-servers: server 名字要能当标识符（去空白/引号，保留中划线点号）', () => {
  const s = toAcpMcpServer({ transport: 'stdio', command: 'x', serverName: 'my "weird" server!' })
  assert.match(s.name, /^[\w.\-]+$/)
})

test('mcp-servers: 读 DSH 存储 —— 对象表与数组表都要吃', () => {
  withTmp((dir) => {
    mkdirSync(join(dir, 'storages'), { recursive: true })
    writeFileSync(
      join(dir, 'storages', 'mcp_connector.json'),
      JSON.stringify({
        tables: {
          connections: {
            a: { transport: 'stdio', command: 'node', serverName: 'weknora' },
            b: { transport: 'grpc', url: 'nope' },
          },
        },
      }),
      'utf8',
    )
    const r = readDshMcpConnections(dir)
    assert.equal(r.servers.length, 1)
    assert.equal(r.servers[0].name, 'weknora')
    assert.equal(r.problems.length, 1, '不支持的连接要留一条 problem，而不是静默丢弃')
    assert.match(r.problems[0], /grpc/)
  })
})

test('mcp-servers: 存储缺失/损坏 → problems 且有话说', () => {
  withTmp((dir) => {
    assert.match(readDshMcpConnections(dir).problems[0], /未找到/)
    mkdirSync(join(dir, 'storages'), { recursive: true })
    writeFileSync(join(dir, 'storages', 'mcp_connector.json'), 'not json', 'utf8')
    assert.match(readDshMcpConnections(dir).problems[0], /解析失败/)
  })
})

test('mcp-servers: include/exclude 按**别名**匹配（用户写的名字与 serverName 常常不同）', () => {
  withTmp((dir) => {
    mkdirSync(join(dir, 'storages'), { recursive: true })
    writeFileSync(
      join(dir, 'storages', 'mcp_connector.json'),
      JSON.stringify({
        tables: {
          connections: {
            k1: { transport: 'stdio', command: 'n', serverName: 'dingtalk-workspace', name: 'dingtalk' },
            k2: { transport: 'stdio', command: 'n', serverName: 'weknora' },
          },
        },
      }),
      'utf8',
    )
    // 用户排除时写的是 'dingtalk'（连接的 name），而 serverName 是 'dingtalk-workspace'
    const only = resolveMcpServers({ dshHomeDir: dir, pluginMcp: { enabled: true, include: [], exclude: ['dingtalk'] } })
    assert.deepEqual(only.servers.map((s) => s.name), ['weknora'])
    const picked = resolveMcpServers({ dshHomeDir: dir, pluginMcp: { enabled: true, include: ['weknora'], exclude: [] } })
    assert.deepEqual(picked.servers.map((s) => s.name), ['weknora'])
  })
})

test('mcp-servers: 插件级 enabled:false 与引擎级 none 都要短路', () => {
  const off = resolveMcpServers({ pluginMcp: { enabled: false } })
  assert.equal(off.servers.length, 0)
  assert.match(off.notes[0], /enabled=false/)
  const none = resolveMcpServers({ engineMcp: 'none' })
  assert.equal(none.servers.length, 0)
  assert.match(none.notes[0], /none/)
})

test('mcp-servers: 引擎自带数组 = 只用它，不继承 DSH 存储', () => {
  const r = resolveMcpServers({ dshHomeDir: 'C:/definitely/missing', engineMcp: [{ transport: 'stdio', command: 'x', serverName: 'own' }] })
  assert.deepEqual(r.servers.map((s) => s.name), ['own'])
  assert.match(r.notes.join('\n'), /引擎自带 MCP/)
})

test('mcp-servers: summarize 对空/非空都给一行', () => {
  assert.equal(summarizeMcpServers([]), 'MCP：0 个')
  assert.equal(summarizeMcpServers(null), 'MCP：0 个')
  assert.match(summarizeMcpServers([{ name: 'a', type: 'http' }]), /MCP：1 个 — a\(http\)/)
})

/* ══════════════════════════════════════════════════════════════════════
 * engines —— 数据行解析（含 skill 投递与权限档这两处"无人值守"关键逻辑）
 * ══════════════════════════════════════════════════════════════════════ */

const ENV = { USERPROFILE: 'C:\\Users\\u', HOME: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }

test('engines: expandPathTemplate 展开 ~ / %VAR% / ${VAR}，缺失变量 → 空串', () => {
  assert.equal(expandPathTemplate('~/.agents/skills', ENV), join('C:\\Users\\u', '.agents/skills'))
  assert.equal(expandPathTemplate('%APPDATA%\\npm', ENV), 'C:\\Users\\u\\AppData\\Roaming\\npm')
  assert.equal(expandPathTemplate('${USERPROFILE}/x', ENV), 'C:\\Users\\u/x')
  assert.equal(expandPathTemplate('%NOPE%/x', ENV), '/x')
})

test('engines: resolveCommand 优先级 = resolvedCommand > 平台 override > command', () => {
  assert.equal(resolveCommand({ resolvedCommand: 'X', commandOverrides: { windows: 'Y' }, command: 'Z' }, 'win32'), 'X')
  assert.equal(resolveCommand({ commandOverrides: { windows: 'Y' }, command: 'Z' }, 'win32'), 'Y')
  assert.equal(resolveCommand({ commandOverrides: { windows: 'Y' }, command: 'Z' }, 'linux'), 'Z')
})

test('engines: resolveSkills 默认 auto + ~/.agents/skills', () => {
  const r = resolveSkills({}, ENV)
  assert.equal(r.delivery, 'auto')
  assert.deepEqual(r.dirs, [join('C:\\Users\\u', '.agents/skills')])
  assert.deepEqual(r.template, ['--skill', '{dir}'])
})

test('engines: skillArgsFor 只在 delivery=args 时追加参数（auto/none 必须是空数组）', () => {
  assert.deepEqual(skillArgsFor({ skillDelivery: 'auto' }, ENV), [])
  assert.deepEqual(skillArgsFor({ skillDelivery: 'none' }, ENV), [])
  const args = skillArgsFor({ skillDelivery: 'args', skillsDirs: ['D:/s'] }, ENV)
  assert.deepEqual(args, ['--skill', 'D:/s'])
  // 自定义模板
  assert.deepEqual(skillArgsFor({ skillDelivery: 'args', skillsDirs: ['D:/s'], skillArgsTemplate: ['--skills-dir={dir}'] }, ENV), ['--skills-dir=D:/s'])
})

test('engines: 非法 skillDelivery 回落 auto（保守：不要让拼错的值变成"不下发"）', () => {
  assert.equal(resolveSkills({ skillDelivery: 'ARGSS' }, ENV).delivery, 'auto')
  assert.deepEqual(SKILL_DELIVERIES, ['auto', 'args', 'none'])
})

test('engines: permissionArgsFor —— 无人值守靠它避免"审批没人批导致全通道被拒"', () => {
  const engine = { permissionMode: 'dont_ask', permissionTemplates: { dont_ask: ['--auto-approve'] } }
  assert.deepEqual(permissionArgsFor(engine), ['--auto-approve'])
  assert.deepEqual(permissionArgsFor({ ...engine, permissionMode: 'default' }), [])
  // 声明了模式但没模板 → 不能凭空造参数
  assert.deepEqual(permissionArgsFor({ permissionMode: 'bypass' }), [])
  // 非法模式 → 当作 default，**不**静默升级权限
  assert.deepEqual(permissionArgsFor({ permissionMode: 'BYPASS', permissionTemplates: { bypass: ['--x'] } }), [])
})

test('engines: supportedPermissionModes —— default 恒可，其余看模板是否存在', () => {
  assert.deepEqual(supportedPermissionModes({}), ['default'])
  assert.deepEqual(supportedPermissionModes({ permissionTemplates: { dont_ask: ['--a'] } }), ['default', 'dont_ask'])
  assert.deepEqual(supportedPermissionModes({ permissionTemplates: { dont_ask: [] } }), ['default'], '空模板不算支持')
  assert.deepEqual(PERMISSION_MODES, ['default', 'dont_ask', 'bypass'])
})
