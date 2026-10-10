/**
 * **ACP 根 agent 的装配**：把外部引擎的会话装成一个 DSH `Agent`。
 *
 * 分工（Q6 批次二拆完后的模块边界）：
 *   · 路由（谁造 agent）→ `./acp-factory.js`
 *   · 待处理输入（inbox）→ `./acp-inbox.js`
 *   · 回合与事件桥 → `./acp-turn-runner.js`
 *   · 宿主契约探测 → `./agent-contract.js`
 *   · **本模块只负责"怎么组装"**：建 scoped ctx、挂 inbox、跑 setup、接 runner。
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
import { presetIdFor } from './preset-ids.js'
import { readSessionMap, writeSessionMap } from './session-map.js'
import { resolveMcpServers, summarizeMcpServers } from './mcp-servers.js'
import { recordMcpServers, recordPermissionMapping } from './engine-runtime.js'
import { readSessionPermissions, mapPresetToMode, applyPermissionMode } from './permission-bridge.js'
import { supportedPermissionModes } from './engines.js'
import { trace } from './trace.js'
// 宿主契约探测 / 错误分类已抽到独立模块（Q6 批次二第一个切片）——本模块只消费它们。
import { createAcpInbox } from './acp-inbox.js'
import { AcpTurnRunner } from './acp-turn-runner.js'

/* ═══════════════════════════════════════════════════════════════════════
 * Agent 构造
 * ═══════════════════════════════════════════════════════════════════════ */

export async function createAcpAgent({ rootCtx, ownerCtx, options, engine, pool, stateDir, mcpConfig, projections, permissionModeFromSession = true, resume = false }) {
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
  // A18：把映射结果记进引擎运行时，UI 的引擎行诊断行会显示它
  //（未生效时直接给出"无人值守请把引擎权限模式设为 dont_ask"这类可操作提示）
  recordPermissionMapping(engine.id, {
    preset: sessionPermissions?.preset ?? null,
    mapped: permission.mode,
    reason: permission.reason,
    poolKey: sessionEngine.poolKey ?? engine.id,
  })
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
  /** 先占位再回填：inbox 需要 emit，而 emit 要等 inbox 造好才知道往哪发。 */
  /** @type {{ fn: (name: string, payload?: unknown) => void }} */
  const inboxEmit = { fn: () => {} }
  const inbox = createAcpInbox({
    session,
    projections,
    logger: rootCtx.logger,
    emit: (name, payload) => inboxEmit.fn(name, payload),
  })
  let agentCtx
  /**
   * ⚠️ 必须从**包根**导入 `Agent`，不能从 `'@deepseek-ai/dsh-agent/types'` 子路径：
   * 根 `index.d.ts` 有 `export * from './runtime-types.ts'`，而运行时 `Agent` 的成员
   * （`session`/`status`/`inbox`/`options`/`ctx`/`cancel`/`whenIdle`）是通过
   * `runtime-types.d.ts` 里 `declare module './types.ts'` 的**模块增强**加进去的。
   * 只引子路径 → 增强不参与编译 → `Agent` 退化成只剩 `{ id }`，
   * 于是这些成员全部"不存在"（本次类型基线里 5 个错误就是这么来的）。
   *
   * @type {import('@deepseek-ai/dsh-agent').Agent}
   */
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
    // 宿主把 `Agent.status` 声明为 `readonly`（契约原文："The current lifecycle state,
    // mirrored on every `agent/status` transition"）。但**这个 agent 的持有者就是我们自己** ——
    // 没有别的地方会维护这个镜像，所以必须自己写。与 ADR-0006 的 factory 越界同属
    // "路线 B 的固有代价"。
    //
    // 用 `@ts-expect-error` 而不是留红：一旦 DSH 把它改成可写（或删掉该成员），
    // 本行会**反向报错**，等于一个免费的升级探测器。
    // @ts-expect-error readonly —— 见上方说明与 ADR-0006
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
