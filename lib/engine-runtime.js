/**
 * 引擎**运行时观测**（进程内，非持久化）。
 *
 * 用途有两个，都来自 ACP-INTEGRATION 的待办：
 *
 *  1. **C1 · 引擎 skill / 命令发现回显**（§6.1 的「唯一真正的缺口」）
 *     引擎在 ACP `session/update` 里用 `available_commands_update` 上报它自己发现的
 *     slash command / skill 清单（omp、opencode 都会发）。DSH 事件流里没有对应事件类型
 *     （`SessionEventMap` 只认自己那批），所以这里**不伪造会话事件**，而是把观测结果
 *     记到插件自己的运行时表里，由引擎管理 UI 显示、由 `trace` 留痕。
 *     这样能区分文档里点名的两种故障：「引擎没发现 skill」vs「发现了你看不见」。
 *
 *  2. **握手诊断行**（UI 侧 B4 的一部分）
 *     每个引擎最近一次会话下发了几个 MCP server（B1 的产物）、上报了几个命令，
 *     以及时间戳 —— UI 直接把它拼成一行诊断文字。
 *
 * 上限：命令清单最多留 {@link MAX_COMMANDS} 条，避免某个引擎灌爆内存。
 *
 * @module dsh-multi-acp/engine-runtime
 */

/** 每个引擎最多记录多少条命令 / skill。 */
export const MAX_COMMANDS = 200

/** engineId -> { at, total, commands: [{name, description, hint}] } */
const commandsByEngine = new Map()
/** engineId -> { at, count, summary } */
const mcpByEngine = new Map()
/**
 * engineId -> { at, preset, mapped, reason, poolKey }（A18，2026-10-10）
 *
 * 记录**最近一次会话的权限档映射结果**（A15 的产物）。为什么要显示到 UI：
 * 用户实测两次"以为放开了却仍被拒"，原因都是映射**没生效**：
 *   · `engine-unsupported`（引擎行没声明该档的启动参数）
 *   · `no-preset`（新建会话时 `permissions` 投影还读不到档位）
 * 这两种情况以前只看 `trace.log` 才发现 —— 现在直接落在引擎行的诊断行里。
 */
const permissionByEngine = new Map()
/**
 * engineId -> { at, state, turn, step, tools, lastTool, lastToolAt, startedAt, finishedAt, reason }
 * （B2，2026-10-10）
 *
 * 记录**当前回合的进度**，让"长任务里它在干活"这件事可见 —— 而不碰任何会话事件
 * （助手文本流式那条路已被判定不可行：见 CHANGELOG 0.1.29「C 方案评估」）。
 */
const progressByEngine = new Map()

/** 归一化一条 ACP `AvailableCommand`（`{name, description, input?: {hint}}`）。 */
function normalizeCommand(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = typeof raw.name === 'string' ? raw.name : ''
  if (!name) return null
  return {
    name,
    description: typeof raw.description === 'string' ? raw.description : '',
    ...(raw.input?.hint ? { hint: String(raw.input.hint) } : {}),
  }
}

/**
 * 记录引擎上报的可用命令 / skill（`available_commands_update`）。
 *
 * @returns {{ total: number, commands: object[] }} 归一化后的结果（便于调用方打日志）
 */
export function recordAvailableCommands(engineId, rawCommands) {
  const list = (Array.isArray(rawCommands) ? rawCommands : []).map(normalizeCommand).filter(Boolean)
  const entry = { at: Date.now(), total: list.length, commands: list.slice(0, MAX_COMMANDS) }
  commandsByEngine.set(String(engineId), entry)
  return { total: entry.total, commands: entry.commands }
}

/** 记录一次会话实际下发给引擎的 MCP servers（B1 的产物）。 */
export function recordMcpServers(engineId, { count = 0, summary = '' } = {}) {
  const entry = { at: Date.now(), count, summary }
  mcpByEngine.set(String(engineId), entry)
  return entry
}

/**
 * 记录一次会话的**权限档映射结果**（A15/A18）。
 *
 * @param {string} engineId
 * @param {{preset?:string|null, mapped?:string|null, reason?:string, poolKey?:string}} outcome
 */
export function recordPermissionMapping(engineId, { preset = null, mapped = null, reason = 'unknown', poolKey = null } = {}) {
  const entry = { at: Date.now(), preset, mapped, reason, poolKey }
  permissionByEngine.set(String(engineId), entry)
  return entry
}

// ── B2：回合进度（2026-10-10）─────────────────────────────────────────────
// 目的：长任务进行中，UI（引擎行诊断行）能显示"它正在干活"，
// 且**不往会话里写任何事件**（助手文本流式那条路已被否决，见 CHANGELOG 0.1.29）。

/** 回合开始（`_runTurn` 入口）。 */
export function recordTurnStart(engineId, { turn = 1, step = 1 } = {}) {
  const entry = {
    at: Date.now(),
    state: 'running',
    turn,
    step,
    tools: 0,
    lastTool: null,
    lastToolAt: null,
    startedAt: Date.now(),
    finishedAt: null,
    reason: null,
  }
  progressByEngine.set(String(engineId), entry)
  return entry
}

/** 记录一次工具调用（首次看到该 callId 时调用）。 */
export function recordToolProgress(engineId, { name = null } = {}) {
  const key = String(engineId)
  const entry = progressByEngine.get(key) ?? recordTurnStart(key)
  entry.tools += 1
  entry.lastTool = name ? String(name).slice(0, 60) : entry.lastTool
  entry.lastToolAt = Date.now()
  entry.at = Date.now()
  entry.state = 'running'
  return entry
}

/** 回合结束（无论成功/超时/中止）。 */
export function recordTurnEnd(engineId, { reason = null } = {}) {
  const key = String(engineId)
  const entry = progressByEngine.get(key)
  if (!entry) return null
  entry.state = 'idle'
  entry.finishedAt = Date.now()
  entry.reason = reason
  entry.at = Date.now()
  return entry
}

/** 时长格式化：`3m20s` / `12s` / `1h02m`。 */
export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/**
 * 回合进度的一句话（UI 诊断行用）。
 *
 * 运行中：`运行中：第 7 次工具调用 · 最近: execute（12s 前）· 已耗时 3m20s`
 * 已结束：`上次回合：7 次工具调用 · 耗时 4m01s（completed）`
 */
export function turnProgressSummary(engineId, now = Date.now()) {
  const entry = progressByEngine.get(String(engineId))
  if (!entry) return null
  const elapsed = formatDuration((entry.finishedAt ?? now) - entry.startedAt)
  if (entry.state === 'running') {
    const idleFor = entry.lastToolAt ? formatDuration(now - entry.lastToolAt) : null
    const parts = [`运行中：第 ${entry.tools} 次工具调用`]
    if (entry.lastTool) parts.push(`最近: ${entry.lastTool}${idleFor ? `（${idleFor} 前）` : ''}`)
    else if (idleFor) parts.push(`最近活动 ${idleFor} 前`)
    parts.push(`已耗时 ${elapsed}`)
    return parts.join(' · ')
  }
  const parts = [`上次回合：${entry.tools} 次工具调用 · 耗时 ${elapsed}`]
  if (entry.reason) parts.push(`(${String(entry.reason).slice(0, 40)})`)
  return parts.join('')
}

/** 权限映射的一句话（UI 诊断行用；未映射时给出**可操作的**提示）。 */export function permissionSummary(engineId) {
  const p = permissionByEngine.get(String(engineId))
  if (!p) return null
  if (p.reason === 'mapped' && p.mapped) return `权限映射: ${p.preset} → ${p.mapped}（生效中）`
  if (p.reason === 'disabled') return '权限映射: 已关闭（permissionModeFromSession=false）'
  if (p.reason === 'no-preset') return '权限映射: 未生效（会话档位读不到）— 无人值守请把引擎权限模式设为 dont_ask'
  if (p.reason === 'engine-unsupported') return `权限映射: 未生效（引擎未声明该档参数${p.preset ? `，会话档位 ${p.preset}` : ''}）— 可手填 args 或声明 permissionTemplates`
  if (p.reason === 'read-only-unsupported') return '权限映射: 会话档位【仅可查看】，ACP 无只读引擎语义'
  if (p.reason === 'workspace-write-asks') return '权限映射: 未生效（会话档位【工作区内修改】→ 引擎照常询问）'
  return `权限映射: 未生效（${p.reason}）`
}

/** 读取某个引擎的运行时观测（UI 诊断行用）。 */
export function engineRuntime(engineId) {
  const id = String(engineId)
  const cmd = commandsByEngine.get(id)
  const mcp = mcpByEngine.get(id)
  const perm = permissionByEngine.get(id)
  const progress = progressByEngine.get(id)
  return {
    ...(cmd ? { commandsAt: cmd.at, commandCount: cmd.total, commands: cmd.commands } : {}),
    ...(mcp ? { mcpAt: mcp.at, mcpCount: mcp.count, mcpSummary: mcp.summary } : {}),
    ...(perm ? { permissionAt: perm.at, permissionPreset: perm.preset, permissionMapped: perm.mapped, permissionReason: perm.reason, permissionPoolKey: perm.poolKey } : {}),
    ...(progress ? { progressAt: progress.at, progressState: progress.state, progressTools: progress.tools, progressElapsedMs: (progress.finishedAt ?? Date.now()) - progress.startedAt } : {}),
  }
}

/** 全部引擎的运行时观测（快照，UI 列表用）。 */
export function engineRuntimeSnapshot() {
  const ids = new Set([...commandsByEngine.keys(), ...mcpByEngine.keys(), ...permissionByEngine.keys(), ...progressByEngine.keys()])
  const out = {}
  for (const id of ids) out[id] = engineRuntime(id)
  return out
}

/** 一句诊断文字（UI 直接渲染）。 */
export function engineDiagnosticLine(engineId) {
  const rt = engineRuntime(engineId)
  const parts = []
  parts.push(rt.mcpCount === undefined ? 'MCP：未跑过会话' : `MCP：${rt.mcpSummary || `${rt.mcpCount} 个`}`)
  parts.push(rt.commandCount === undefined ? '引擎命令：未上报' : `引擎命令/技能：${rt.commandCount} 个`)
  // A18：权限映射结果（未生效时给可操作提示 —— 这是"以为放开了却仍被拒"的根因所在）
  const perm = permissionSummary(engineId)
  if (perm) parts.push(perm)
  // B2：回合进度（长任务里"它在干活"可见）
  const progress = turnProgressSummary(engineId)
  if (progress) parts.push(progress)
  const at = Math.max(rt.mcpAt ?? 0, rt.commandsAt ?? 0, rt.permissionAt ?? 0, rt.progressAt ?? 0)
  if (at > 0) parts.push(`最近握手：${new Date(at).toISOString().replace('T', ' ').slice(0, 16)}`)
  return parts.join(' · ')
}

/** 测试 / 重载用：清空。 */
export function resetEngineRuntime() {
  commandsByEngine.clear()
  mcpByEngine.clear()
  permissionByEngine.clear()
  progressByEngine.clear()
}
