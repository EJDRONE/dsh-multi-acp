/**
 * Agent 工厂 + ACP 根 agent 实现。
 *
 * ════════════════════════════════════════════════════════════════════════
 * 契约来源：github.com/deepseek-ai/deepseek-harness 的 TS 源码（公开）
 * 完整契约速查：docs/evidence/P1-contract-reference.md
 * 全文签名均逐字摘自源码并附行号；**无推测**。
 * ════════════════════════════════════════════════════════════════════════
 *
 * 关键事实（均来自源码）：
 *
 * 1. `Agent` 基接口只有 `{ readonly id: SessionId }`
 *    （packages/core/agent/src/types.ts:14）。活的那些能力来自
 *    "运行时面孔" runtime-types.ts:163 的 module augmentation。
 *
 * 2. `enter()` 有三条硬不变量（agent/src/index.ts:459-477）：
 *      • agent.id === agent.session.id        ← 不等直接抛
 *      • 不能重复注册（这是权威的冲突边界）
 *      • register() 是复合 generator effect，teardown 顺序**承重**
 *
 * 3. `Inbox` 是「agent 暴露、driver 实现存储」的接口
 *    （runtime-types.ts:47 原文：concrete storage belongs to the driver）。
 *    我们就是 driver，所以由我们实现它，后端是 `agent/inbox/spliced` 事件。
 *
 * 4. `turnBoundary` projection 由 **agent-loop 插件**注册
 *    （agent-loop/src/index.ts:364-365），是对会话事件的**纯 fold**。
 *    我们替换的只是 factory 入口，agent-loop 仍加载 → projection 已就绪。
 *    **我们只需按正确顺序 append 那四个事件**，鎖门语义（preset select）自动成立。
 *
 * 5. ⚠️ **surfaceOp 是硬要求**（A6 的延伸，已在 0.2.0-rc.2 的 app.asar 逐字核实）：
 *    `user/message` / `assistant/message` / `tool/result` 属于 `SurfaceEventType`，
 *    `Session.append` → `surfaceOpOf()` 会抛
 *    "is surface-eligible and requires a surfaceOp marker"。
 *    必须传 `{ surfaceOp: 'append' }`（surface.ts:302-327）。
 *
 * 6. `TurnEndReason` 的确切 union（A5）：
 *    `completed | aborted(reason) | blocked | error(error) | max-tokens |
 *     interrupted | forked`（session/src/types.ts:201-232）。
 *    正常结束是 `{ kind: 'completed' }` —— **不存在 `{ kind: 'end-turn' }`**。
 *
 * A5/A6/A7 的完整结论与证据见 docs/evidence/A5-A7-contract-resolutions.md。
 *
 * @module dsh-multi-acp/acp-agent
 */
import { importFromDsh, unwrapService, dshHome } from './dsh-imports.js'
import { engineIdFromPreset, presetIdFor } from './preset-ids.js'
import { readSessionMap, writeSessionMap } from './session-map.js'
import { resolveMcpServers, summarizeMcpServers } from './mcp-servers.js'
import { recordAvailableCommands, recordMcpServers } from './engine-runtime.js'
import { readSessionPermissions, mapPresetToMode, applyPermissionMode } from './permission-bridge.js'
import { supportedPermissionModes } from './engines.js'
import { evaluateTimeout, DEFAULT_IDLE_TIMEOUT_MS } from './prompt-timeout.js'
import { trace } from './trace.js'

/**
 * A17②：流式落盘的节流参数（间隔 ≥ N ms 或新增 ≥ N 字符才写一条 assistant/message）。
 * 太频繁会把会话日志刷爆；太稀疏则界面既不像"在跑"也不够实时。
 */
const LIVE_FLUSH_INTERVAL_MS = 1200
const LIVE_FLUSH_MIN_CHARS = 400

/**
 * Agent 工厂。按会话选中的 preset 决定由谁创建 agent：
 *  - preset 属于本插件（`acp-<engineId>`）→ 外部 ACP CLI
 *  - 其他 → 原样委托官方 DSH factory（"跑原生 DSH"零成本）
 */
export class MultiAcpFactory {
  constructor({ ctx, originalTarget, engines, defaultEngine, pool, stateDir, mcpConfig, permissionModeFromSession = true }) {
    this.ctx = ctx
    this.originalTarget = originalTarget
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
 * 区分"我们明知做不到"与"意外崩了"。
 *
 * 前者应当明确报错（用户需要看到原因），后者应当降级兜底（保住普通会话）。
 * 用错误名前缀标记，避免依赖 message 文本匹配。
 */
function isExplicitAcpFailure(error) {
  return error?.name === 'MultiAcpContractError' || error?.name === 'MultiAcpUnavailableError'
}

/**
 * 单写所有权冲突（A10）：会话的写句柄还在别人手里。
 *
 * 官方 resume 走 `persistence.prepare()`，我们走 `persistence.open(id,'write')`，
 * 两者都会撞上这条；报错文本由 dsh-session-persistence 给出。
 */
function isWriteHandleConflict(error) {
  return /already owned by an active write handle/i.test(String(error?.message ?? error))
}

/** 契约不满足 —— 「我们明知自己没准备好」，必须让用户看到，不降级。 */
function contractError(message) {
  const error = new Error(message)
  error.name = 'MultiAcpContractError'
  return error
}

/**
 * 探测宿主契约。不抛异常——把"缺什么"交给调用方决定怎么呈现。
 */
let _contractCache = null
export async function assertAgentContract({ refresh = false } = {}) {
  if (_contractCache && !refresh) return _contractCache

  const required = [
    { pkg: '@deepseek-ai/dsh-agent', names: ['agentEvents'] },
    { pkg: '@deepseek-ai/dsh-session', names: ['SessionPreparation', 'interruptedTurnClosers'] },
    { pkg: '@deepseek-ai/dsh-scope', names: ['createScope'] },
    {
      pkg: '@deepseek-ai/dsh-llm',
      names: [
        'createAssistantMessage',
        'createUserMessage',
        'createToolResultMessage',
        'AssistantStreamAccumulator',
        'errorChain',
      ],
    },
  ]
  const report = []
  for (const { pkg, names } of required) {
    try {
      const mod = await importFromDsh(pkg)
      const missing = names.filter((n) => mod[n] === undefined)
      report.push({ pkg, missing, ok: missing.length === 0 })
    } catch (error) {
      report.push({ pkg, missing: names, ok: false, error: String(error?.message ?? error) })
    }
  }

  const bad = report.filter((r) => r.ok === false)
  _contractCache = bad.length
    ? {
        ok: false,
        report,
        message:
          'dsh-multi-acp: host contract not satisfied — cannot create an ACP root agent:\n' +
          bad.map((b) => `  • ${b.pkg}: missing [${b.missing.join(', ')}]${b.error ? ` — ${b.error}` : ''}`).join('\n'),
      }
    : { ok: true, report }
  return _contractCache
}

/* ═══════════════════════════════════════════════════════════════════════
 * Inbox —— 由我们（driver）实现存储，后端是 `agent/inbox/spliced` 事件
 * 契约：runtime-types.ts:47-100
 * ═══════════════════════════════════════════════════════════════════════ */

function createAcpInbox({ session, projections, logger, emit }) {
  const stateOf = () =>
    projections?.stateOf?.(session, 'inbox') ?? { 'next-turn': [], 'next-step': [] }

  const listOf = (target) => stateOf()[target] ?? []

  /**
   * 唯一的写入口：append 一个 `agent/inbox/spliced` 事件。
   *
   * A3 契约（agent-loop/src/inbox.ts:197-243）：
   *   - `discardRemoved=true`（clear / replace / remove / 公共 splice）⇒
   *     被移除的消息标记 `outcome: 'canceled'` 并发 `agent/inbox/discarded`。
   *   - `discardRemoved=false`（claim 认领）⇒ 只 splice，不记 outcome、不发 discarded。
   *   - 插入的消息一律发 `agent/inbox/inserted`。
   */
  const mutate = (target, start, deleteCount, inserted, discardRemoved) => {
    const current = listOf(target)
    const removed = current.slice(start, start + deleteCount)
    const outcome = discardRemoved && removed.length > 0 ? 'canceled' : undefined
    const event = session.append('agent/inbox/spliced', {
      target,
      start,
      ...(removed.length === 0 ? {} : { removedCount: removed.length }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    })
    if (discardRemoved) {
      for (const message of removed) emit?.('agent/inbox/discarded', { message })
    }
    for (const message of event.data.inserted) emit?.('agent/inbox/inserted', { message })
    return removed
  }

  return {
    get nextTurn() {
      return listOf('next-turn')
    },
    get nextStep() {
      return listOf('next-step')
    },
    clear() {
      // 契约要求：先清 next-step，再清 next-turn；清空即"丢弃"（outcome canceled）
      for (const target of ['next-step', 'next-turn']) {
        const items = listOf(target)
        if (items.length) mutate(target, 0, items.length, [], true)
      }
    },
    append(target, message) {
      mutate(target, listOf(target).length, 0, [message], false)
    },
    prepend(target, message) {
      mutate(target, 0, 0, [message], false)
    },
    replace(messageId, newMessage) {
      for (const target of ['next-step', 'next-turn']) {
        const items = listOf(target)
        // A6：UserMessage 的身份字段是 `id: MessageId`（不是 `messageId`）——
        // 见 llm/llm/src/message.ts:139-148（MessageBase）。
        const idx = items.findIndex((m) => m?.id === messageId)
        if (idx >= 0) {
          mutate(target, idx, 1, [newMessage], true)
          logger?.debug?.(`acp-inbox: replaced ${String(messageId)}`)
          return true
        }
      }
      return false
    },
    remove(messageId) {
      for (const target of ['next-step', 'next-turn']) {
        const items = listOf(target)
        const idx = items.findIndex((m) => m?.id === messageId)
        if (idx >= 0) {
          mutate(target, idx, 1, [], true)
          return true
        }
      }
      return false
    },
    /** 非丢弃式认领（driver 用）：不记 `outcome`、不发 `discarded`（照 agent-loop claim）。 */
    consume(target, count) {
      return mutate(target, 0, count, [], false)
    },
    splice(target, start, deleteCount, inserted) {
      return mutate(target, start, deleteCount, inserted, true)
    },
  }
}

/* ═══════════════════════════════════════════════════════════════════════
 * Agent 构造
 * ═══════════════════════════════════════════════════════════════════════ */

async function createAcpAgent({ rootCtx, ownerCtx, options, engine, pool, stateDir, mcpConfig, projections, permissionModeFromSession = true, resume = false }) {
  // A4：resume 的身份字段是 `resumeSessionId`（ResumeAgentOptions），**不是**
  // `sessionId`（CreateAgentOptions）。此前误读 options.sessionId → 恢复时拿到
  // undefined，等于偷偷新建了一个会话（而非恢复）。
  const sessionId = resume ? options.resumeSessionId : options.sessionId
  if (sessionId === undefined || sessionId === null || sessionId === '') {
    throw new Error('dsh-multi-acp: needs options.sessionId (create) or options.resumeSessionId (resume)')
  }
  const dir = stateDir ?? `${dshHome()}/multi-acp`

  // ── B1：MCP servers 随会话注入（ACP-INTEGRATION §4.1 的缺口）──────────
  // 来源：DSH 自己的 MCP 存储（<DSH_HOME>/storages/mcp_connector.json），
  // 可被插件配置 `mcp.include/exclude` 与引擎配置 `engine.mcp` 收窄/替换。
  // 映射细节与安全边界见 lib/mcp-servers.js。
  const { servers: mcpServers, notes: mcpNotes } = resolveMcpServers({
    dshHomeDir: dshHome(),
    engineMcp: engine.mcp,
    pluginMcp: mcpConfig,
  })
  for (const note of mcpNotes) trace('session.mcp.note', { engineId: engine.id, note })
  recordMcpServers(engine.id, { count: mcpServers.length, summary: summarizeMcpServers(mcpServers) })
  trace('session.mcp', {
    engineId: engine.id,
    sessionId: String(sessionId),
    count: mcpServers.length,
    summary: summarizeMcpServers(mcpServers),
  })

  const { SessionPreparation, interruptedTurnClosers } = await importFromDsh('@deepseek-ai/dsh-session')
  const { agentEvents } = await importFromDsh('@deepseek-ai/dsh-agent')
  const {
    createAssistantMessage,
    createUserMessage,
    createToolResultMessage,
    AssistantStreamAccumulator,
    errorChain,
  } = await importFromDsh('@deepseek-ai/dsh-llm')
  const { createScope } = await importFromDsh('@deepseek-ai/dsh-scope')

  // ⚠️ **必须**用 `ctx.get('sessionProjections')`，不能写 `rootCtx.sessionProjections`。
  //
  // 2026-10-09 实测（会话 session-c2601ea1，preset=acp-omp，重启后的第一枪）：
  //   pc.log: install.factory-installed → preset.register(acp-omp, 9 行原生工具)
  //           factory.createAgent {presetId:'acp-omp', engineId:'omp'}
  //           factory.createAgent.spawning {engineId:'omp', command:'omp'}
  //           session.mcp {count:4, summary:'MCP：4 个 — weknora/chrome-devtools/drawio/dingtalk'}
  //           factory.createAgent.error-fallback {"message":"cannot get property
  //           \"sessionProjections\" without inject"}   ← 就是这一行抛的
  // 于是引擎都 spawn 了，仍回落原生 loop（用户看到"没跑 opencode/omp"）。
  //
  // 为什么不加到插件行的 inject 列表：`dsh-session-projection` 的类型注释明确写了
  //   "Domain plugins register under `ctx.inject(['sessionProjections'], …)` so
  //    **headless assemblies without the registry stay unaffected**" ——
  //   它是**可选**服务；硬 inject 会让插件在无投影装配下整个加载失败。
  // 用 `ctx.get()`（非抛错访问器，同 readApproval/readPersistence 的写法），
  // 并在 `createAcpInbox` 里对 undefined 兜底（`projections?.stateOf?.(…)`）。
  // 2026-10-10：这里原有的 `projections` 声明已抽到工厂（`this.projections`），
  // 由调用方注入，避免重复声明（node --check 会直接报 "already been declared"）。
  const permissionsEnabled = permissionModeFromSession !== false

  // ── 1) 会话准备（未发布）+ A8 持久化句柄 ──────────────────────
  // 契约（agent-loop/src/index.ts:652-706, 807-890）：
  //   create：sessions.prepare → persistence.create(session.header) → handle
  //   resume：persistence.open(id,'write') → handle.read(0) 取回事件 →
  //           interruptedTurnClosers() 补崩溃孤儿 turn → sessions.prepare({seed})
  //   之后 announce 时，持久化后端**按 sessionId 自动把 live 事件路由进该 handle**
  //   （agent 侧无需逐条 append；只需最后 close）。
  const persistence = readPersistence(rootCtx)
  /** @type {{ handle: any, storedCount: number } | undefined} */
  let stored
  let preparation
  if (resume) {
    if (persistence === undefined) {
      rootCtx.logger?.warn?.('dsh-multi-acp: resume without a sessionPersistence backend — history will not be restored')
      preparation = SessionPreparation.create(
        rootCtx.sessions.prepare(sessionId, {
          ...(options.seed === undefined ? {} : { seed: options.seed }),
        }),
      )
    } else {
      const handle = await persistence.open(sessionId, 'write')
      try {
        const coldRead = await handle.read(0)
        const persisted = [...coldRead.events]
        // 崩溃孤儿的收尾 turn（缺 tool error / step/end / turn/end）由 agent 层补齐。
        const closers = interruptedTurnClosers(persisted)
        if (closers.length > 0) await handle.append(closers)
        preparation = SessionPreparation.create(
          rootCtx.sessions.prepare(sessionId, {
            seed: [...persisted, ...closers],
            meta: structuredClone(handle.header),
            inheritedEventCount: handle.inheritedEventCount,
            eventState: coldRead.eventState,
          }),
        )
        stored = { handle, storedCount: persisted.length + closers.length }
      } catch (error) {
        await handle.close().catch(() => {})
        throw error
      }
    }
  } else {
    preparation = SessionPreparation.create(
      rootCtx.sessions.prepare(sessionId, {
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.meta === undefined ? {} : { meta: options.meta }),
      }),
    )
    if (persistence !== undefined) {
      const handle = await persistence.create(preparation.session.header, {
        inheritedEventCount: preparation.session.inheritedEventCount,
      })
      stored = { handle, storedCount: 0 }
    }
  }
  const session = preparation.session
  const cwd = session.header.cwd ?? options.meta?.cwd ?? ownerCtx?.cwd ?? process.cwd()

  // ── 2) 开 ACP 侧会话 ─────────────────────────────────────────
  // 2026-10-10：把**会话权限档**映射成引擎的 `permissionMode`（完全权限 ⇒ 引擎免问）。
  // 这一步必须在 `pool.get()` 之前 —— 变体引擎带 `poolKey`，宿主要按"档位"分别池化。
  const sessionPermissions = readSessionPermissions(projections, session)
  const permission = mapPresetToMode({
    permissions: sessionPermissions,
    engine,
    enabled: permissionModeFromSession,
    supported: supportedPermissionModes,
  })
  const sessionEngine = applyPermissionMode(engine, permission.mode)
  trace('session.permission', {
    engineId: engine.id,
    sessionId: String(sessionId),
    preset: sessionPermissions?.preset ?? null,
    sandbox: sessionPermissions?.sandbox ?? null,
    approval: sessionPermissions?.approval ?? null,
    mapped: permission.mode,
    reason: permission.reason,
    poolKey: sessionEngine.poolKey ?? engine.id,
  })
  if (permission.warn) rootCtx.logger?.warn?.(`dsh-multi-acp[${engine.id}]: ${permission.warn}`)
  if (permission.mode) {
    rootCtx.logger?.info?.(
      `dsh-multi-acp[${engine.id}]: 会话档位 ${sessionPermissions?.preset} → 引擎以 permissionMode=${permission.mode} 启动`,
    )
  }
  const host = pool.get(sessionEngine)
  let acp
  const mappedAcpSessionId = resume ? readSessionMap(dir)[String(sessionId)]?.acpSessionId : undefined
  try {
    if (resume && typeof mappedAcpSessionId === 'string' && mappedAcpSessionId.length > 0) {
      try {
        acp = await host.resumeSession({ acpSessionId: mappedAcpSessionId, dshSessionId: sessionId, cwd, mcpServers })
      } catch (error) {
        // ACP `session/load` 失败（引擎侧会话已不存在/被清理）→ 退回**新建 ACP 会话**，
        // 而不是让工厂降级到官方 loop（那会静默换掉引擎）。
        rootCtx.logger?.warn?.(
          `dsh-multi-acp: ACP session/load failed (${String(mappedAcpSessionId)}) — opening a fresh ACP session: ` +
            `${String(error?.message ?? error)}`,
        )
        acp = await host.openSession({ dshSessionId: sessionId, cwd, mcpServers })
      }
    } else {
      if (resume) {
        rootCtx.logger?.warn?.(
          `dsh-multi-acp: no ACP session mapping for ${String(sessionId)} — opening a fresh ACP session ` +
            '(the external engine context will not be restored)',
        )
      }
      acp = await host.openSession({ dshSessionId: sessionId, cwd, mcpServers })
    }
  } catch (error) {
    await stored?.handle.close().catch(() => {})
    preparation[Symbol.dispose]?.()
    throw error
  }
  // A4：记录 dshSessionId → acpSessionId，供重启后 resume。
  writeSessionMap(dir, sessionId, { engineId: engine.id, acpSessionId: acp.acpSessionId, cwd })

  // ISSUE-01：应用引擎预置的 per-session 配置（如 OpenCode 切到免费模型）。
  // 非致命：失败只记警告，会话继续（用户可自行 `set_config_option` 或改 engines.json）。
  const initialConfigs = Array.isArray(engine.initialConfigOptions) ? engine.initialConfigOptions : []
  for (const opt of initialConfigs) {
    try {
      await acp.client?.setConfigOption?.({ sessionId: acp.acpSessionId, configId: opt.configId, value: opt.value })
      rootCtx.logger?.info?.(`dsh-multi-acp[${engine.id}]: initial config ${opt.configId}=${opt.value}`)
    } catch (error) {
      rootCtx.logger?.warn?.(
        `dsh-multi-acp[${engine.id}]: initial config ${opt.configId}=${opt.value} failed: ${String(error?.message ?? error)}`,
      )
    }
  }

  rootCtx.logger?.info?.(
    `dsh-multi-acp[${engine.id}]: dshSession=${sessionId} acpSession=${acp.acpSessionId} cwd=${cwd}`,
  )

  // ── 3) 组装 Agent + 作用域 ───────────────────────────────────
  // A7：`agentPresets.mount(ctx, id)` 要求 **scoped** ctx，否则 bind() 抛
  //   "Agent preset binding requires a scoped context"（registry/index.ts:252）。
  //   agent-loop 的做法是 `createScope(loopCtx, agent)` 得到 `agent.ctx`
  //   （agent-loop/src/agent.ts:130-131），这里照做；`agent` 自身作 scope key。
  const inboxEmit = { fn: () => {} }
  const inbox = createAcpInbox({
    session,
    projections,
    logger: rootCtx.logger,
    emit: (name, payload) => inboxEmit.fn(name, payload),
  })
  let agentCtx
  /** @type {import('@deepseek-ai/dsh-agent/types').Agent} */
  const agent = {
    id: sessionId, // ⚠️ 必须等于 session.id（enter() 硬检查）
    session,
    inbox,
    options: options.agentOptions ?? { provider: `acp:${engine.id}`, model: engine.id },
    status: 'idle',
    get ctx() {
      return agentCtx
    },
    cancel(cause, cancelOptions) {
      runner.cancel(cause, cancelOptions)
      setStatus('idle')
    },
    whenIdle() {
      return runner.whenIdle()
    },
    async runMaintenance(task) {
      return task(new AbortController().signal)
    },
    send(message, target, wakeup) {
      inbox.append(target, message)
      if (wakeup) runner.wake()
    },
    followup(message) {
      inbox.append('next-turn', message)
      runner.wake()
    },
    steer(message) {
      inbox.prepend('next-step', message)
    },
    inject(message) {
      inbox.prepend('next-step', message)
    },
  }
  const scope = createScope(rootCtx, agent)
  agentCtx = scope.ctx
  // dispatch 的 base ctx 用 rootCtx（照 agent-loop agent.ts:129：agentEvents(loopCtx, this)）
  const dispatch = agentEvents(rootCtx, agent)
  // A3：inbox 的 discarded/inserted 通知需要 dispatch；dispatch 依赖 agent，
  //     故用 late-bound 赋值把两者接起来。
  inboxEmit.fn = (name, payload) => dispatch.emit(name, payload)

  // A2：DSH 的权限服务（可选）。用 ctx.get 取——避免对未声明 inject 的
  // service 属性访问触发 Cordis 代理报错；缺失时权限请求 fail closed。
  const approval = readApproval(rootCtx)

  const runner = new AcpTurnRunner({
    engine,
    host,
    acpSessionId: acp.acpSessionId,
    cwd,
    session,
    inbox,
    agent,
    approval,
    // A13：初始化 turn 计数器要用它（会话可能已经有过 turn，见 _lastTurnFromSession）
    projections,
    emit: (name, payload) => dispatch.emit(name, payload),
    makeMessages: {
      createAssistantMessage,
      createUserMessage,
      createToolResultMessage,
      AssistantStreamAccumulator,
      errorChain,
    },
    logger: rootCtx.logger,
  })
  // 进程按引擎共享 → 必须把本会话的更新处理器按 acpSessionId 注册到 host
  host.setSessionHandler(acp.acpSessionId, runner)

  function setStatus(next) {
    if (agent.status === next) return
    agent.status = next
    dispatch.emit('agent/status', { status: next })
  }
  runner.onStatus = setStatus

  // ── 4) 运行宿主 setup（官方组装点）────────────────────────────
  // 契约（core/agent/src/index.ts:100-118 / AgentSetup:51-54）：factory 必须在
  // **发布前**用 scoped `agent.ctx` 调用 setup，并调用其可选同步 commit()。
  // 官方 ACP 桥就在这里装模型控制 / MCP；preset 也常在这里 mount。
  try {
    if (typeof options.setup === 'function') {
      const commit = await options.setup(agentCtx, agent)
      if (commit && typeof commit.commit === 'function') commit.commit()
    }
  } catch (error) {
    await stored?.handle.close().catch(() => {})
    await scope.dispose().catch(() => {})
    host.releaseSession(acp.acpSessionId)
    preparation[Symbol.dispose]?.()
    throw error
  }

  // ── 4b) 后备：宿主没挂 preset 时，由本插件自挂引擎 preset ──────
  const presetId = presetIdFor(engine.id)
  if (readComposedPreset(rootCtx, agentCtx) === undefined) {
    try {
      if (typeof rootCtx.agentPresets?.mount === 'function') {
        await rootCtx.agentPresets.mount(agentCtx, presetId)
      } else {
        rootCtx.logger?.warn?.(
          'dsh-multi-acp: ctx.agentPresets.mount() unavailable — preset not mounted; ' +
            'agent-local contributions will be missing.',
        )
      }
    } catch (error) {
      rootCtx.logger?.error?.(`dsh-multi-acp: preset mount failed (${presetId}): ${String(error?.message ?? error)}`)
    }
  }

  // ── 5) 发布 ─────────────────────────────────────────────────
  // 顺序：sessions.enter → sessions.announce → agents.register
  // ⚠️ register() 是复合 generator effect，teardown 顺序承重（见文件头 #2）。
  //    这里用与 agent-loop setupAndPublish 相同的顺序。
  const teardowns = []
  try {
    // A8：发布前把"未存后缀"（seed 标记 / setup 窗口事件）推进 handle ——
    //   `sessions.announce()` 之后，live 事件才由持久化后端按 sessionId 自动路由。
    await appendUnstoredSuffix(stored, session)
    teardowns.push(rootCtx.sessions.enter(session))
    rootCtx.sessions.announce(session)
    teardowns.push(rootCtx.agents.register(agent))
  } catch (error) {
    for (const t of teardowns.reverse()) {
      try {
        t()
      } catch {
        /* ignore */
      }
    }
    agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    await stored?.handle.close().catch(() => {})
    await scope.dispose().catch(() => {})
    host.releaseSession(acp.acpSessionId)
    throw error
  }

  const dispose = async () => {
    // 顺序承重：先停 driver（排空最后一个 turn），再拆发布链，再解作用域，最后回收。
    // 反了会在最后一个 turn 还在排空时就反注册 agent（见文件头 #2）。
    await runner.stop()
    host.clearSessionHandler(acp.acpSessionId)
    for (const t of teardowns.reverse()) {
      try {
        t()
      } catch (error) {
        rootCtx.logger?.debug?.(`dsh-multi-acp: teardown failed: ${String(error?.message ?? error)}`)
      }
    }
    await scope.dispose().catch(() => {})
    // A8：关闭写句柄（close 会 drain 未落盘事件，并释放单写所有权）
    await stored?.handle.close().catch((error) => {
      rootCtx.logger?.warn?.(`dsh-multi-acp: session handle close failed: ${String(error?.message ?? error)}`)
    })
    host.releaseSession(acp.acpSessionId)
  }

  // 空闲时记一次状态变更，并启动 driver
  runner.start()

  return { agent, dispose }
}

/* ═══════════════════════════════════════════════════════════════════════
 * Turn runner —— 把 inbox 里的工作转成 ACP prompt，并把 ACP 事件桥回会话
 * ═══════════════════════════════════════════════════════════════════════ */

export class AcpTurnRunner {
  constructor({ engine, host, acpSessionId, cwd, session, inbox, agent, approval, projections, emit, makeMessages, logger }) {
    this.engine = engine
    this.host = host
    this.acpSessionId = acpSessionId
    this.cwd = cwd
    this.session = session
    this.inbox = inbox
    /** 本会话的 Agent（A2：approval.request 需要 agent） */
    this.agent = agent
    /** DSH `ctx.approval` 服务，或 undefined（无权限通道时 fail closed） */
    this.approval = approval
    /**
     * A13：会话投影注册表（可选）。用来读 `turnBoundary.lastTurn`，
     * 保证 resume 之后 turn 编号**接续**而不是从 1 重来（否则会话被判 corrupt：
     * `turn/start does not open the expected turn`，见 _lastTurnFromSession）。
     */
    this.projections = projections
    this.emit = emit
    this.mm = makeMessages
    this.logger = logger

    this._running = false
    this._stopped = false
    this._wake = null
    this._idle = null
    this._abort = null
    /** 当前 turn 的取消原因（A5：用于 turn/end 的 `aborted.reason`）。 */
    this._cancelCause = null
    this._turn = 0
    /**
     * A13：turn 计数**必须**接续会话里已有的最大 turn，而不是从 0 重新数。
     *
     * 实测（`session-fb54ccef`，2026-10-09 17:2x）：会话在 16:2x 跑过 turn 1 之后被 resume，
     * 新 agent 的 `_turn` 从 0 起 → 又写了一个 `turn/start {turn:1}` ⇒ 日志里出现两个 turn 1，
     * 加载时报 `SessionFormatError: turn/start does not open the expected turn`
     * （v3→v4 校验器 fmt-v3v4.js:746-747：`turn/start` 时 nextTurn 必须等于 data.turn）。
     */
    this._turn = this._lastTurnFromSession()
    /** 当前 attempt 的流式帧累积 */
    this._frames = []
    this._assistantChunks = []
    /**
     * C1：引擎上报的可用命令 / skill 清单（最近一次 `available_commands_update`）。
     * 只做观测与回显，不参与 DSH 的工具/技能目录（引擎的 skill 是引擎自己的）。
     */
    this._availableCommands = []
    /**
     * 引擎最近一次 `session/update` 的摘要（prompt 超时诊断用，2026-10-09）。
     * `{ at, kind, summary }`；turn 开始时清空。
     */
    this._lastUpdate = null
    /**
     * A1：tool 桥接状态。
     *   `_toolCalls`  —— 按 toolCallId 记录（是否已落 tool/call、是否已落 tool/result）
     *   `_toolEvents` —— 本 turn 缓冲的待落盘事件（保证 assistant/message 在前、tool 在后）
     *   `_bridging`   —— 仅在 prompt 期间为 true；turn 外的迟到 update 一律不桥接
     */
    this._toolCalls = new Map()
    this._toolEvents = []
    /** A14：本 turn 已经"广告"过的 callId（避免重复广告；跨 turn 重置）。 */
    this._advertised = new Set()
    this._bridging = false
    this._activeStep = 1
    this.onStatus = () => {}
  }

  start() {
    void this._loop()
  }

  wake() {
    this._wake?.()
  }

  async whenIdle() {
    if (!this._running) return
    await new Promise((resolve) => {
      this._idle = resolve
    })
  }

  /**
   * @param cause  取消原因（透传给 `agent/canceled` 语义）
   * @param options.keepInbox  契约（runtime-types.ts:41-44）原文：
   *   "active turn is still aborted, but un-started and pending work survives for a
   *    later turn and no canceled inbox splice is logged."
   */
  cancel(cause, options = {}) {
    const resolved = cause ?? { kind: 'user' }
    this._cancelCause = resolved
    this.logger?.info?.(`acp[${this.engine.id}]: cancel (${JSON.stringify(resolved)})`)
    this._abort?.abort()
    void this.host.client?.cancel({ sessionId: this.acpSessionId }).catch((error) => {
      this.logger?.warn?.(`acp[${this.engine.id}]: session/cancel failed: ${String(error?.message ?? error)}`)
    })
    if (!options.keepInbox) this.inbox?.clear()
    this.onStatus('idle')
  }

  async stop() {
    this._stopped = true
    // dispose 触发的停止：turn/end 记为 aborted/disposed（A5）。
    this._cancelCause = this._cancelCause ?? { kind: 'disposed' }
    this._abort?.abort()
    try {
      await this.host.client?.cancel({ sessionId: this.acpSessionId })
    } catch {
      /* ignore */
    }
    this.wake()
    await this.whenIdle()
  }

  /**
   * Driver 主循环。
   *
   * 事件顺序（严格照 SessionEventMap 语义，见 P1-contract-reference.md §2）：
   *   turn/start → user/message → step/start → [prompt] → assistant/message → step/end → turn/end
   *
   * ⚠️ `turn/start` 一旦 append，`turnBoundary` projection 的 `lastTurn` 就 > 0，
   *    于是 `agentPresets.select()` 会拒绝后续换引擎 —— 这正是 D5 想要的锁门。
   */
  async _loop() {
    while (!this._stopped) {
      const pending = this.inbox?.nextTurn ?? []
      if (pending.length === 0) {
        this._running = false
        this.onStatus('idle')
        this._idle?.()
        this._idle = null
        await this._sleepUntilWoken()
        continue
      }
      this._running = true
      this.onStatus('running')
      try {
        await this._runTurn(pending)
      } catch (error) {
        this.logger?.error?.(`acp[${this.engine.id}]: turn failed: ${String(error?.message ?? error)}`)
      }
    }
    this._running = false
    this._idle?.()
    this._idle = null
  }

  _sleepUntilWoken() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._wake = null
        resolve()
      }, 60_000)
      timer.unref?.()
      this._wake = () => {
        clearTimeout(timer)
        this._wake = null
        resolve()
      }
    })
  }

  /**
   * 从 inbox 认领工作。
   *
   * 持久化侧：splice 掉已认领的条目（→ `agent/inbox/spliced` 事件）
   * 实时侧：发 `agent/inbox/claimed` 事件给宿主
   * （两者分工见 docs/evidence/P1-contract-reference.md §2.1）
   */
  _claim(items) {
    if (!this.inbox || items.length === 0) return
    // A3：认领是"非丢弃式"移除（不记 outcome、不发 discarded），照 agent-loop claim。
    this.inbox.consume('next-turn', items.length)
    // 逐条派发（照 agent-loop/src/inbox.ts:112）；`agent` 由 dispatch 注入。
    for (const message of items) {
      this.emit('agent/inbox/claimed', { message, turn: this._turn })
    }
  }

  /**
   * 一个 turn。
   *
   * 事件顺序严格照 SessionEventMap 语义（P1-contract-reference.md §2.1）：
   *   turn/start → user/message* → step/start → [ACP prompt] → assistant/message → step/end → turn/end
   *
   * ⚠️ `turn/start` 一旦 append，`turnBoundary` projection 的 `lastTurn` 就 > 0，
   *    于是 `agentPresets.select()` 会拒绝后续换引擎 —— 这正是 D5 想要的锁门。
   */
  async _runTurn(pending) {
    this._turn += 1
    const turn = this._turn
    // 本 driver 每个 turn 恰好一个 step（一次 ACP prompt = 一次模型调用）。
    // ⚠️ step 必须**按 turn 重置**：契约要求 step 在 turn 内从 1 起
    //    （`turn/start` 会把 nextStep 置为 1）；早先跨 turn 单调递增会与之冲突。
    const step = 1

    this._claim(pending)
    this._cancelCause = null
    // A1：每 turn 重置 tool 桥接状态；仅在 prompt 期间允许桥接。
    this._toolCalls = new Map()
    this._toolEvents = []
    /** A14：本 turn 已经"广告"过的 callId（避免重复广告；跨 turn 重置）。 */
    this._advertised = new Set()
    // A17②：流式落盘状态（每 turn 重置）
    this._streamedTextLen = 0
    this._lastLiveFlushAt = 0
    this._liveFlushes = 0
    // 超时诊断：只关心本 turn 的引擎活动
    this._lastUpdate = null
    this._bridging = true
    this._activeStep = step
    this.session.append('turn/start', { turn })
    // A5：初始按"正常结束"记；异常路径在下面改写为 aborted / error。
    // TurnEndReason 见 session/src/types.ts:201-232。
    let reason = { kind: 'completed' }
    try {
      for (const message of pending) {
        // A6：`user/message` 属于 SurfaceEventType → 必须带 surfaceOp，否则
        // Session.append 抛 "requires a surfaceOp marker"（surface.ts:302-327）。
        this.session.append('user/message', message, { surfaceOp: 'append' })
      }
      this.session.append('step/start', { turn, step })

      // 把本轮的用户文本拼成 ACP prompt
      const prompt = pending
        .map((m) => extractText(m))
        .filter(Boolean)
        .map((text) => ({ type: 'text', text }))

      this._frames = []
      const abort = new AbortController()
      this._abort = abort
      try {
        await this._promptOnce({ turn, step, prompt })
      } catch (error) {
        // signal 已 abort ⇒ 取消；否则是失败。必须在 `_abort` 被清空前读取。
        reason = abort.signal.aborted
          ? { kind: 'aborted', reason: this._cancelCause ?? { kind: 'user' } }
          : { kind: 'error', error: this._errorFailure(error) }
        throw error
      } finally {
        // A1：先落 buffer 里的 tool/call·tool/result（顺序：assistant/message 已在
        // `_promptOnce` 内落盘 → tool 事件 → step/end），再关 step。
        this._flushToolEvents()
        // A12：**step/end 之前必须把悬空的 tool/call 收尾**，否则会话格式非法：
        //   `step/end leaves unresolved tool call <id>`（v3→v4 校验器 fmt-v3v4.js:577）。
        // 典型触发：引擎跑到一半 prompt 超时/被取消/引擎崩，某个 tool_call 只有 call 没有 result。
        this._resolvePendingToolCalls(reason)
        this.session.append('step/end', { turn, step })
        if (this._abort === abort) this._abort = null
        this._cancelCause = null
      }
    } catch (error) {
      // step 之前的失败（如 user/message append 抛错）也必须有确切 reason。
      if (reason.kind === 'completed') {
        reason = { kind: 'error', error: this._errorFailure(error) }
      }
      throw error
    } finally {
      // turn/end 必须闭合 —— 即使上面已经抛。
      this._flushToolEvents()
      this.session.append('turn/end', { turn, reason })
      this._bridging = false
    }
  }

  /** 把任意错误拍平成 `LlmFailure.message`（`errorChain` 优先，见 agent-loop agent.ts:377-379）。 */
  _errorText(error) {
    try {
      const chained = this.mm.errorChain?.(error)
      if (typeof chained === 'string' && chained.length > 0) return chained
    } catch {
      /* 退化到 message */
    }
    return String(error?.message ?? error)
  }

  /**
   * 把失败归一成 `LlmFailure`（`message` + **稳定机器码**）。
   * ISSUE-01：把"余额不足 / 未授权 / 限流"从"协议不通"里分流出来，
   * 否则用户只看到计费口径的英文，容易误判成 ACP 协议问题。
   */
  _errorFailure(error) {
    const message = this._errorText(error)
    return { message, code: classifyAcpError(message) }
  }

  /**
   * 记录"引擎最近一次 session/update"（只留摘要，别存大 payload）。
   *
   * 用途：`prompt` 超时时给出可判断的现场 —— 「卡在哪个工具 / 还在吐字 / 完全没声音」。
   */
  _rememberUpdate(update) {
    const kind = String(update.sessionUpdate ?? 'unknown')
    let summary = kind
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const name = resolveAcpToolName(update) ?? update.kind ?? 'tool'
      summary = `${kind} ${name}${update.status ? ` (${update.status})` : ''}${update.title ? ` — ${String(update.title).slice(0, 80)}` : ''}`
    } else if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      summary = `${kind} "${String(update.content?.text ?? '').slice(0, 80)}"`
    } else if (kind === 'available_commands_update') {
      summary = `${kind} (${Array.isArray(update.availableCommands) ? update.availableCommands.length : 0} 个命令)`
    }
    this._lastUpdate = { at: Date.now(), kind, summary }
  }

  /** 超时诊断用的一句话："最近一次 update 是 X（N 秒前）"。 */
  _lastUpdateSummary() {
    const last = this._lastUpdate
    if (!last) return ''
    const ageSec = Math.round((Date.now() - last.at) / 1000)
    return `last engine update ${ageSec}s ago: ${last.summary}`
  }

  /**
   * 一次 ACP round trip，并把返回的流累积成 `assistant/message`。
   *
   * 映射（P1-contract-reference.md §2.2）：
   *   ACP assistant/thought chunk → **瞬态**流帧（不进 log，见 runtime-types.ts:127）
   *   ACP tool call / result      → tool/call · tool/result（持久化）
   *   本轮结束                    → assistant/message（组装后的消息 + stream + usage）
   */
  async _promptOnce({ turn, step, prompt }) {
    /**
     * A16：**空闲闸**（progress-aware timeout）。
     *
     * 只看"总时长"会误杀正在干活的长任务（实测 `session-503ea973`：omp 已成功完成 21 次工具调用、
     * 仍在吐 `agent_thought_chunk`，却在 300s 处被掐断，错误里那句
     * "last engine update 0s ago" 就是证据）。现在改成：
     *   · 空闲闸 `engine.idleTimeoutMs`（默认 180s）—— 多久没有 `session/update` 才算卡死；
     *   · 总时长闸仍由 `AcpClient`（`engine.promptTimeoutMs`，默认 0 = 不限）负责。
     * 任一触发都带上"最后一次引擎 update"的摘要。
     */
    const idleMs = typeof this.engine.idleTimeoutMs === 'number' && Number.isFinite(this.engine.idleTimeoutMs)
      ? this.engine.idleTimeoutMs
      : DEFAULT_IDLE_TIMEOUT_MS
    const startedAt = Date.now()
    let watchdog = null
    let watchdogTimer = null
    if (idleMs > 0) {
      watchdog = new Promise((_, reject) => {
        watchdogTimer = setInterval(() => {
          const verdict = evaluateTimeout({
            startedAt,
            lastActivityAt: this._lastUpdate?.at ?? startedAt,
            overallMs: 0, // 总时长闸在客户端侧
            idleMs,
          })
          if (verdict) reject(new Error(`idle timeout: ${verdict.message}`))
        }, Math.max(1000, Math.min(5000, Math.floor(idleMs / 10))))
        watchdogTimer.unref?.()
      })
    }

    let result
    try {
      const promptPromise = this.host.client.prompt({ sessionId: this.acpSessionId, prompt })
      result = watchdog ? await Promise.race([promptPromise, watchdog]) : await promptPromise
    } catch (error) {
      // ── 超时诊断（2026-10-09；2026-10-10 扩到空闲闸）────────────────────
      // 以前只看到 `acp[omp]: session/prompt: timed out after 300s`，完全不知道引擎
      // 最后停在哪。现在把"最后一次 session/update"一起带出来（谁、什么状态、多久之前），
      // 常见形态一眼可辨：
      //   · lastUpdate = tool_call in_progress → 引擎卡在某个工具上（或工具在等授权）
      //   · lastUpdate = agent_message_chunk   → 还在吐文字（模型慢/输出长）
      //   · 很久没有任何 update               → 引擎进程僵死/网络断
      const message = String(error?.message ?? error)
      if (/timed out after|idle timeout/i.test(message)) {
        const detail = this._lastUpdateSummary()
        const enriched = `${message}${detail ? ` (${detail})` : ' (no session/update from the engine at all)'}`
        trace('acp.prompt.timeout', {
          engineId: this.engine.id,
          sessionId: String(this.acpSessionId),
          lastUpdate: this._lastUpdate
            ? { kind: this._lastUpdate.kind, ageMs: Date.now() - this._lastUpdate.at, summary: this._lastUpdate.summary }
            : null,
          frames: this._frames.length,
        })
        this.logger?.error?.(`acp[${this.engine.id}]: ${enriched}`)
        const wrapped = new Error(enriched)
        wrapped.name = error?.name ?? 'Error'
        throw wrapped
      }
      throw error
    } finally {
      if (watchdogTimer) clearInterval(watchdogTimer)
    }

    const assistantFrames = this._frames.filter((f) => f.kind === 'assistant')
    const text = assistantFrames.map((f) => f.text).join('')

    /**
     * ⚠️ **工具调用必须先被"广告"（2026-10-09 修，历史加载失败的根因）**
     *
     * DSH 的会话格式校验器
     * （`dsh-session-format-v3-to-v4/lib/index.js:618-650`，最新版 DSH 在加载历史时跑）
     * 要求每个 `tool/call` 的 callId **必须**先出现在某条 `assistant/message` 的
     * `content[].type === 'tool-call'` 块里，且 `name` / `arguments` **逐字节相等**：
     *
     *   ```js
     *   const pending = this.tools.get(id)            // 由 assistant/message 的 tool-call 块填充
     *   if (pending === void 0) throw `tool/call ${id} has no advertised tool lifecycle`
     *   if (pending.name !== data.name || pending.arguments !== data.arguments)
     *       throw `tool/call ${id} does not match one advertised tool call`
     *   ```
     *
     * 我们早期只写 `tool/call` + `tool/result`（即 A1 的"回显"），没有广告块 ⇒
     * 会话文件被判 corrupt，**历史加载失败**：
     *   `stored session "…" is corrupt: … tool/call call_00_… has no advertised tool lifecycle`
     *
     * 因此：把本 turn 缓冲的 `tool/call` 事件原样（同一个 `arguments` 字符串、同一个 `name`）
     * 作为 `tool-call` 内容块塞进 assistant 消息里。这条消息**先于** `_flushToolEvents()` 落盘，
     * 顺序天然满足"广告在前、调用在后"。
     * 也从"只在有文本时才写 assistant/message"改成"有工具调用也必须写"。
     */
    const toolCallBlocks = this._toolEvents
      .filter((event) => event.type === 'tool/call')
      .map((event) => ({
        type: 'tool-call',
        id: event.callId,
        name: event.name,
        arguments: event.arguments,
      }))
    void toolCallBlocks // 广告块现在由 A14 的 `_ensureToolAdvertisements()` 负责（增量 flush 时就会落盘）

    // A17②：文本已经在流式过程中增量写了（`_maybeFlushAssistantDelta`），这里只补**最后一段**；
    // 不要再整段重写（否则 UI 会出现重复文本）。
    this._maybeFlushAssistantDelta(true)
    // 收尾：把仍未被广告的工具调用补一块广告（正常路径下 A14 已在每次 flush 时补过）
    this._ensureToolAdvertisements(this._toolEvents)
    return result
  }

  /**
   * A17②：把**新增**的助手文本 append 成一条 `assistant/message`（节流）。
   *
   * 为什么要它（实测 `session-503ea973`）：omp 连续跑了 4 分钟、21 次工具调用，
   * 但我们的桥把一切都缓冲到 turn 末尾才落盘 —— 那 4 分钟里 DSH 界面**完全没有反馈**
   * （该会话日志里 21 个 tool/call 的时间戳全是 `+300s`）。引擎其实一直在发
   * `agent_thought_chunk` / `agent_message_chunk`，是我们在这一层攒住了。
   *
   * 实现要点：
   *   · **只写增量**（`_streamedTextLen` 记已写长度），绝不重复文本；
   *   · 节流：间隔 ≥{@link LIVE_FLUSH_INTERVAL_MS} 或累计 ≥{@link LIVE_FLUSH_MIN_CHARS} 才写一次；
   *   · 用 **append**（不碰 surface 引用）—— 长回合呈现为若干段连续消息；
   *     "同一条消息原地增长"（`surfaceOp:{op:'replace',start,end}` + `sourceEventSeqs`）需要
   *     `session.append()` 回传 seq，且类型里的 `start/end`（types.d.ts:393）与实测日志里的
   *     `startSeq/endSeq` 存在命名差异，留作后续单独验证。
   */
  _maybeFlushAssistantDelta(force = false) {
    if (this._bridging !== true) return 0
    const full = this._frames.filter((f) => f.kind === 'assistant').map((f) => f.text).join('')
    const delta = full.slice(this._streamedTextLen)
    if (delta.length === 0) return 0
    const now = Date.now()
    if (!force && delta.length < LIVE_FLUSH_MIN_CHARS && now - this._lastLiveFlushAt < LIVE_FLUSH_INTERVAL_MS) return 0

    const message = this.mm.createAssistantMessage({
      content: [{ type: 'text', text: delta }],
      source: { provider: `acp:${this.engine.id}`, model: this.engine.id },
    })
    const accumulator = new this.mm.AssistantStreamAccumulator()
    accumulator.push({ time: now, chunk: { type: 'text-delta', index: 0, text: delta } })
    this.session.append(
      'assistant/message',
      { turn: this._turn, step: this._activeStep, message, stream: accumulator.snapshot() },
      { surfaceOp: 'append' },
    )
    this._streamedTextLen = full.length
    this._lastLiveFlushAt = now
    this._liveFlushes += 1
    trace('acp.live-flush.text', {
      engineId: this.engine.id,
      deltaLen: delta.length,
      totalLen: full.length,
      flushes: this._liveFlushes,
    })
    return delta.length
  }

  /** ACP `session/update` 回调入口（由 AcpClient 的 onUpdate 转发）。 */
  onAcpUpdate(params) {
    const update = params?.update
    if (!update) return
    // 记一份"最近一次 update"，prompt 超时时用来回答"引擎最后卡在哪"（见 _promptOnce）。
    this._rememberUpdate(update)
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this._frames.push({ kind: 'assistant', text: update.content?.text ?? '', time: Date.now() })
        // A17②：**边跑边出字** —— 节流把新增文本 append 成 assistant/message（见 _flushAssistantDelta）
        this._maybeFlushAssistantDelta()
        break
      case 'agent_thought_chunk':
        this._frames.push({ kind: 'thought', text: update.content?.text ?? '', time: Date.now() })
        break
      case 'tool_call':
      case 'tool_call_update':
        // A1：桥接到 DSH 的 `tool/call` · `tool/result`
        // A17①：**增量落盘**（首个 tool_call / 终态结果各落一次），而不是攒到 turn 末尾
        this._onToolCallUpdate(update)
        break
      case 'available_commands_update': {
        // ── C1：引擎 skill / 命令发现的**回显**（ACP-INTEGRATION §6.1 的唯一真缺口）──
        // 引擎（omp / opencode 实测会发）用它上报自己扫到的 slash command / skill。
        // DSH 的 `SessionEventMap` 里没有对应事件类型，所以这里不伪造会话事件，而是
        //   · 记进 engine-runtime（引擎管理 UI 的"引擎命令/技能"诊断行）
        //   · trace 留痕（`<stateDir>/trace.log`），用以区分文档点名的两种故障：
        //     「引擎没发现 skill」= 这里 count=0 / 「发现了你没看见」= 这里 count>0
        const found = recordAvailableCommands(this.engine.id, update.availableCommands)
        this._availableCommands = found.commands
        this.logger?.info?.(
          `acp[${this.engine.id}]: available_commands_update → ${found.total} 个` +
            (found.total ? ` (${found.commands.map((c) => c.name).slice(0, 12).join(', ')}${found.total > 12 ? ', …' : ''})` : ''),
        )
        trace('acp.available_commands', {
          engineId: this.engine.id,
          total: found.total,
          names: found.commands.map((c) => c.name).slice(0, 50),
        })
        break
      }
      case 'config_option_update':
      case 'session_info_update': // ← omp 独有，必须容忍
      case 'usage_update':
        this.logger?.debug?.(`acp[${this.engine.id}]: update ${update.sessionUpdate}`)
        break
      default:
        // ⚠️ 未知事件类型必须容忍而非报错（omp 已证明会发非标准事件）
        this.logger?.debug?.(`acp[${this.engine.id}]: unknown update "${update.sessionUpdate}"`)
    }
  }

  /**
   * A1：把一个 ACP `tool_call` / `tool_call_update` 汇总进本 turn 的 buffer。
   *
   * 契约（session/src/types.ts:361-385）：
   *   `tool/call`   = { turn, step, callId, name, arguments }        —— **log-only**，无 surfaceOp
   *   `tool/result` = { turn, step, message: ToolResultMessage }     —— **surface event**，需 surfaceOp
   *
   * 字段映射：
   *   ACP `rawInput`   ←→ DSH `arguments`（JSON 字符串）
   *   ACP `status`     ←→ `failed` ⇒ `isError: true`；`completed` ⇒ 正常
   *
   * ⚠️ **`title` 不是工具名（2026-10-09 修）**：官方反向桥（dsh-acp updates.ts:52-85）把
   * DSH `name` 写成 ACP `title`，我们早期照着取反就得到 `name = update.title`。
   * 但引擎侧 `title` 是**给人读的一句话**（实测 omp：`"Finding WeKnora base URL in configs"`），
   * 于是 DSH 轨迹里的"工具名"全成了句子。现在：
   *   · `name` ← 真名优先：`update.toolName` → `_meta.{toolName,tool_name,tool,name,toolId}`
   *     → `kind`（read/execute/edit…，语义类别）→ `'acp-tool'`；
   *   · `title` / `kind` **另存**，随 `tool/call` 一起落盘（附加字段，DSH 的 log-only 事件容忍）。
   */
  _onToolCallUpdate(update) {
    if (this._bridging !== true) {
      this.logger?.debug?.(`acp[${this.engine.id}]: tool update outside a turn — not bridged`)
      return
    }
    const id = update?.toolCallId
    if (typeof id !== 'string' || id.length === 0) return

    let entry = this._toolCalls.get(id)
    if (entry === undefined) {
      entry = { recorded: false, finished: false, name: undefined, title: undefined, kind: undefined, rawInput: undefined }
      this._toolCalls.set(id, entry)
    }
    if (typeof update.title === 'string' && update.title.length > 0) entry.title = update.title
    if (typeof update.kind === 'string' && update.kind.length > 0) entry.kind = update.kind
    if (update.rawInput !== undefined) entry.rawInput = update.rawInput
    // 真名（可跨 update 补全：第一条没给、后面给了也能捞到）
    const resolved = resolveAcpToolName(update)
    if (resolved !== undefined) entry.name = resolved

    if (!entry.recorded) {
      entry.recorded = true
      trace('acp.tool-call', {
        engineId: this.engine.id,
        callId: id,
        name: entry.name ?? null,
        title: entry.title ?? null,
        kind: entry.kind ?? null,
      })
      this._toolEvents.push({
        type: 'tool/call',
        callId: id,
        name: entry.name ?? entry.kind ?? 'acp-tool',
        arguments: safeJsonString(entry.rawInput),
        // 另存的可读信息（DSH 侧只看 name/arguments；这两列给轨迹/导出用）
        ...(entry.title ? { title: entry.title } : {}),
        ...(entry.kind ? { kind: entry.kind } : {}),
      })
      // A17①：**立刻落盘**（含 A14 的广告块）—— 界面马上能看到"正在执行 X"，
      // 而不是等 turn 结束（实测长任务里 UI 会因此显示得像死机）。
      this._flushToolEvents()
    }

    if (!entry.finished && (update.status === 'completed' || update.status === 'failed')) {
      entry.finished = true
      const isError = update.status === 'failed'
      const blocks = acpToolContentToBlocks(update.content, update.rawOutput)
      this._toolEvents.push({
        type: 'tool/result',
        callId: id,
        isError,
        content: blocks.length > 0 ? blocks : [{ type: 'text', text: isError ? 'Tool failed' : 'Tool completed' }],
      })
      // A17①：结果一到就落盘
      this._flushToolEvents()
    }
  }

  /**
   * A14：**保证每个 `tool/call` 之前都有"广告块"**（哪怕这一轮 prompt 没跑完）。
   *
   * 背景：A11-3 只在 `_promptOnce` **成功返回**时才把 `tool-call` 块塞进 assistant 消息；
   * 而 `_flushToolEvents()` 在 `finally` 里一定会跑 —— 于是**超时/取消/引擎中途死掉**时，
   * 日志里就是"只有 tool/call、没有广告"⇒ 加载时报
   *   `tool/call call_00_… has no advertised tool lifecycle`
   * （实测 2026-10-09 19:0x 的 `session-a8b0c5f6` 正是这种）。
   *
   * 做法：落盘 tool 事件**之前**，把还没被广告过的 callId 收集起来，补一条
   * `assistant/message`（content 全是 tool-call 块、stream 为空），再继续。
   * 已广告过的不重复（校验器对同一 callId 重复广告同样会报错）。
   */
  _ensureToolAdvertisements(events) {
    const pending = (events ?? []).filter((e) => e.type === 'tool/call' && e.callId && !this._advertised.has(e.callId))
    if (pending.length === 0) return 0
    const turn = this._turn
    const step = this._activeStep
    const content = pending.map((e) => ({ type: 'tool-call', id: e.callId, name: e.name, arguments: e.arguments }))
    const message = this.mm.createAssistantMessage({
      content,
      source: { provider: `acp:${this.engine.id}`, model: this.engine.id },
    })
    this.session.append('assistant/message', { turn, step, message, stream: [] }, { surfaceOp: 'append' })
    for (const e of pending) this._advertised.add(e.callId)
    trace('acp.tool-advertised.late', { engineId: this.engine.id, count: pending.length, reason: 'prompt did not finish' })
    this.logger?.debug?.(
      `acp[${this.engine.id}]: advertised ${pending.length} tool call(s) after an incomplete prompt ` +
        '(keeps the stored log loadable)',
    )
    return pending.length
  }

  /** 把本 turn buffer 里的 tool 事件按序落盘（幂等：落完即清空）。 */
  _flushToolEvents() {
    const events = this._toolEvents
    if (!Array.isArray(events) || events.length === 0) return
    this._toolEvents = []
    // ⚠️ 这里**不能**重置 `_advertised`：`_promptOnce` 可能已经广告过这批 callId，
    //    清空后 `_ensureToolAdvertisements()` 会重复广告 → 校验器报错（同一 callId 只能广告一次）。
    const turn = this._turn
    const step = this._activeStep
    // A14：先补广告块（正常路径下 `_promptOnce` 已经写过，这里就不会再写）
    this._ensureToolAdvertisements(events)
    for (const event of events) {
      if (event.type === 'tool/call') {
        this.session.append('tool/call', {
          turn,
          step,
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
          // 附加列（DSH 只读 name/arguments；这两列给轨迹阅读与导出用）
          ...(event.title ? { title: event.title } : {}),
          ...(event.kind ? { kind: event.kind } : {}),
        })
      } else {
        const message = this.mm.createToolResultMessage({
          callId: event.callId,
          content: event.content,
          isError: event.isError,
        })
        this.session.append('tool/result', { turn, step, message }, { surfaceOp: 'append' })
      }
    }
  }

  /**
   * A13：从会话里读出"已经用过的最大 turn"。
   *
   * 优先用 DSH 的 `turnBoundary` 投影（官方 loop 与该插件共用同一套编号约定）；
   * 拿不到就退化为扫描会话事件里最大的 `data.turn`（`session.events` 在新版是数组）。
   * 任何异常都吞掉并返回 0 —— 编号接续失败最坏是"重复 turn"，不该让 agent 起不来。
   *
   * ⚠️ 2026-10-09 18:31 踩坑：`this.projections = projections` 一开始忘了把 `projections`
   * 加进构造函数的解构参数 → resume 时整条路径抛 `projections is not defined` →
   * `factory.resume.error-fallback`（引擎没起来）。教训：**改构造参数别忘了签名**。
   */
  _lastTurnFromSession() {
    try {
      const boundary = this.projections?.stateOf?.(this.session, 'turnBoundary')
      if (typeof boundary?.lastTurn === 'number' && boundary.lastTurn >= 0) {
        trace('acp.turn.resume-from-projection', { lastTurn: boundary.lastTurn })
        return boundary.lastTurn
      }
    } catch (error) {
      trace('acp.turn.projection-failed', { message: String(error?.message ?? error) })
    }
    try {
      const events = this.session?.events
      if (Array.isArray(events)) {
        let max = 0
        for (const event of events) {
          const t = event?.data?.turn
          if (typeof t === 'number' && t > max) max = t
        }
        trace('acp.turn.resume-from-events', { lastTurn: max, events: events.length })
        return max
      }
    } catch (error) {
      trace('acp.turn.events-failed', { message: String(error?.message ?? error) })
    }
    return 0
  }

  /**
   * A12：给**只有 `tool/call`、没有 `tool/result`** 的调用补一条失败结果。
   *
   * 为什么必须补（实测 `session-fb54ccef`）：引擎跑到一半 prompt 超时（300s），
   * 那个 `tool_call` 永远不会有终态，于是日志里留下悬空调用 →
   * 加载时 `step/end leaves unresolved tool call call_00_…` ⇒ **整个会话被判 corrupt**。
   * 官方 loop 在中断/取消时也会给未返回的工具补一条 error 结果，行为一致。
   *
   * 只处理**已经落过 `tool/call`**（`recorded`）且尚未 `finished` 的调用；
   * 结果文本说明是"引擎没有返回"（并带上 turn 结束原因），便于事后阅读。
   */
  _resolvePendingToolCalls(reason) {
    const turn = this._turn
    const step = this._activeStep
    let injected = 0
    for (const [callId, entry] of this._toolCalls) {
      if (!entry?.recorded || entry?.finished) continue
      const why = reason?.kind === 'aborted' ? 'turn was cancelled' : reason?.kind === 'error' ? 'turn failed' : 'turn ended'
      try {
        const message = this.mm.createToolResultMessage({
          callId,
          content: [{ type: 'text', text: `[dsh-multi-acp] no result from the engine — ${why} before this tool call completed.` }],
          isError: true,
        })
        this.session.append('tool/result', { turn, step, message }, { surfaceOp: 'append' })
        entry.finished = true
        injected++
      } catch (error) {
        trace('acp.tool-result.inject-failed', { callId, message: String(error?.message ?? error) })
      }
    }
    if (injected > 0) {
      trace('acp.tool-result.injected', { engineId: this.engine.id, count: injected, reasonKind: reason?.kind ?? null })
      this.logger?.warn?.(`acp[${this.engine.id}]: closed ${injected} dangling tool call(s) before step/end`)
    }
    return injected
  }

  /**
   * ACP `session/request_permission` 入口（A2）。
   *
   * 方向：**外部引擎**问**我们**要授权 → 我们把决定路由到 DSH 的
   * `ctx.approval.request()`（由 DSH UI 回答）。契约（dsh-user-approval）：
   *   `request({ agent, toolName, callId?, reason?, signal? }): Promise<ApprovalOutcome>`
   *   `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`
   * 且 **必须在一个已打开的 turn 内**调用（`approval.request()` 的硬前置；
   * 权限请求发生在 prompt 期间，此时 `turn/start` 已 append、`turn/end` 未到）。
   * 任何缺失/异常都 **fail closed**（拒绝），绝不擅自放行。
   */
  async onAcpPermission(params) {
    if (params?.sessionId && params.sessionId !== this.acpSessionId) {
      return { outcome: { outcome: 'cancelled' } }
    }
    const approval = this.approval
    if (!approval || typeof approval.request !== 'function') {
      this.logger?.warn?.(
        `acp[${this.engine.id}]: session/request_permission received but no DSH approval channel — denying`,
      )
      return { outcome: { outcome: 'cancelled' } }
    }

    const toolCall = params?.toolCall ?? {}
    const toolName =
      (typeof toolCall.title === 'string' && toolCall.title.length > 0 && toolCall.title) ||
      (typeof toolCall.kind === 'string' && toolCall.kind.length > 0 && toolCall.kind) ||
      `acp:${this.engine.id}`

    let outcome
    try {
      outcome = await approval.request({
        agent: this.agent,
        toolName,
        ...(toolCall.toolCallId === undefined ? {} : { callId: toolCall.toolCallId }),
        ...(this._abort?.signal === undefined ? {} : { signal: this._abort.signal }),
      })
    } catch (error) {
      this.logger?.error?.(
        `acp[${this.engine.id}]: approval.request failed — denying: ${String(error?.message ?? error)}`,
      )
      return { outcome: { outcome: 'cancelled' } }
    }

    this.logger?.info?.(`acp[${this.engine.id}]: permission "${toolName}" → ${outcome}`)
    return mapApprovalToAcp(outcome, params?.options)
  }
}

/**
 * 从 DSH 的 `UserMessage` 里抽出纯文本，用于拼 ACP prompt。
 *
 * A6：`UserMessage.content` 是 `readonly ContentBlock[]`，文本块是
 * `{ type: 'text', text }`（llm/llm/src/message.ts:139-164、types.ts:62-71）。
 * **只取 `type === 'text'`** —— `reasoning`/`image`/`file`/`tool-*` 都不能回灌给外部引擎。
 */
function extractText(message) {
  if (typeof message === 'string') return message
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        return part?.type === 'text' && typeof part.text === 'string' ? part.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * 安全读宿主 `agentPresets.composedPreset(ctx)`（traced service；缺失或抛错都视为未挂载）。
 * 用于判断宿主 `setup` 是否已经挂过 preset，避免重复 mount。
 */
function readComposedPreset(ctx, agentCtx) {
  try {
    return ctx.agentPresets?.composedPreset?.(agentCtx)
  } catch {
    return undefined
  }
}

/**
 * 安全读宿主 `approval` 服务（A2）。
 *
 * 用 `ctx.get('approval')` 而非 `ctx.approval` —— 本插件未 `inject: ['approval']`
 * （它应保持可选），而 Cordis 对未声明 inject 的**服务属性访问**可能抛错。
 * `ctx.get()` 是文档化的非抛错访问器（preset 源码里也用 `ctx.get(...)`）。
 */
function readApproval(ctx) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('approval') : undefined
    return unwrapService(service)
  } catch {
    return undefined
  }
}

/**
 * 安全读宿主 `sessionPersistence` 服务（A8）。
 *
 * 缺失表示未挂持久化后端 —— 此时 create 仍可工作（会话不落盘），
 * resume 则无法恢复历史（降级并告警）。
 */
function readPersistence(ctx) {
  try {
    return typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
  } catch {
    return undefined
  }
}

/**
 * A8：把 handle 尚未存储的事件后缀推给它（照 agent-loop/src/index.ts:698-706）。
 *
 * 发布前 append 的事件（构造 seed 标记、setup 窗口事件）**不会**经 `session/event`
 * 重放，因此在 `announce` 之前必须手动补齐。`snapshotEvents` 是官方标记 deprecated
 * 的既有历史读取路径（我们照抄 agent-loop 的用法）。
 */
async function appendUnstoredSuffix(stored, session) {
  if (stored === undefined) return
  const suffix = session.snapshotEvents(stored.storedCount)
  if (suffix.length > 0) await stored.handle.append(suffix)
  // 按"实际存储数量"前进，而非 session.seq：await 期间新 append 的留待下次。
  stored.storedCount += suffix.length
}

/**
 * 把 DSH 的 `ApprovalOutcome` 映射回 ACP 的 `RequestPermissionResponse`（A2）。
 *
 * - `'allowed-once'` → 选中引擎提供的 **allow** 选项（优先 `allow_once`）。
 *   ⚠️ DSH 只给一次性授权，**绝不**替用户选 `allow_always`。
 * - `'rejected'` / `'unavailable'` → 选中 **reject** 选项（优先 `reject_once`）。
 * - `'cancelled'` / 未知 / 无匹配选项 → `{ outcome: 'cancelled' }`。
 */
function mapApprovalToAcp(outcome, options) {
  const opts = Array.isArray(options) ? options : []
  const kindOf = (o) => (typeof o?.kind === 'string' ? o.kind : '')
  const pick = (preferred, prefix) =>
    opts.find((o) => preferred.includes(kindOf(o))) ?? opts.find((o) => kindOf(o).startsWith(prefix))

  if (outcome === 'allowed-once') {
    const allow = pick(['allow_once', 'allow_always'], 'allow')
    if (allow?.optionId !== undefined) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
    return { outcome: { outcome: 'cancelled' } }
  }
  if (outcome === 'rejected' || outcome === 'unavailable') {
    const reject = pick(['reject_once', 'reject_always'], 'reject')
    if (reject?.optionId !== undefined) return { outcome: { outcome: 'selected', optionId: reject.optionId } }
    return { outcome: { outcome: 'cancelled' } }
  }
  return { outcome: { outcome: 'cancelled' } }
}

/** JSON.stringify，任何失败（含 undefined / 循环）都退回 `'{}'`（`tool/call.arguments` 必须是字符串）。 */
function safeJsonString(value) {
  try {
    const text = JSON.stringify(value)
    return typeof text === 'string' ? text : '{}'
  } catch {
    return '{}'
  }
}

/**
 * 从 ACP 的 `tool_call` / `tool_call_update` 里解析**真正的工具名**（2026-10-09）。
 *
 * ACP 的 `ToolCall` 只有 `title`（必填、给人读的一句话）与 `kind`（类别：read/execute/edit…），
 * **没有** `toolName` 字段（见 `@agentclientprotocol/sdk` types.gen.d.ts:5130-5190）。
 * 引擎习惯把真名放 `_meta`（omp / opencode 系）或直接加一个扩展字段，所以按下面的顺序取：
 *
 *   1. `update.toolName`（扩展字段，部分引擎直接加在顶层）
 *   2. `_meta.toolName | tool_name | tool | name | toolId`
 *   3. `rawInput.tool` / `rawInput.toolName`（个别引擎把名字塞进入参）
 *   ⇒ 都取不到时返回 `undefined`（调用方退回 `kind`，最后才是 `'acp-tool'`）
 *
 * 注意**绝不**返回 `title`：它是句子（实测 omp：`"Finding WeKnora base URL in configs"`），
 * 早期版本把它当工具名用，导致轨迹里工具名全是句子。`title` 现在单独存一列。
 */
export function resolveAcpToolName(update) {
  const meta = update?._meta ?? {}
  const raw = update?.rawInput ?? {}
  const candidates = [
    update?.toolName,
    meta.toolName,
    meta.tool_name,
    meta.tool,
    meta.name,
    meta.toolId,
    typeof raw === 'object' && raw !== null ? raw.tool : undefined,
    typeof raw === 'object' && raw !== null ? raw.toolName : undefined,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  // 兜底：**有些引擎的 `title` 就是工具名**（实测 2026-10-09 的 Command Code：
  // `title = "mcp__weknora-dc328ba5__list_knowledge_bases"` / `"search_tools"`），
  // 而 omp 的 `title` 是一句人话（`"Finding WeKnora base URL in configs"`）。
  // 用"像不像标识符"区分：无空白、只含 `\w . - _ : /`，且不太长 → 当工具名用。
  const title = update?.title
  if (typeof title === 'string' && looksLikeToolName(title)) return title.trim()
  // 第三种形态（实测 Qoder CLI CN）：`title = "list_knowledge_bases (weknora-2afef91d MCP Server)"`
  // —— 真名在最前面，后面跟着括号注释。取首段（要求后面确实跟了分隔符，避免把
  // omp 的 `"Finding WeKnora base URL in configs"` 误当工具名）。
  const leading = /^([\w.\-:/]+)\s*[(\[:·—]/.exec(String(title ?? '').trim())
  if (leading) return leading[1]
  return undefined
}

/** `title` 像不像工具名（而非一句描述）。 */
export function looksLikeToolName(title) {
  const t = String(title ?? '').trim()
  if (t.length === 0 || t.length > 80) return false
  if (/\s/.test(t)) return false
  return /^[\w.\-:/]+$/.test(t)
}

/**
 * ISSUE-01：把引擎/ACP 的失败文本归一到**稳定机器码**，让「余额不足 / 未授权 / 限流 / 超时」
 * 与「协议不通」分开呈现，而不是把计费口径的英文原样丢给用户。
 */
function classifyAcpError(message) {
  const text = String(message ?? '')
  if (/insufficient\s+(account\s+)?funds|insufficient_?quota|insufficient\s+balance|quota exceeded|余额不足|\b402\b/i.test(text)) {
    return 'INSUFFICIENT_FUNDS'
  }
  if (/rate\s*limit|too many requests|\b429\b/i.test(text)) return 'RATE_LIMITED'
  if (/unauthor|not\s+logged\s+in|authentication|invalid\s+api\s*key|\bapi\s*key\b|\b401\b|\b403\b/i.test(text)) {
    return 'UNAUTHORIZED'
  }
  if (/timed?\s*out|timeout/i.test(text)) return 'TIMEOUT'
  return 'UNKNOWN'
}

/**
 * A1：把 ACP `ToolCallContent[]` 转成 DSH 的 `ContentBlock[]`。
 *
 * ACP 形状（sdk `types.gen.d.ts:5185`）：`{type:'content', content: Content}` |
 * `{type:'diff', path, oldText, newText}` | `{type:'terminal', ...}`。
 * 只产出 DSH 支持的**文本块**：`image` 需要 attachment 引用，降级为占位文本；
 * 若没有任何可渲染内容则回退到 `rawOutput` 的文本形式。
 */
function acpToolContentToBlocks(content, rawOutput) {
  const blocks = []
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item?.type === 'content' && item.content?.type === 'text' && typeof item.content.text === 'string') {
        if (item.content.text.length > 0) blocks.push({ type: 'text', text: item.content.text })
      } else if (item?.type === 'content' && item.content?.type === 'image') {
        blocks.push({ type: 'text', text: '[image]' })
      } else if (item?.type === 'diff' && typeof item.path === 'string') {
        const oldText = typeof item.oldText === 'string' ? item.oldText : ''
        const newText = typeof item.newText === 'string' ? item.newText : ''
        blocks.push({ type: 'text', text: `diff ${item.path}\n--- old\n${oldText}\n+++ new\n${newText}` })
      }
    }
  }
  if (blocks.length === 0 && rawOutput !== undefined) {
    const text = typeof rawOutput === 'string' ? rawOutput : safeJsonString(rawOutput)
    if (text.length > 0 && text !== '{}') blocks.push({ type: 'text', text })
  }
  return blocks
}

/** 供 UI / 诊断使用：列出可用引擎。 */
export function listEngines(factory) {
  return factory.engines.map((e) => ({
    id: e.id,
    label: e.label,
    description: e.description,
    presetId: presetIdFor(e.id),
    command: e.resolvedCommand ?? e.command,
    args: e.args,
    enabled: e.enabled,
    capabilities: e.capabilities,
  }))
}

export { unwrapService }
