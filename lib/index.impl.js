/**
 * dsh-multi-acp · 插件入口
 *
 * 作用：让 DSH 的一个会话由外部 ACP CLI 作为**根 agent** 驱动。
 * 引擎是数据行（见 engines.js），新增引擎不需要改本文件。
 *
 * ── 依赖的宿主 API（均由 app.asar 静态检索确认存在于 0.2.0-rc.2）────────
 *   ctx.agents.factory          普通实例属性，形状 { target }；消费方读 .target
 *                               （setFactory 的"已注册就抛错"守卫拦不住直接赋值）
 *   ctx.agentPresets.register() 公开方法，返回 unregister disposer
 *   ctx.agentPresets.select()   官方锁门方法（内部 recompose + session.append）
 *   ctx.agentPresets.mount()    preset 挂载
 *
 * 证据：docs/evidence/P0-step0-asar-findings.md
 *
 * @module dsh-multi-acp
 */
import { loadEngines } from './engines.js'
import { AcpHostPool } from './acp-host.js'
import { unwrapService, probeHostSymbols, dshHome } from './dsh-imports.js'
import { MultiAcpFactory } from './acp-agent.js'
import { presetIdFor } from './preset-ids.js'
import { nativeToolRows, normalizeGroups } from './preset-native.js'
import { createRoutesHandler } from './routes.js'
import { trace } from './trace.js'

export { presetIdFor, engineIdFromPreset, PRESET_ID_PREFIX } from './preset-ids.js'

export const name = 'dsh-multi-acp'

/**
 * 依赖的服务。
 *
 * ⚠️ **必须与官方 AgentLoop 的 inject 对齐**（`dsh-agent-loop/lib/index.js:976`：
 * `["agents","sessions","llm","tools","systemPrompt"]`）。
 *
 * 原因（2026-10-09 15:15 的**宿主崩溃**实录）：
 * `dsh-scope#createScope(ctx, key)` 的注释写着 "The scoped context **inherits the minting
 * plugin's dependency API**" —— 我们用 `createScope(rootCtx, agent)` 造出来的
 * `agent.ctx` 能访问哪些服务，取决于**本插件**的 inject 列表。
 * 官方 loop 用 `createScope(loopCtx, this)`，而 loopCtx 能访问 `systemPrompt`/`tools`/`llm`
 * （因为 AgentLoop 声明了它们），所以别人的插件可以放心地对 `agent.ctx` 上下其手；
 * 我们没声明，于是 `dsh-experimental-tool-agent-team` 的
 * `install()` 里那句 `scoped.systemPrompt.section(...)` 直接把宿主打死：
 *
 *   Error: cannot get property "systemPrompt" without inject
 *     at install (dsh-experimental-tool-agent-team/lib/index.js:237)
 *     at maybeInstall (…:541)  ← 它监听 `agent/created`，对"团队成员" agent 装团队工具
 *     at async Proxy.announce (dsh-agent/lib/index.js:579)
 *     → `dsh: fatal load failure` → 宿主进程退出（崩溃报告 crash-2026-10-09T07-15-29-089Z-host.log）
 *
 * 结论：**我们这个"替身 factory"造出来的 agent，其 scoped ctx 必须和官方 agent 的
 * 长得一样**，否则任何按官方约定访问 `agent.ctx` 的插件都可能把宿主带崩。
 * （与 v0.1.12 客户端 `inject: ['slots','locale']` 是同一类教训。）
 *
 * `agentPresets` / `commands` 是本插件自己另外需要的（注册 preset、读命令面板）。
 */
export const inject = ['agents', 'agentPresets', 'sessions', 'commands', 'tools', 'systemPrompt', 'llm']

/**
 * 配置默认值。
 *
 * ⚠️ 这里**刻意不用 schemastery 构造 schema**。
 *
 * 原因：插件在 `启动失败` 状态下，最可能的是**模块求值期抛错**，
 * 而 schema 构造（`Schema.object` / `Schema.array(Schema.any())`）正是
 * 求值期最容易出问题的一环 —— 宿主用的是 `@deepseek-ai/schemastery`，
 * 与公开的 `schemastery` 未必同源。
 *
 * Cordis 允许插件不带 Config；缺省值由 apply() 内部归一化。
 * 等确认插件能加载后，再决定要不要把强类型 schema 加回来。
 */
export const DEFAULT_CONFIG = {
  defaultEngine: '',
  stateDir: '',
  engines: [],
  verboseStartup: true,
  // 原生工具组合：true=全部分组；false=只要 marker（旧行为）；也可给分组数组/逗号串，
  // 见 preset-native.js 的 NATIVE_TOOL_GROUPS。
  presetTools: true,
  // 用 entry-local 的 dsh-fs-local 遮蔽宿主 sandboxed fs（照 minimal preset 的写法）。
  // 打开后 ACP 会话写工作区之外不再被拒（FS_SANDBOX_DENIED）。
  unsandboxedFs: false,
  // MCP 注入策略：{enabled, include: [], exclude: []}；引擎自己的 engine.mcp 优先。
  // 见 lib/mcp-servers.js。
  mcp: { enabled: true, include: [], exclude: [] },
  /**
   * 一次 ACP `session/prompt` 的超时（毫秒）。**<= 0 = 不超时**。
   *
   * 默认 300000（旧的硬编码值，保持兼容）。实测 omp 在大任务上跑到 300s 被我们掐断
   * （`session-fb54ccef`：`acp[omp]: session/prompt: timed out after 300s`），
   * 所以做成可配置；引擎行若自带 `promptTimeoutMs` 则以引擎行为准（见 apply 里的注入）。
   */
  promptTimeoutMs: 300000,
  /**
   * 2026-10-10：把**会话权限档**映射成引擎的 `permissionMode`
   *（【完全权限】⇒ 引擎以 `dont_ask` 启动；否则定时任务会因"审批没人批"被全通道拒绝）。
   * 【工作区内修改】/【仅可查看】沿用引擎默认并记告警。见 lib/permission-bridge.js。
   */
  permissionModeFromSession: true,
}

/** 把任意（含 undefined / 部分）配置归一化。 */
function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  return {
    defaultEngine: typeof cfg.defaultEngine === 'string' ? cfg.defaultEngine : DEFAULT_CONFIG.defaultEngine,
    stateDir: typeof cfg.stateDir === 'string' ? cfg.stateDir : DEFAULT_CONFIG.stateDir,
    engines: Array.isArray(cfg.engines) ? cfg.engines : DEFAULT_CONFIG.engines,
    verboseStartup: cfg.verboseStartup !== false,
    presetTools: normalizeGroups(cfg.presetTools),
    unsandboxedFs: cfg.unsandboxedFs === true || cfg.unsandboxedFs === 'true',
    mcp: normalizeMcpConfig(cfg.mcp),
    promptTimeoutMs: normalizePromptTimeout(cfg.promptTimeoutMs),
    permissionModeFromSession: cfg.permissionModeFromSession !== false,
  }
}

/** 归一化 prompt 超时：数字毫秒；`<=0` = 不超时；非法值回落到默认 300s。 */
function normalizePromptTimeout(raw) {
  if (raw === undefined || raw === null) return DEFAULT_CONFIG.promptTimeoutMs
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isFinite(value)) return DEFAULT_CONFIG.promptTimeoutMs
  return value
}

/** 归一化 MCP 注入配置：`{enabled, include, exclude}`（也容忍 `false`）。 */
function normalizeMcpConfig(raw) {
  if (raw === false) return { enabled: false, include: [], exclude: [] }
  if (raw === true || raw === undefined || raw === null) return { ...DEFAULT_CONFIG.mcp }
  const cfg = typeof raw === 'object' ? raw : {}
  return {
    enabled: cfg.enabled !== false,
    include: Array.isArray(cfg.include) ? cfg.include.map(String) : [],
    exclude: Array.isArray(cfg.exclude) ? cfg.exclude.map(String) : [],
  }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const stateDir = config.stateDir || `${dshHome()}/multi-acp`
  const { engines, diagnostics } = loadEngines({ stateDir, configEngines: config.engines })

  for (const d of diagnostics) {
    if (d.level === 'error') ctx.logger?.error?.(`dsh-multi-acp: ${d.source}: ${d.message}`)
    else ctx.logger?.warn?.(`dsh-multi-acp: ${d.source}: ${d.message}`)
  }
  ctx.logger?.info?.(
    `dsh-multi-acp: ${engines.length} engine(s) loaded [${engines.map((e) => e.id).join(', ')}], stateDir=${stateDir}`,
  )

  const pool = new AcpHostPool({ logger: ctx.logger })
  // ── 2026-10-09：把插件级 prompt 超时注入每条引擎行 ────────────────────
  // AcpClient#_budgetMs('prompt') 读 `engine.promptTimeoutMs`；
  // 引擎行自己声明了就尊重引擎行（可用于个别慢引擎单独放宽）。
  if (typeof config.promptTimeoutMs === 'number') {
    for (const engine of engines) {
      if (typeof engine.promptTimeoutMs !== 'number') engine.promptTimeoutMs = config.promptTimeoutMs
    }
  }
  const enabled = engines.filter((e) => e.enabled)

  // ── 启动自检：把宿主 API 差异显式化，而不是静默失败 ──────────────
  if (config.verboseStartup) {
    void probeHostSymbols().then((report) => {
      const bad = report.filter((r) => !r.ok)
      if (bad.length === 0) {
        ctx.logger?.info?.('dsh-multi-acp: host symbol self-check OK')
      } else {
        for (const b of bad) {
          ctx.logger?.error?.(
            `dsh-multi-acp: host symbol missing — ${b.pkg}: [${b.missing.join(', ')}]` +
              (b.error ? ` (${b.error})` : ''),
          )
        }
      }
    })
  }

  // ── ① 为每个引擎注册一个 preset ────────────────────────────────
  // 用 ctx.agentPresets.register(definition)；返回值是 unregister disposer。
  const unregisters = []
  ctx.effect(() => {
    let cancelled = false
    const presets = unwrapService(ctx.agentPresets)
    if (!presets || typeof presets.register !== 'function') {
      ctx.logger?.error?.(
        'dsh-multi-acp: ctx.agentPresets.register() not available — presets cannot be registered. ' +
          'Engines will not be selectable.',
      )
      return () => {}
    }

    void (async () => {
      for (const engine of enabled) {
        // ── 原生工具组合（2026-10-09 修）──────────────────────────────
        // 曾经这里只有 marker 一行 → 会话的工具目录只剩全局层，DSH 原生的
        // read/write/edit/glob/grep/pwsh/skill 一个都不在（实测 session-144c11b2
        // 里模型探到 unknown tool "write"）。现在按 standard preset 的工具行补齐。
        const nativeRows = nativeToolRows({
          unsandboxedFs: config.unsandboxedFs,
          groups: config.presetTools,
        })
        const definition = {
          id: presetIdFor(engine.id),
          name: engine.label?.zh ?? engine.label?.en ?? engine.id,
          description: engine.description?.zh ?? engine.description?.en ?? '',
          order: engine.sortOrder,
          // ⚠️ plugins 的字段名需以 0.2.0-rc.2 的 preset 类型为准（见 docs 待验清单）
          plugins: [...nativeRows, { name: 'dsh-multi-acp/preset-marker', config: { engineId: engine.id } }],
        }
        trace('preset.register', {
          presetId: definition.id,
          engineId: engine.id,
          nativeToolRows: nativeRows.map((r) => r.id ?? r.name),
          unsandboxedFs: config.unsandboxedFs,
        })
        try {
          const unregister = await presets.register(definition)
          if (cancelled) {
            await unregister?.()
            continue
          }
          unregisters.push(unregister)
          ctx.logger?.info?.(`dsh-multi-acp: preset registered "${definition.id}"`)
        } catch (error) {
          ctx.logger?.error?.(
            `dsh-multi-acp: failed to register preset "${definition.id}": ${String(error?.message ?? error)}`,
          )
        }
      }
    })()

    return () => {
      cancelled = true
      for (const un of unregisters.splice(0)) {
        Promise.resolve(un?.()).catch((error) => {
          ctx.logger?.warn?.(`dsh-multi-acp: preset unregister failed: ${String(error?.message ?? error)}`)
        })
      }
    }
  })

  // ── ② 替换 agent factory ──────────────────────────────────────
  // 保存官方 factory 作为"走原生 DSH"的分支，所以本插件不破坏默认行为。
  ctx.effect(() => {
    const agents = unwrapService(ctx.agents)
    if (!agents) {
      ctx.logger?.error?.('dsh-multi-acp: ctx.agents not available — cannot install agent factory')
      return () => {}
    }
    const originalSlot = agents.factory
    if (originalSlot === undefined) {
      trace('install.factory-empty', {})
      // 官方 agent-loop 尚未注册。这通常意味着本插件挂载过早。
      ctx.logger?.error?.(
        'dsh-multi-acp: ctx.agents.factory is empty — the official agent-loop has not registered yet. ' +
          'The factory was NOT replaced; ACP engines will not be usable this run.',
      )
      return () => {}
    }
    // ⚠️ 两个真实踩过的坑，留在这里当护栏：
    //
    //   1) 绝不能对 Cordis 的 traced 服务做 JSON.stringify —— 它会去读 `.toJSON`，
    //      而 Cordis 对未声明 inject 的属性**直接抛错**：
    //        Error: cannot get property "toJSON" without inject
    //      后果是"防御性错误信息自身崩溃"，插件表现为「启动失败」，
    //      而真正的故障条件反而被完全掩盖。必须用下面的 describeShape()。
    //
    //   2) 官方类型里 `AgentFactory` 是**带 createAgent/resume 方法的对象**，
    //      **不是函数**。早先写成 `typeof target !== 'function'` 会把
    //      完全正常的情况误判成异常，进而走到上面那个会崩的日志分支。
    const target = originalSlot?.target
    const looksLikeFactory =
      target !== null &&
      typeof target === 'object' &&
      typeof target.createAgent === 'function' &&
      typeof target.resume === 'function'

    /** 安全描述一个可能是 Cordis 代理的值：只读自有属性名与 typeof，绝不 JSON.stringify。 */
    const describeShape = (value) => {
      if (value === null) return 'null'
      if (value === undefined) return 'undefined'
      const t = typeof value
      if (t === 'function') return `function(${value.name || 'anonymous'})`
      if (t !== 'object') return `${t}(${String(value)})`
      try {
        return `object{${Object.getOwnPropertyNames(value)
          .map((n) => `${n}:${typeof value[n]}`)
          .join(', ')}}`
      } catch (error) {
        return `object(uninspectable: ${String(error?.message ?? error)})`
      }
    }

    if (!looksLikeFactory) {
      trace('install.factory-bad-shape', { shape: describeShape(originalSlot) })
      ctx.logger?.error?.(
        `dsh-multi-acp: unexpected ctx.agents.factory shape (${describeShape(originalSlot)}) — ` +
          'host API may have changed. The factory was NOT replaced.',
      )
      return () => {}
    }

    agents.factory = {
      target: new MultiAcpFactory({
        ctx,
        originalTarget: originalSlot.target,
        engines: enabled,
        defaultEngine: config.defaultEngine || '',
        pool,
        stateDir,
        mcpConfig: config.mcp,
        permissionModeFromSession: config.permissionModeFromSession,
      }),
    }
    trace('install.factory-installed', {
      engines: enabled.map((e) => e.id),
      defaultEngine: config.defaultEngine || '',
    })
    ctx.logger?.info?.(
      `dsh-multi-acp: agent factory installed (preserving official factory as fallback); ` +
        `defaultEngine=${config.defaultEngine || '(official DSH)'}`,
    )

    return () => {
      agents.factory = originalSlot
      trace('install.factory-restored', {})
      ctx.logger?.info?.('dsh-multi-acp: agent factory restored')
    }
  })

  // ── ③ 回收 ACP 进程 ───────────────────────────────────────────
  ctx.effect(() => () => {
    void pool.disposeAll()
  })

  // ── ④ 引擎管理路由（B2）───────────────────────────────────────
  // 挂在 ctx.webServer（`prefix` /multi-acp）。webServer 缺席时跳过，不阻塞加载。
  // 契约：webServer.register({ kind, path, handler }) → disposer（见 B0 证据）。
  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const webServer = unwrapService(child.webServer)
      if (!webServer || typeof webServer.register !== 'function') {
        ctx.logger?.warn?.('dsh-multi-acp: webServer unavailable — engine management routes not registered')
        return () => {}
      }
      const handler = createRoutesHandler({
        stateDir,
        configEngines: config.engines,
        defaultEngine: config.defaultEngine || '',
        pool,
        logger: ctx.logger,
      })
      const dispose = webServer.register({ kind: 'prefix', path: '/multi-acp', handler })
      ctx.logger?.info?.('dsh-multi-acp: engine management routes registered at /multi-acp')
      return () => {
        try {
          dispose?.()
        } catch {
          /* ignore */
        }
      }
    }, 'dsh-multi-acp: engine routes')
  })
}
