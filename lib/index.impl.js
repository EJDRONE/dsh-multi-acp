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
import { unwrapService, probeHostSymbols, summarizeHostProbe, dshHome } from './dsh-imports.js'
import { MultiAcpFactory } from './acp-factory.js'
import { presetIdFor } from './preset-ids.js'
import { nativeToolRows } from './preset-native.js'
import { createRoutesHandler } from './routes.js'
import { Config, DEFAULT_CONFIG, normalizeConfig, schemaDiagnostics } from './config.js'
import { trace } from './trace.js'

/**
 * 配置面（Schemastery `Config` + 边界/跨字段校验）已由 `lib/config.js` 拥有 —— 见 ADR-0004。
 * 这里 re-export，使插件公共面（含 `lib/index.js` 的入口）拿到的是**同一个** `Config` 对象。
 */
export { Config, DEFAULT_CONFIG }

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

export function apply(ctx, rawConfig) {
  // schema 建立失败 / 配置跨字段冲突 —— 都在这里响亮地说出来，不静默降级。
  for (const d of schemaDiagnostics) {
    if (d.level === 'error') ctx.logger?.error?.(`dsh-multi-acp: ${d.source}: ${d.message}`)
    else ctx.logger?.warn?.(`dsh-multi-acp: ${d.source}: ${d.message}`)
  }

  const { config, diagnostics: configDiagnostics } = normalizeConfig(rawConfig)
  // 决定性仪表：把 Loader 实际传进来的配置原样记一条。
  // 起因（2026-10-10）：`host.probe.start`（在 `config.verboseStartup` 为真时才走）
  // **一条都没出现**，而同一份配置里的 `defaultEngine` 却显然生效了 ——
  // 只能靠"看到底传了什么"来区分"配置没到"与"分支没进"。
  trace('apply.enter', {
    rawType: rawConfig === undefined ? 'undefined' : typeof rawConfig,
    rawKeys: rawConfig && typeof rawConfig === 'object' ? Object.keys(rawConfig) : [],
    rawVerboseStartup: rawConfig && typeof rawConfig === 'object' ? rawConfig.verboseStartup : null,
    effectiveVerboseStartup: config.verboseStartup,
    effectivePromptTimeoutMs: config.promptTimeoutMs,
    effectiveDefaultEngine: config.defaultEngine,
  })
  const stateDir = config.stateDir || `${dshHome()}/multi-acp`
  const { engines, diagnostics } = loadEngines({ stateDir, configEngines: config.engines })

  for (const d of [...configDiagnostics, ...diagnostics]) {
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
  // A16：空闲超时同样注入（引擎行自带值优先）
  if (typeof config.idleTimeoutMs === 'number') {
    for (const engine of engines) {
      if (typeof engine.idleTimeoutMs !== 'number') engine.idleTimeoutMs = config.idleTimeoutMs
    }
  }
  const enabled = engines.filter((e) => e.enabled)

  // ── 启动自检：把宿主 API 差异显式化，而不是静默失败 ──────────────
  if (config.verboseStartup) {
    /**
     * 自检结论**必须连同"解析到哪个版本"一起报**（Q5d / ADR-0003）：
     * 同一个 `probeHostSymbols()` 在宿主内与裸 node 下会命中**不同**的宿主树，
     * 只报"缺什么"而不报"对谁说的"会产生假阴性。
     *
     * ⚠️ 必须**同时**写 trace：实测（2026-10-10）Desktop 下 `ctx.logger` 没有可读落点 ——
     * `<DSH_HOME>/dsh-desktop-boot.log` 里只有 Electron 启动器的输出（deepseek-account /
     * 更新检查），插件日志一行都没有。只写 logger 等于"自检结论不存在"。
     */
    const reportHostProbe = (report) => {
      const line = summarizeHostProbe(report)
      const trusted = report.every((r) => r.trustHost)
      trace('host.probe', {
        summary: line,
        trustHost: trusted,
        expected: report[0]?.expected ?? null,
        packages: report.map((r) => ({
          pkg: r.pkg,
          ok: r.ok,
          version: r.version ?? null,
          resolved: r.resolved ?? null,
          missing: r.missing,
        })),
      })
      if (report.every((r) => r.ok)) {
        if (trusted) ctx.logger?.info?.(`dsh-multi-acp: ${line}`)
        else ctx.logger?.warn?.(`dsh-multi-acp: ${line}`)
        return
      }
      ctx.logger?.error?.(`dsh-multi-acp: ${line}`)
      for (const b of report.filter((r) => !r.ok)) {
        ctx.logger?.error?.(`dsh-multi-acp:   ${b.pkg} resolved=${b.resolved ?? '(未解析)'} (${b.error ?? '符号缺失'})`)
      }
    }
    // 先记一条 `start` 再补 `.catch`：没有这两条时，"探测炸了"与"探测没跑"
    // 在外部看起来完全一样（logger 无落点）。这两条 trace 把三种情况分开。
    trace('host.probe.start', {})
    void probeHostSymbols()
      .then(reportHostProbe)
      .catch((error) => {
        trace('host.probe.failed', {
          error: String(error?.message ?? error),
          stack: String(error?.stack ?? '').slice(0, 900),
        })
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

    /**
     * 安全描述一个可能是 Cordis 代理的值：只读自有属性名与 typeof，绝不 JSON.stringify。
     *
     * 字符串属性**带值**（截断 60 字符）：`install.factory-bad-shape` 历史只报
     * `object{target:string}`，无法判断那个 string 是什么（服务名？代理 id？）——
     * 而"要不要放宽形状检查"完全取决于它。见 docs/ISSUES.md。
     */
    const describeShape = (value) => {
      if (value === null) return 'null'
      if (value === undefined) return 'undefined'
      const t = typeof value
      if (t === 'function') return `function(${value.name || 'anonymous'})`
      if (t !== 'object') return `${t}(${String(value)})`
      try {
        return `object{${Object.getOwnPropertyNames(value)
          .map((n) => {
            const vt = typeof value[n]
            return vt === 'string' ? `${n}:string(${String(value[n]).slice(0, 60)})` : `${n}:${vt}`
          })
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

    const factory = new MultiAcpFactory({
      ctx,
      originalTarget: originalSlot.target,
      engines: enabled,
      defaultEngine: config.defaultEngine || '',
      pool,
      stateDir,
      mcpConfig: config.mcp,
      permissionModeFromSession: config.permissionModeFromSession,
    })
    agents.factory = { target: factory }
    trace('install.factory-installed', {
      engines: enabled.map((e) => e.id),
      defaultEngine: config.defaultEngine || '',
      // 诊断（2026-10-10）：重复 apply 会把我们自己的工厂**再包一层**。
      // 记下"被替换的是什么、是不是我们自己的、现在套了几层" —— 这三项决定了
      // "形状不对就拒绝替换"这条保守策略要不要放宽（见 docs/ISSUES.md / ADR-0006）。
      replaced: describeShape(originalSlot),
      replacedWasOurs: target instanceof MultiAcpFactory,
      depth: factory.depth,
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
        // A16：UI 的超时输入框用这些当占位符（引擎行自带值优先）
        defaults: { promptTimeoutMs: config.promptTimeoutMs, idleTimeoutMs: config.idleTimeoutMs },
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
