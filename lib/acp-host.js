/**
 * 每引擎一个 ACP 进程宿主。
 *
 * ✅ 设计依据（实测）：三个引擎都支持**同进程多 session**
 *    （docs/evidence/ 中每个引擎都完成了两次 session/new）。
 *    因此进程按引擎共享、按空闲回收，而不是每会话一进程。
 *
 * 📖 该策略与 dsh-grok-acp 一致（其 README：多个会话复用一个按需启动的 ACP 进程）。
 *
 * @module dsh-multi-acp/acp-host
 */
import { AcpClient } from './acp-client.js'
import { importFromDsh } from './dsh-imports.js'

export class AcpHost {
  /**
   * @param {object} opts
   * @param {object} opts.engine
   * @param {object} [opts.logger]
   */
  constructor({ engine, logger }) {
    this.engine = engine
    this.logger = logger
    /** @type {AcpClient|null} 共享进程 */
    this.client = null
    /** acpSessionId -> { cwd, dshSessionId } */
    this.sessions = new Map()
    /**
     * acpSessionId -> handler（通常是 AcpTurnRunner）。
     *
     * ⚠️ 进程是**按引擎共享**的（多会话复用，见文件头），所以 `session/update`
     *    必须按 `params.sessionId` 分发到对应会话的 handler，不能全局广播。
     */
    this.handlers = new Map()
    this._idleTimer = null
    this._starting = null
  }

  /** 注册某个 ACP 会话的更新处理器。 */
  setSessionHandler(acpSessionId, handler) {
    this.handlers.set(acpSessionId, handler)
  }

  clearSessionHandler(acpSessionId) {
    this.handlers.delete(acpSessionId)
  }

  /** 按 sessionId 分发 `session/update`。 */
  _dispatchUpdate(params) {
    const acpSessionId = params?.sessionId
    const handler = acpSessionId ? this.handlers.get(acpSessionId) : undefined
    if (handler?.onAcpUpdate) {
      try {
        handler.onAcpUpdate(params)
      } catch (error) {
        this.logger?.error?.(`acp[${this.engine.id}]: update handler threw: ${String(error?.message ?? error)}`)
      }
      return
    }
    this.logger?.debug?.(`acp[${this.engine.id}]: update for unknown session ${String(acpSessionId)}`)
  }

  /**
   * 按 sessionId 分发 `session/request_permission`（A2）。
   *
   * ⚠️ ACP 进程是**按引擎共享**的（多会话复用，见文件头），所以权限请求也必须
   *    按 `params.sessionId` 路由到对应会话的 handler，不能全局回答。
   * 找不到 handler（或 handler 抛错）时**fail closed** → 一律 `cancelled`（拒绝）。
   */
  async _dispatchPermission(params) {
    const acpSessionId = params?.sessionId
    const handler = acpSessionId ? this.handlers.get(acpSessionId) : undefined
    if (handler?.onAcpPermission) {
      try {
        return await handler.onAcpPermission(params)
      } catch (error) {
        this.logger?.error?.(
          `acp[${this.engine.id}]: permission handler threw — denying: ${String(error?.message ?? error)}`,
        )
        return { outcome: { outcome: 'cancelled' } }
      }
    }
    this.logger?.warn?.(
      `acp[${this.engine.id}]: permission request for unknown session ${String(acpSessionId)} — denied`,
    )
    return { outcome: { outcome: 'cancelled' } }
  }

  get idleDisposeMs() {
    return this.engine.idleDisposeMs ?? 30000
  }

  /** 懒启动：并发调用会共享同一个启动 Promise。 */
  async ensureStarted(cwd) {
    this._cancelIdleTimer()
    if (this.client?.running) return this.client
    if (this._starting) return this._starting
    this._starting = (async () => {
      const client = new AcpClient({
        engine: this.engine,
        cwd,
        logger: this.logger,
        onUpdate: (params) => this._dispatchUpdate(params),
        onPermission: (params) => this._dispatchPermission(params),
        onFsRead: (params) => this._onFsRead?.(params),
        onFsWrite: (params) => this._onFsWrite?.(params),
      })
      await client.start()
      await client.initialize()
      this.client = client
      return client
    })()
    try {
      return await this._starting
    } finally {
      this._starting = null
    }
  }

  /** 打开（或复用）一个 ACP 会话。 */
  async openSession({ dshSessionId, cwd, mcpServers = [] }) {
    const client = await this.ensureStarted(cwd)
    const result = await client.newSession({ cwd, mcpServers })
    this.sessions.set(result.sessionId, { cwd, dshSessionId })
    this._cancelIdleTimer()
    return { acpSessionId: result.sessionId, raw: result, client }
  }

  // B1：MCP 随会话注入 —— `session/new` 与 `session/load` 都带 mcpServers
  //（ACP 规范里两者是同一个字段；只喂 new 会让"重开会话"丢掉 MCP 连接）。
  async resumeSession({ acpSessionId, dshSessionId, cwd, mcpServers = [] }) {
    const client = await this.ensureStarted(cwd)
    await client.loadSession({ sessionId: acpSessionId, cwd, mcpServers })
    this.sessions.set(acpSessionId, { cwd, dshSessionId })
    this._cancelIdleTimer()
    return { acpSessionId, client }
  }

  releaseSession(acpSessionId) {
    this.sessions.delete(acpSessionId)
    if (this.sessions.size === 0) this._scheduleIdleDispose()
  }

  _scheduleIdleDispose() {
    this._cancelIdleTimer()
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null
      if (this.sessions.size === 0) void this.dispose()
    }, this.idleDisposeMs)
    this._idleTimer.unref?.()
  }

  _cancelIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer)
      this._idleTimer = null
    }
  }

  async dispose() {
    this._cancelIdleTimer()
    const client = this.client
    this.client = null
    this.sessions.clear()
    if (client) await client.dispose()
  }

  /** 试连：起进程 → initialize → 报告能力，然后立刻回收。不建会话、不发 prompt。 */
  async tryConnect({ cwd }) {
    const client = new AcpClient({ engine: this.engine, cwd, logger: this.logger })
    const startedAt = Date.now()
    try {
      await client.start()
      await client.initialize()
      const caps = client.capabilities()
      return {
        engineId: this.engine.id,
        ok: true,
        totalMs: Date.now() - startedAt,
        spawn: { command: this.engine.resolvedCommand ?? this.engine.command, args: this.engine.args },
        ...caps,
      }
    } catch (error) {
      return {
        engineId: this.engine.id,
        ok: false,
        totalMs: Date.now() - startedAt,
        error: String(error?.message ?? error),
        stderr: null,
      }
    } finally {
      await client.dispose().catch(() => {})
    }
  }
}

/**
 * 引擎宿主池：按 engineId 复用 AcpHost，并在插件 dispose 时统一回收。
 */
export class AcpHostPool {
  constructor({ logger }) {
    this.logger = logger
    /** @type {Map<string, AcpHost>} */
    this.hosts = new Map()
  }

  get(engine) {
    let host = this.hosts.get(engine.id)
    if (!host) {
      host = new AcpHost({ engine, logger: this.logger })
      this.hosts.set(engine.id, host)
    }
    return host
  }

  async disposeAll() {
    const all = [...this.hosts.values()]
    this.hosts.clear()
    await Promise.allSettled(all.map((h) => h.dispose()))
  }
}

/**
 * 探测宿主 ACP 相关包是否可用。
 *
 * 用途：DSH 0.2.0-rc.2 **内置** `@deepseek-ai/dsh-acp` 与 `dsh-acp-app`，
 * 但它们是 **ACP 服务端**（把 DSH 变成别人的 agent，见其包内文档：
 * "Automation-only ACP stdio application profile"）。
 * 本插件需要的是**客户端**方向，二者不冲突但也不可复用。
 * 这里只做存在性记录，供诊断输出。
 */
export async function probeBuiltinAcp() {
  const out = { packages: [] }
  for (const pkg of ['@deepseek-ai/dsh-acp', '@deepseek-ai/dsh-acp-app']) {
    try {
      await importFromDsh(pkg)
      out.packages.push({ pkg, present: true, note: 'server-side (DSH as ACP agent); not used by this plugin' })
    } catch {
      out.packages.push({ pkg, present: false })
    }
  }
  return out
}
