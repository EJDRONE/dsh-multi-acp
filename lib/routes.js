/**
 * B2 · 宿主侧 HTTP 路由（引擎管理 API）。
 *
 * 挂在 `ctx.webServer`（`prefix` /multi-acp）。契约见
 * `docs/evidence/B0-ui-contract-findings.md`：
 *   `webServer.register({ kind, path, handler(req,res) })` → disposer；
 *   handler **自己拥有完整响应生命周期**（本文件统一用 sendJson）。
 *
 * 端点：
 *   GET  /multi-acp/engines                 列表（四态 + 可执行体 + 能力）
 *   POST /multi-acp/engines                 新增/写入自定义引擎
 *   PUT  /multi-acp/engines/:id             改 env / 启动方式 / enabled / sortOrder
 *   POST /multi-acp/engines/:id/test        试连（填充 unavailable 的 lastError）
 *   GET  /multi-acp/engines/:id/bound-experts  反向索引（当前无数据源 → 空集+说明）
 *   GET  /multi-acp/engines/:id/commands       引擎上报的命令/技能（C1，进程内观测）
 *
 * ⚠️ 路由直接注册在 webServer 上（与活样例 experts-management 一致）；
 *    监听地址为回环 127.0.0.1（见 webserver Config），不做应用层鉴权。
 *
 * @module dsh-multi-acp/routes
 */
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEngines, describeEngines, saveUserEngine, expandPathTemplate } from './engines.js'
import { discoverCandidates, probeCandidate } from './engine-probe.js'
import { engineRuntime, engineDiagnosticLine } from './engine-runtime.js'

const BASE = '/multi-acp'

/** 统一 JSON 响应。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * 回环守卫：本路由**不做应用层鉴权**（与活样例一致），但引擎 `env` 可能含 API 密钥，
 * 故只允许回环来源 —— 若宿主把 webServer 配成 `0.0.0.0`，这仍是最后一道防线。
 */
function isLoopback(req) {
  const addr = req?.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** 读请求体并 JSON.parse（空体 → {}）。 */
async function readBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim().length === 0 ? {} : JSON.parse(text)
}

/**
 * 把用户 patch 合并到当前生效引擎上，产出一条**完整的用户层行**
 * （`loadEngines` 的用户层是整体覆盖、不做深合并 —— 所以这里先补全再写）。
 *
 * 语义：
 *   - `env`：与现有合并；值为 `null` 的键表示**删除**。
 *   - `enabled` / `sortOrder`：显式提供才改。
 *   - `resolvedCommand` / `args`：显式提供才覆盖（启动方式可换机器后手改）。
 */
function mergeEnginePatch(engine, patch) {
  const p = patch && typeof patch === 'object' ? patch : {}
  const env = { ...(engine.env ?? {}) }
  if (p.env && typeof p.env === 'object') {
    for (const [key, value] of Object.entries(p.env)) {
      if (value === null) delete env[key]
      else env[key] = String(value)
    }
  }
  const out = {
    id: engine.id,
    label: engine.label,
    description: engine.description,
    command: engine.command,
    args: Array.isArray(p.args) ? p.args.map(String) : engine.args,
    cwdPolicy: p.cwdPolicy === 'fixed' || p.cwdPolicy === 'session' ? p.cwdPolicy : engine.cwdPolicy,
    ...(engine.cwd == null ? {} : { cwd: engine.cwd }),
    env,
    commandOverrides: engine.commandOverrides ?? {},
    initialConfigOptions: Array.isArray(p.initialConfigOptions)
      ? p.initialConfigOptions
      : (engine.initialConfigOptions ?? []),
    initBudget: engine.initBudget,
    disposeGraceMs: engine.disposeGraceMs,
    idleDisposeMs: engine.idleDisposeMs,
    enabled: p.enabled === undefined ? engine.enabled : p.enabled !== false,
    sortOrder: p.sortOrder === undefined ? engine.sortOrder : Number(p.sortOrder),
    // B1：MCP 下发策略（'inherit' | 'none' | false | 自定义数组）
    mcp: normalizeMcpPatch(p.mcp, engine.mcp),
    // SKILLS（2026-10-09）：投递方式（auto/args/none）+ 目录列表（空数组 = 用默认 ~/.agents/skills）
    ...(p.skillDelivery === undefined
      ? {}
      : { skillDelivery: ['auto', 'args', 'none'].includes(p.skillDelivery) ? p.skillDelivery : 'auto' }),
    ...(p.skillsDirs === undefined
      ? {}
      : { skillsDirs: (Array.isArray(p.skillsDirs) ? p.skillsDirs : []).map((d) => String(d).trim()).filter(Boolean) }),
    // 权限档（2026-10-10）：'default' | 'dont_ask' | 'bypass'（无人值守任务建议 dont_ask）
    ...(p.permissionMode === undefined
      ? {}
      : { permissionMode: ['default', 'dont_ask', 'bypass'].includes(p.permissionMode) ? p.permissionMode : 'default' }),
    // 超时（A16）：总时长闸 / 空闲闸（毫秒；<=0 = 对应闸关闭）
    ...(p.promptTimeoutMs === undefined ? {} : { promptTimeoutMs: normalizeMillisPatch(p.promptTimeoutMs, engine.promptTimeoutMs) }),
    ...(p.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: normalizeMillisPatch(p.idleTimeoutMs, engine.idleTimeoutMs) }),
    // 启动方式可覆盖（B4-①）：patch 给了非空串就用 patch 的，否则保留引擎行的现值。
    // 写成条件展开而不是 `out.resolvedCommand = …`，与上面各字段同一写法，
    // 也让 TS 能从字面量里推出这个键（给字面量后加属性不会拓宽它的类型）。
    ...((typeof p.resolvedCommand === 'string' && p.resolvedCommand.length > 0)
      ? { resolvedCommand: p.resolvedCommand }
      : (engine.resolvedCommand ? { resolvedCommand: engine.resolvedCommand } : {})),
  }
  return out
}

/**
 * 归一化毫秒 patch（PUT 用）：数字/数字串可用（`<=0` = 关闭该闸），其余保留现值。
 * 用于 `promptTimeoutMs` / `idleTimeoutMs`。
 */
function normalizeMillisPatch(patch, current) {
  if (patch === undefined) return current
  if (patch === null || patch === '') return current
  const value = typeof patch === 'number' ? patch : Number(String(patch).trim())
  return Number.isFinite(value) ? value : current
}

/**
 * 归一化 MCP patch（PUT 用）。`undefined` 保留现值；`'inherit'|'none'|false` 直传；
 * 数组只接受**形状合法**的服务器定义（见 lib/mcp-servers.js），其余丢弃。
 */
function normalizeMcpPatch(patch, current) {
  if (patch === undefined) return current ?? 'inherit'
  if (patch === null || patch === false || patch === 'none') return 'none'
  if (patch === 'inherit' || patch === true) return 'inherit'
  if (Array.isArray(patch)) {
    return patch.filter((c) => c && typeof c === 'object' && typeof c.transport === 'string')
  }
  return current ?? 'inherit'
}

/**
 * 创建 `/multi-acp` 的请求处理器。
 * @param {object} opts
 * @param {string} opts.stateDir      插件状态目录（engines.json 所在）
 * @param {object[]} [opts.configEngines] 插件 config.engines（最高优先级）
 * @param {string} [opts.defaultEngine]   UI 上标"默认引擎"徽章用
 * @param {object} opts.pool          AcpHostPool（用于试连）
 * @param {object} [opts.logger]
 * @param {{ promptTimeoutMs?: number, idleTimeoutMs?: number }} [opts.defaults]
 *   UI 的超时输入框占位符（引擎行自带值优先）
 * @returns {(req, res) => Promise<void>}
 */
export function createRoutesHandler({ stateDir, configEngines = [], defaultEngine = '', pool, logger, defaults = {} }) {
  /** engineId -> 最近一次试连错误（决定 unavailable 态；进程内有效）。 */
  const lastErrors = new Map()
  /** engineId -> 最近一次**成功**试连的能力快照（ISSUE-07：列表徽章用）。 */
  const capabilities = new Map()

  /** 插件自身的名字/版本（UI 右上角显示；读不到就返回 undefined，不阻塞接口）。 */
  const pluginMeta = () => {
    try {
      const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      return { name: pkg.name ?? 'dsh-multi-acp', version: pkg.version ?? '?', description: pkg.description ?? '' }
    } catch (error) {
      logger?.warn?.(`dsh-multi-acp: 读 package.json 失败：${String(error?.message ?? error)}`)
      return { name: 'dsh-multi-acp', version: '?' }
    }
  }

  /**
   * 目录浏览（UI 的路径选择器用，2026-10-09）。
   *
   * 只列**子目录**（不列文件），并给出 parent/quick 快捷入口；不做沙箱限制
   * （本来就要让用户选任意盘符下的目录），但拒绝非目录路径与不可读目录。
   */
  const browse = (rawPath) => {
    const target = expandPathTemplate(String(rawPath ?? '') || (process.env.USERPROFILE ?? process.env.HOME ?? process.cwd()))
    let exists = false
    let dirs = []
    let error
    try {
      exists = statSync(target).isDirectory()
      if (exists) {
        dirs = readdirSync(target, { withFileTypes: true })
          .filter((d) => {
            try { return d.isDirectory() || (d.isSymbolicLink() && statSync(join(target, d.name)).isDirectory()) } catch { return false }
          })
          .map((d) => ({ name: d.name, path: join(target, d.name) }))
          .sort((a, b) => a.name.localeCompare(b.name))
      }
    } catch (e) {
      error = String(e?.message ?? e)
    }
    const parent = dirname(target)
    return {
      path: target,
      exists,
      error,
      parent: parent && parent !== target ? parent : null,
      dirs: dirs.slice(0, 500),
      truncated: dirs.length > 500,
      quick: [
        { label: '用户目录', path: process.env.USERPROFILE ?? process.env.HOME ?? '' },
        { label: 'skills（DSH）', path: join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.agents', 'skills') },
        { label: 'DSH_HOME', path: dirname(stateDir) },
      ].filter((q) => q.path),
    }
  }

  const currentEngines = () => loadEngines({ stateDir, configEngines }).engines
  const describeAll = () =>
    describeEngines(currentEngines(), { lastErrors: Object.fromEntries(lastErrors) }).map((row) => {
      // C1 / B4：运行时观测（引擎上报的命令·技能 + 本次会话下发的 MCP）拼成诊断行，
      // 列表页直接渲染，不需要再点"试连"。
      const runtime = engineRuntime(row.id)
      const withCaps = capabilities.has(row.id) ? { ...row, capabilities: capabilities.get(row.id) } : row
      return { ...withCaps, runtime, diagnostic: engineDiagnosticLine(row.id) }
    })
  /** 归一化引擎（含 commandOverrides/initBudget/cwd/resolvedCommand —— 供 merge/test 用）。 */
  const rawOne = (id) => currentEngines().find((e) => e.id === id)
  /** 展示行（供响应体用）。 */
  const findOne = (id) => describeAll().find((e) => e.id === id)

  async function runTest(engine) {
    try {
      const host = pool.get(engine)
      const report = await host.tryConnect({ cwd: engine.cwd ?? process.cwd() })
      return report
    } catch (error) {
      return { engineId: engine.id, ok: false, error: String(error?.message ?? error) }
    }
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    try {
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'loopback only' })

      if (req.method === 'GET' && path === `${BASE}/engines`) {
        return sendJson(res, 200, {
          engines: describeAll(),
          // 2026-10-09：UI 右上角显示插件名 + 版本号（读 package.json）
          plugin: pluginMeta(),
          // A16：插件级默认值（UI 的占位符用；引擎行自己的值优先）
          defaults,
          stateDir,
          defaultEngine: defaultEngine || '',
          defaultEngineNote:
            '来自插件 config（cordis.patch.yml → dsh-multi-acp.config.defaultEngine）；空串 = 走官方 DSH loop。' +
            '注意 profile/engines.json 不携带该字段 —— 生效值以此为准。',
        })
      }

      // 路径选择器：`GET /multi-acp/browse?path=<dir>`（只列子目录，见 browse()）
      if (req.method === 'GET' && path === `${BASE}/browse`) {
        return sendJson(res, 200, browse(url.searchParams.get('path')))
      }

      // ── 【添加自定义 Agent】用的两个端点（2026-10-09）────────────────────
      // 手动添加：给 command/args，先跑一次真实 ACP 握手，通过才允许保存
      if (req.method === 'POST' && path === `${BASE}/probe`) {
        const body = await readBody(req)
        if (!body?.command) return sendJson(res, 400, { error: 'command is required' })
        const report = await probeCandidate({
          command: String(body.command),
          args: Array.isArray(body.args) ? body.args.map(String) : String(body.args ?? '').split(/\s+/).filter(Boolean),
          cwd: typeof body.cwd === 'string' && body.cwd ? expandPathTemplate(body.cwd) : process.cwd(),
          timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : 20000,
          logger,
        })
        return sendJson(res, 200, report)
      }

      // 通过对话添加：给一个线索（如 "qoder"），列出 PATH/已知位里候选并逐个探测
      if (req.method === 'POST' && path === `${BASE}/discover`) {
        const body = await readBody(req)
        const hint = String(body?.hint ?? '')
        const timeoutMs = Number(body?.timeoutMs) > 0 ? Number(body.timeoutMs) : 15000
        const candidates = discoverCandidates(hint).slice(0, Number(body?.max) > 0 ? Number(body.max) : 6)
        const results = []
        for (const candidate of candidates) {
          const probed = await probeCandidate({ command: candidate.resolved ?? candidate.command, args: candidate.args, timeoutMs, logger })
          results.push({ ...candidate, ...probed })
        }
        return sendJson(res, 200, { hint, candidates: candidates.length, results })
      }

      if (req.method === 'POST' && path === `${BASE}/engines`) {
        const body = await readBody(req)
        if (!body || typeof body.id !== 'string' || !body.id) {
          return sendJson(res, 400, { error: 'engine.id is required' })
        }
        const ok = saveUserEngine(stateDir, body)
        if (!ok) return sendJson(res, 500, { error: 'failed to persist engines.json' })
        return sendJson(res, 200, { ok: true, engine: findOne(body.id) })
      }

      const match = path.match(/^\/multi-acp\/engines\/([^/]+)(\/[a-z-]+)?$/)
      if (match) {
        const id = decodeURIComponent(match[1])
        const sub = match[2] ?? ''
        const raw = rawOne(id)
        if (raw === undefined) return sendJson(res, 404, { error: `unknown engine: ${id}` })

        if (sub === '/test' && (req.method === 'POST' || req.method === 'GET')) {
          const report = await runTest(raw)
          if (report.ok) {
            lastErrors.delete(id)
            // ISSUE-07：缓存能力快照，列表即可渲染徽章（无需再次试连）。
            capabilities.set(id, {
              agentInfo: report.agentInfo ?? null,
              mcpCapabilities: report.mcpCapabilities ?? null,
              sessionCapabilities: report.sessionCapabilities ?? null,
              promptCapabilities: report.promptCapabilities ?? null,
              latencyMs: report.latencyMs ?? null,
              totalMs: report.totalMs ?? null,
            })
          } else {
            lastErrors.set(id, String(report.error ?? 'test failed'))
          }
          return sendJson(res, 200, { ...report, state: findOne(id)?.state })
        }

        if (sub === '' && req.method === 'PUT') {
          const body = await readBody(req)
          const merged = mergeEnginePatch(raw, body)
          const ok = saveUserEngine(stateDir, merged)
          if (!ok) return sendJson(res, 500, { error: 'failed to persist engines.json' })
          return sendJson(res, 200, { ok: true, engine: findOne(id) })
        }

        if (sub === '/commands' && req.method === 'GET') {
          // C1：引擎在 ACP `available_commands_update` 里上报的 slash command / skill。
          // 用来回答"引擎到底有没有发现 skill"（ACP-INTEGRATION §6.1）。
          const rt = engineRuntime(id)
          return sendJson(res, 200, {
            engineId: id,
            commandCount: rt.commandCount ?? 0,
            commands: rt.commands ?? [],
            at: rt.commandsAt ?? null,
            note:
              '来自引擎的 available_commands_update（进程内观测，重启即清空）。' +
              'count=0 表示该引擎没上报过（要么没发现 skill，要么该引擎不发这个 update）。',
          })
        }

        if (sub === '/bound-experts' && req.method === 'GET') {
          // ⚠️ 当前专家包 plugin.json 没有 agentPreset/preset 绑定字段（见 B0 证据 §4）
          //    ⇒ 反向索引无数据源，返回空集 + 说明。待"专家↔引擎"绑定机制落定后再实现。
          return sendJson(res, 200, {
            engineId: id,
            experts: [],
            note: 'no expert↔engine binding exists in the current experts format (plugin.json has no agentPreset)',
          })
        }
      }

      return sendJson(res, 404, { error: `no route: ${req.method} ${path}` })
    } catch (error) {
      logger?.warn?.(`dsh-multi-acp[routes]: ${String(error?.message ?? error)}`)
      return sendJson(res, 500, { error: String(error?.message ?? error) })
    }
  }
}
