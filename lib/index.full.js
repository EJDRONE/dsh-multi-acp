/**
 * ⚠️⚠️ 历史备份 / 仅供参考 —— **不是入口**，行为已落后于 `lib/index.impl.js` ⚠️⚠️
 *
 *   - 真正的入口链：`lib/index.js`（诊断加载器）→ `lib/index.impl.js`（实现在这里）
 *   - 本文件保留自 v0.1.x 的"单文件全量"版本，**不要**用它替换 impl：
 *     · preset 组合仍只有 `preset-marker` 一行 → 会话没有任何 DSH 原生工具
 *       （2026-10-09 的 ISSUE-08 就是这个坑，正确做法见 lib/preset-native.js）
 *     · 没有 session-map 回落（resume 会静默跑原生 loop）
 *     · 没有 MCP 注入（lib/mcp-servers.js）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * dsh-multi-acp · 插件入口（历史版本）
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

export { presetIdFor, engineIdFromPreset, PRESET_ID_PREFIX } from './preset-ids.js'

export const name = 'dsh-multi-acp'

export const inject = ['agents', 'agentPresets', 'sessions', 'commands']

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
}

/** 把任意（含 undefined / 部分）配置归一化。 */
function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  return {
    defaultEngine: typeof cfg.defaultEngine === 'string' ? cfg.defaultEngine : DEFAULT_CONFIG.defaultEngine,
    stateDir: typeof cfg.stateDir === 'string' ? cfg.stateDir : DEFAULT_CONFIG.stateDir,
    engines: Array.isArray(cfg.engines) ? cfg.engines : DEFAULT_CONFIG.engines,
    verboseStartup: cfg.verboseStartup !== false,
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
        const definition = {
          id: presetIdFor(engine.id),
          name: engine.label?.zh ?? engine.label?.en ?? engine.id,
          description: engine.description?.zh ?? engine.description?.en ?? '',
          order: engine.sortOrder,
          // ⚠️ plugins 的字段名需以 0.2.0-rc.2 的 preset 类型为准（见 docs 待验清单）
          plugins: [{ name: 'dsh-multi-acp/preset-marker', config: { engineId: engine.id } }],
        }
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
      // 官方 agent-loop 尚未注册。这通常意味着本插件挂载过早。
      ctx.logger?.error?.(
        'dsh-multi-acp: ctx.agents.factory is empty — the official agent-loop has not registered yet. ' +
          'The factory was NOT replaced; ACP engines will not be usable this run.',
      )
      return () => {}
    }
    if (typeof originalSlot?.target !== 'function') {
      ctx.logger?.error?.(
        `dsh-multi-acp: unexpected ctx.agents.factory shape (${JSON.stringify(originalSlot)}) — ` +
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
      }),
    }
    ctx.logger?.info?.(
      `dsh-multi-acp: agent factory installed (preserving official factory as fallback); ` +
        `defaultEngine=${config.defaultEngine || '(official DSH)'}`,
    )

    return () => {
      agents.factory = originalSlot
      ctx.logger?.info?.('dsh-multi-acp: agent factory restored')
    }
  })

  // ── ③ 回收 ACP 进程 ───────────────────────────────────────────
  ctx.effect(() => () => {
    void pool.disposeAll()
  })
}
