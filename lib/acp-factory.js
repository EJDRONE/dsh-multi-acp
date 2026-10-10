/**
 * ACP 路由工厂 —— 决定"这一轮由谁造 agent"。
 *
 * 从 `acp-agent.js` 抽出（Q6 批次二 · 工厂切片）。它的职责只有一件事：
 * 看会话选中的 preset，属于本插件（`acp-<engineId>`）→ 交给外部 ACP CLI；
 * 其他 → **原样委托**官方 DSH factory（"跑原生 DSH"零成本）。
 *
 * ⚠️ 这里有一个**跨越宿主类型边界**的动作：直接赋值 `ctx.agents.factory`
 * （宿主把它声明为 `private`，官方 `setFactory()` 因"已注册即抛错"不可用）。
 * 完整背景、代价与升级后的检查方法见 `docs/adr/0006-route-b-replaces-private-factory.md`。
 *
 * 依赖方向：本模块 → `./acp-agent.js`（装配）。**不要**反向 import，否则成环。
 *
 * @module dsh-multi-acp/acp-factory
 */

import { engineIdFromPreset, presetIdFor } from './preset-ids.js'
import { readSessionMap } from './session-map.js'
import { trace } from './trace.js'
import { assertAgentContract, contractError, isExplicitAcpFailure, isWriteHandleConflict } from './agent-contract.js'
import { createAcpAgent } from './acp-agent.js'

/**
 * Agent 工厂。按会话选中的 preset 决定由谁创建 agent：
 *  - preset 属于本插件（`acp-<engineId>`）→ 外部 ACP CLI
 *  - 其他 → 原样委托官方 DSH factory（"跑原生 DSH"零成本）
 */
export class MultiAcpFactory {
  constructor({ ctx, originalTarget, engines, defaultEngine, pool, stateDir, mcpConfig, permissionModeFromSession = true }) {
    this.ctx = ctx
    this.originalTarget = originalTarget
    /**
     * 诊断（2026-10-10）：本工厂"套"在几层**同类型**工厂之上。
     *
     * 正常应当恒为 `1`。`>1` 说明发生了**重复 apply 导致的自我嵌套**：
     * Cordis 会在注入的依赖逐个就绪时重复 apply 同一个插件，而我们每次 apply
     * 都无条件再包一层（`originalTarget` = 上一次自己）。历史 trace 里
     * 14 个 pid 出现过 `installed ×6 → bad-shape → empty → restored` 这一签名。
     * 见 `docs/ISSUES.md` 与 ADR-0006。
     */
    this.depth = originalTarget instanceof MultiAcpFactory ? (originalTarget.depth ?? 1) + 1 : 1
    this.engines = engines
    this.defaultEngine = defaultEngine
    this.pool = pool
    // A4：会话映射（dshSessionId → acpSessionId）落在插件自己的 stateDir
    this.stateDir = stateDir
    // B1：MCP 注入的插件级策略（mcp.enabled / include / exclude / servers）
    this.mcpConfig = mcpConfig
    /**
     * 2026-10-10：是否把**会话权限档**映射成引擎的 `permissionMode`
     * （完全权限 ⇒ 引擎免问；见 lib/permission-bridge.js）。默认开，可用插件配置关掉。
     */
    this.permissionModeFromSession = permissionModeFromSession !== false
    /**
     * A13/A15：会话投影注册表（读 `turnBoundary`、`permissions` 用）。
     * 工厂从 rootCtx 拿一次即可 —— 之前只在 createAcpAgent 里取，工厂级访问器忘了存。
     */
    this.projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
    this._byId = new Map(engines.map((e) => [e.id, e]))
    /**
     * A10：本工厂**自己驱动**的活 agent（dshSessionId → { agent, dispose, engineId }）。
     *
     * 为什么必须有这张表：DSH 的 `agents.resume()` 是**无条件转发**给工厂的
     * （dsh-agent/lib/index.js:556-561，没有"已有活 agent 就 attach"的分支），
     * 而 `sessionPersistence.open(id,'write')` 是**单写所有权**：
     * 会话若已经有活 agent 持着写句柄，第二次 open 会抛
     *   `session "…" is already owned by an active write handle`
     * → 我们 resume 失败 → 回落原生 loop（用户看到「无法切换到 XXX」）。
     *
     * 实测（2026-10-09 15:02–15:06，session-e877352c）：
     *   create(acp-omp) 成功并 spawn 了 omp → 2.4s 后 UI 切 preset → resume → 撞上上面这条错，
     *   之后连「标准模式」都切不动（官方 resume 也拿不到句柄）→ 会话彻底卡死。
     *
     * 因此 create / resume 之前，先把**我们自己**为该会话持有的旧 agent 释放掉
     * （dispose 会 close 写句柄）。这不是越权：那是我们自己创建的 agent。
     */
    this._live = new Map()
  }

  /** 记住本工厂驱动的一个活 agent（dispose 时自动摘表）。 */
  _trackLive(sessionId, handle, engineId) {
    const key = String(sessionId ?? '')
    if (!key) return handle
    const wrapped = {
      ...handle,
      dispose: async () => {
        this._live.delete(key)
        return await handle.dispose()
      },
    }
    this._live.set(key, { agent: handle.agent, dispose: wrapped.dispose, engineId })
    return wrapped
  }

  /**
   * A10：写句柄冲突时把「谁占着」记清楚 —— 下次一眼能看出是我们的活 agent 没释放，
   * 还是宿主里另一个 agent（例如官方 loop、或插件重载前的旧 agent）。
   */
  _diagnoseHandleConflict(error, sessionId, why) {
    if (!isWriteHandleConflict(error)) return
    const key = String(sessionId ?? '')
    let liveInHost = false
    try {
      liveInHost = Boolean(this.ctx.agents?.get?.(key))
    } catch { /* 服务不可用就算了 */ }
    const ours = this._live.has(key)
    trace('factory.handle-conflict', { sessionId: key, why, ours, liveInHost })
    this.ctx.logger?.error?.(
      `dsh-multi-acp: session ${key} is still owned by an active write handle ` +
        `(ours=${ours}, hostHasLiveAgent=${liveInHost}) during ${why}. ` +
        'The previous agent was not released — close that session, or restart DSH, then retry.',
    )
  }

  /**
   * 释放本工厂为该会话遗留的活 agent（若有）。返回是否真的释放了。
   *
   * 这是「切换 preset / 重开会话」能成功的前提：写句柄必须先还回去。
   */
  async _disposeStale(sessionId, why) {
    const key = String(sessionId ?? '')
    if (!key) return false
    const live = this._live.get(key)
    if (!live) return false
    trace('factory.live.dispose-stale', { sessionId: key, why, engineId: live.engineId ?? null })
    this.ctx.logger?.info?.(
      `dsh-multi-acp: releasing the previous agent for ${key} before ${why} ` +
        '(a live agent must not keep the session write handle across a preset switch)',
    )
    this._live.delete(key)
    try {
      await live.dispose()
    } catch (error) {
      trace('factory.live.dispose-stale.failed', { sessionId: key, message: String(error?.message ?? error) })
    }
    return true
  }

  engineForPreset(presetId) {
    const engineId = engineIdFromPreset(presetId)
    return engineId ? this._byId.get(engineId) : undefined
  }

  /**
   * 从 createAgent/resume 的 options 里解析目标 preset。
   *
   * ── A9（2026-10-09 修）：resume 路径上 preset **必须**从会话映射里找回来 ──────
   * 实测（`<stateDir>/trace.log`，2026-10-09 01:28-05:55）：每一次
   * `factory.resume` 都是 `presetId:null → fallback-native`，因为
   * `ResumeAgentOptions` 里**根本没有 agentPreset 字段**
   * （`@deepseek-ai/dsh-agent/lib/types/index.d.ts`：`{resumeSessionId, agentOptions?, signal?, setup?}`）。
   *
   * 后果：任何 ACP 会话在**重启 / 重开会话**之后都会静默落回官方 agent-loop。
   * 而官方 loop 会按持久化的 `agentPreset`（= 我们的 `acp-*`）去挂 preset ——
   * 以前那个 preset 只有 marker 一行、没有工具行，于是用户得到一个
   * "没有任何 shell / 文件系统工具"的会话（见 preset-native.js 的实测记录）。
   *
   * 现在：先看 options 显式字段，再查插件自己的会话映射（`session-map.json`，
   * 里面记了 `engineId`），最后才用 defaultEngine。
   */
  _presetIdOf(options) {
    const explicit = options?.meta?.agentPreset ?? options?.agentPreset
    if (explicit) return explicit
    const resumeSessionId = options?.resumeSessionId
    if (resumeSessionId !== undefined && resumeSessionId !== null && resumeSessionId !== '') {
      const key = String(resumeSessionId)
      // ① 活会话当前的 preset —— 这是「切换 preset」时的**唯一权威**
      //    用户点「切换到 OpenCode」时，UI 先把 session.agentPreset 改掉，然后
      //    `agents.resume({resumeSessionId})`；而 ResumeAgentOptions **不带** preset，
      //    所以只能从活会话上读。若不读这里，A9 的 map 回落会把旧引擎（omp）当成目标，
      //    切到哪都还是 omp（实测 2026-10-09 15:04: 三个 preset 都报同一句
      //    "already owned by an active write handle"，因为都被解析成 acp-omp → 又去抢句柄）。
      try {
        const live = this.ctx.sessions?.get?.(key)
        if (live?.agentPreset) {
          trace('factory.resume.preset-from-live', { sessionId: key, presetId: live.agentPreset })
          return live.agentPreset
        }
      } catch (error) {
        trace('factory.resume.live-preset-error', { sessionId: key, message: String(error?.message ?? error) })
      }
      // ② 插件的会话映射（重启之后的冷 resume 用；若 ① 拿到了就不会走到这里）
      try {
        const mapped = readSessionMap(this.stateDir)[key]
        if (mapped?.engineId) {
          trace('factory.resume.engine-from-map', { sessionId: key, engineId: mapped.engineId })
          return presetIdFor(mapped.engineId)
        }
        trace('factory.resume.map-miss', { sessionId: key })
      } catch (error) {
        trace('factory.resume.map-error', { message: String(error?.message ?? error) })
      }
    }
    // 未显式指定时用 defaultEngine（若配置了）
    return this.defaultEngine ? presetIdFor(this.defaultEngine) : undefined
  }

  /**
   * ⚠️ 安全设计：本工厂是**全局替换** `agents.factory` 的，一旦它抛错，
   *    会波及**所有会话的创建**（不只是 ACP 会话）。
   *
   *    因此这里对所有非预期失败做**降级兜底**：记错误 → 退回官方 factory。
   *    代价是"ACP 引擎静默不可用"，但保住了"普通会话仍然可用"。
   *    对用户正在使用的环境，这个取舍是必须的。
   *
   *    注意：`assertAgentContract()` 失败时**不兜底**——那是"我们明知自己
   *    没准备好"的情况，应当明确报错（见下）。
   */
  async createAgent(ownerCtx, options) {
    let engine
    let presetId
    try {
      presetId = this._presetIdOf(options)
      engine = this.engineForPreset(presetId)
      trace('factory.createAgent', {
        presetId: presetId ?? null,
        engineId: engine?.id ?? null,
        metaKeys: options?.meta ? Object.keys(options.meta) : null,
      })
    } catch (error) {
      trace('factory.createAgent.error', { message: String(error?.message ?? error) })
      // 连解析 preset 都失败 → 绝不能影响官路径
      this.ctx.logger?.error?.(`dsh-multi-acp: preset resolution failed, falling back: ${String(error?.message ?? error)}`)
      return this.originalTarget.createAgent(ownerCtx, options)
    }
    // A10：**无论**这次会不会走引擎，先把我们自己为该会话遗留的活 agent/写句柄还回去。
    //   为什么必须放在分支之前：切到「标准模式」时我们不创建 ACP agent（走官方 fallback），
    //   但上一个 ACP agent 若还活着，官方 resume 的 `persistence.prepare` 会直接拒绝
    //   （`cannot prepare session "…" while it is live`）—— 用户看到的就是「切不动」。
    await this._disposeStale(options?.sessionId, 'create')

    if (!engine) {
      trace('factory.createAgent.fallback-native', { presetId: presetId ?? null })
      return this.originalTarget.createAgent(ownerCtx, options)
    }

    // 明确的配置性失败：报错，不静默兜底（用户需要知道为什么 ACP 引擎不可用）
    const contract = await assertAgentContract()
    trace('factory.createAgent.contract', { ok: contract.ok, message: contract.message ?? null })
    if (!contract.ok) throw contractError(contract.message)

    try {
      trace('factory.createAgent.spawning', { engineId: engine.id, command: engine.command ?? null })
      const handle = await createAcpAgent({ rootCtx: this.ctx, ownerCtx, options, engine, pool: this.pool, stateDir: this.stateDir, mcpConfig: this.mcpConfig, projections: this.projections, permissionModeFromSession: this.permissionModeFromSession })
      return this._trackLive(options?.sessionId, handle, engine.id)
    } catch (error) {
      if (isExplicitAcpFailure(error)) {
        trace('factory.createAgent.explicit-failure', { name: error?.name, message: String(error?.message ?? error) })
        throw error
      }
      trace('factory.createAgent.error-fallback', { message: String(error?.message ?? error) })
      this._diagnoseHandleConflict(error, options?.sessionId, 'create')
      this.ctx.logger?.error?.(
        `dsh-multi-acp[${engine.id}]: agent creation failed, falling back to the official factory: ` +
          `${String(error?.message ?? error)}`,
      )
      return this.originalTarget.createAgent(ownerCtx, options)
    }
  }

  async resume(ownerCtx, options) {
    let engine
    let presetId
    try {
      presetId = this._presetIdOf(options)
      engine = this.engineForPreset(presetId)
      trace('factory.resume', { presetId: presetId ?? null, engineId: engine?.id ?? null })
    } catch (error) {
      trace('factory.resume.error', { message: String(error?.message ?? error) })
      this.ctx.logger?.error?.(`dsh-multi-acp: preset resolution failed, falling back: ${String(error?.message ?? error)}`)
      return this.originalTarget.resume(ownerCtx, options)
    }
    // A10：resume 也一样 —— 分支之前先释放本工厂的旧 agent（切换 preset 的必经步骤）。
    // 不这么做的话，UI 的「切换到 XXX（含标准模式）」会一直报
    // `already owned by an active write handle` / `cannot prepare session while it is live`。
    await this._disposeStale(options?.resumeSessionId, 'resume')

    if (!engine) {
      trace('factory.resume.fallback-native', { presetId: presetId ?? null })
      return this.originalTarget.resume(ownerCtx, options)
    }

    const contract = await assertAgentContract()
    if (!contract.ok) throw contractError(contract.message)

    try {
      trace('factory.resume.spawning', { engineId: engine.id })
      const handle = await createAcpAgent({ rootCtx: this.ctx, ownerCtx, options, engine, pool: this.pool, stateDir: this.stateDir, mcpConfig: this.mcpConfig, projections: this.projections, permissionModeFromSession: this.permissionModeFromSession, resume: true })
      return this._trackLive(options?.resumeSessionId, handle, engine.id)
    } catch (error) {
      if (isExplicitAcpFailure(error)) throw error
      trace('factory.resume.error-fallback', { message: String(error?.message ?? error) })
      this._diagnoseHandleConflict(error, options?.resumeSessionId, 'resume')
      this.ctx.logger?.error?.(
        `dsh-multi-acp[${engine.id}]: agent resume failed, falling back to the official factory: ` +
          `${String(error?.message ?? error)}`,
      )
      return this.originalTarget.resume(ownerCtx, options)
    }
  }
}

/**
 * 区分"我们明知做不到"与"意外崩了"、单写冲突、契约错误、
 * 以及宿主契约探测 —— 全部在 `./agent-contract.js`（Q6 批次二抽出的第一个切片）。
 * 本模块只**消费**它们，见文件头的 import。
 */
