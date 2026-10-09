/**
 * B1 — 随 preset / 会话**注入 MCP servers**（任务 4）。
 *
 * ── 缺口 ────────────────────────────────────────────────────────────────
 * `docs/ACP-INTEGRATION.md` §4.1 早就写清楚了：ACP 的 `session/new` / `session/load`
 * 都带 `mcpServers` 字段，客户端可以在建会话时把 MCP 服务器**交给引擎**去连。
 * v0.1.14 之前 `openSession()` 的签名里有这个参数，但**没有任何调用方传值** ——
 * 于是引擎会话里只有引擎自己的工具，用户在 DSH 里配的 MCP 全部缺席。
 *
 * ── 数据来源 ────────────────────────────────────────────────────────────
 * DSH 自己把 MCP 连接存在 `<DSH_HOME>/storages/mcp_connector.json` 的
 * `tables.connections` 里（实测 2026-10-09，本机 4 条：weknora / chrome-devtools /
 * drawio / dingtalk）。字段形状（实测）：
 *
 *   stdio:           { transport: 'stdio',  command, args[], env{}, cwd, serverName }
 *   streamable-http: { transport: 'streamable-http', url, headers{}, auth:{mode:'bearer',
 *                      bearerToken}, serverName }
 *
 * ACP 侧的形状**不一样**（`@agentclientprotocol/sdk` types.gen.d.ts）：
 *
 *   McpServerStdio      = { name, command, args: string[], env: Array<{name, value}> }
 *   McpServerHttp|Sse   = { type: 'http' | 'sse', name, url, headers: Array<{name, value}> }
 *
 * 所以这里做一层**显式映射**（env/headers 从对象转数组、bearer token 转
 * `Authorization` 头）。
 *
 * ⚠️ 治理（governance / grants）**不随会话下发**：DSH 的 `tools.governance` 表是宿主
 * 自己的审计/审批层，ACP 没有对应字段。也就是说注入给引擎的 MCP 服务器是这个引擎
 * **全量**可用的。默认只注入 `enabled !== false` 且 `injectionMode !== 'off'` 的连接，
 * 需要收紧时用插件配置 `mcp.exclude` 逐个排除。
 *
 * @module dsh-multi-acp/mcp-servers
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 把 `{a: 'b'}` 变成 ACP 要的 `[{name:'a', value:'b'}]`（值统一成字符串）。 */
export function pairsToArray(obj) {
  if (!obj || typeof obj !== 'object') return []
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([name, value]) => ({ name: String(name), value: String(value) }))
}

/** MCP server 名字在引擎侧要能当标识符用：去掉空白/引号，保留中划线点号。 */
function safeServerName(raw, fallback) {
  const s = String(raw ?? '').trim()
  const cleaned = s.replace(/[^\w.\-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || fallback
}

/**
 * DSH 的一条 MCP 连接 → ACP 的 `McpServer`。
 *
 * 不支持的传输（或缺少必要字段）返回 `null`，由调用方记一条 note。
 */
export function toAcpMcpServer(conn, fallbackName = 'mcp') {
  if (!conn || typeof conn !== 'object') return null
  if (conn.enabled === false) return null
  const name = safeServerName(conn.serverName ?? conn.name ?? conn.key, fallbackName)
  const transport = String(conn.transport ?? '').toLowerCase()

  if (transport === 'stdio') {
    if (!conn.command) return null
    return {
      name,
      command: String(conn.command),
      args: Array.isArray(conn.args) ? conn.args.map(String) : [],
      env: pairsToArray(conn.env),
    }
  }

  if (transport === 'streamable-http' || transport === 'http' || transport === 'sse') {
    if (!conn.url) return null
    const headers = pairsToArray(conn.headers)
    const token = conn.auth?.bearerToken
    if (token && !headers.some((h) => h.name.toLowerCase() === 'authorization')) {
      headers.push({ name: 'Authorization', value: `Bearer ${token}` })
    }
    return {
      type: transport === 'sse' ? 'sse' : 'http',
      name,
      url: String(conn.url),
      headers,
    }
  }

  return null
}

/**
 * 读取 DSH 的 MCP 存储。
 *
 * `aliases[i]` 与 `servers[i]` 一一对应，是这条服务器**在用户眼里可能叫什么**
 * （ACP 名字 / 连接的 `name` / `serverName` / 表键）。`include`/`exclude` 用它匹配：
 * 实测本机 `dingtalk` 连接的 `serverName` 是 `dingtalk-workspace`，用户排除时写的
 * 多半是前者。
 *
 * @returns {{ servers: object[], aliases: string[][], connections: object[], problems: string[], file: string }}
 */
export function readDshMcpConnections(dshHomeDir) {
  const file = join(String(dshHomeDir), 'storages', 'mcp_connector.json')
  const out = { servers: [], aliases: [], connections: [], problems: [], file }
  if (!existsSync(file)) {
    out.problems.push(`未找到 MCP 存储：${file}`)
    return out
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    out.problems.push(`MCP 存储解析失败：${String(error?.message ?? error)}`)
    return out
  }
  const table = parsed?.tables?.connections
  const entries = Array.isArray(table) ? table : Object.entries(table ?? {}).map(([key, v]) => ({ key, ...v }))
  let index = 0
  for (const conn of entries) {
    index += 1
    const acp = toAcpMcpServer(conn, `mcp-${index}`)
    if (!acp) {
      if (conn?.enabled !== false) {
        out.problems.push(`跳过不支持的连接：${conn?.name ?? conn?.key ?? `#${index}`}（transport=${conn?.transport ?? '?'}）`)
      }
      continue
    }
    out.connections.push(conn)
    out.servers.push(acp)
    out.aliases.push(
      [
        ...new Set(
          [acp.name, conn.name, conn.serverName, conn.serverKey, conn.connectorId, conn.key].filter(
            (v) => typeof v === 'string' && v.trim(),
          ),
        ),
      ],
    )
  }
  return out
}

/** 归一化用户给的 include/exclude 选择（支持数组 / 逗号串）。 */
function listOf(value) {
  if (!value) return []
  const list = Array.isArray(value) ? value : String(value).split(',')
  return list.map((v) => String(v).trim()).filter(Boolean)
}

/** 判断一条 ACP server 是否命中 include/exclude（用别名列表匹配）。 */
function selected(names, include, exclude) {
  const inList = (list) => list.some((n) => names.includes(n))
  if (exclude.length && inList(exclude)) return false
  if (include.length && !inList(include)) return false
  return true
}

/**
 * 解析一次会话要下发的 MCP servers。
 *
 * 优先级（后面的覆盖前面的能力范围）：
 *   1. 引擎自己的 `engine.mcp`
 *        - `false` / `'none'`  → 不下发任何 DSH MCP
 *        - 数组                 → 只用这些（自定义，形状见 toAcpMcpServer 的输入）
 *        - `{inherit, include, exclude}`
 *   2. 插件配置 `mcp.include` / `mcp.exclude` / `mcp.enabled`
 *
 * @returns {{ servers: object[], notes: string[] }}
 */
export function resolveMcpServers({ dshHomeDir, engineMcp, pluginMcp } = {}) {
  const notes = []
  const plugin = pluginMcp && typeof pluginMcp === 'object' ? pluginMcp : {}
  if (plugin.enabled === false) return { servers: [], notes: ['插件配置 mcp.enabled=false：不下发'] }

  const engine = engineMcp
  if (engine === false || engine === 'none') return { servers: [], notes: ['引擎配置 mcp=none：不下发'] }

  if (Array.isArray(engine)) {
    const servers = engine.map((c, i) => toAcpMcpServer(c, `engine-mcp-${i + 1}`)).filter(Boolean)
    notes.push(`引擎自带 MCP：${servers.length} 个（不继承 DSH 存储）`)
    return { servers, notes }
  }

  const inherited = readDshMcpConnections(dshHomeDir)
  notes.push(...inherited.problems)
  const include = [...listOf(plugin.include), ...listOf(engine?.include)]
  const exclude = [...listOf(plugin.exclude), ...listOf(engine?.exclude)]
  const servers = inherited.servers.filter((s, i) => selected(inherited.aliases[i] ?? [s.name], include, exclude))
  notes.push(`继承 DSH MCP：${servers.length}/${inherited.servers.length} 个${servers.length ? `（${servers.map((s) => s.name).join(', ')}）` : ''}`)
  if (inherited.connections.length && inherited.connections.some((c) => c.injectionMode && c.injectionMode !== 'always')) {
    notes.push('注意：部分连接带 injectionMode≠always，ACP 侧没有按需注入语义，这里仍全量下发')
  }
  return { servers, notes }
}

/** 给 UI/诊断用的一句话摘要。 */
export function summarizeMcpServers(servers) {
  if (!servers?.length) return 'MCP：0 个'
  const byKind = servers.map((s) => `${s.name}(${s.type ?? 'stdio'})`)
  return `MCP：${servers.length} 个 — ${byKind.join(', ')}`
}
