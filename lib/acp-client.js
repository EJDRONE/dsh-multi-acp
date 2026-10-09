/**
 * ACP 客户端：驱动一个外部 ACP CLI。
 *
 * ✅ 本模块的 API 用法已被 probe/probe-acp.mjs 完整实测（三个引擎均跑通端到端）。
 *    见 docs/evidence/probe-*.json。
 *
 * 设计要点：
 *  - 用官方 @agentclientprotocol/sdk 的 ClientSideConnection，不手搓 JSON-RPC
 *  - 原始 stdio 行**逐条留档**（方言档案的唯一合法来源，见 docs/ENGINE-SPEC.md §5）
 *  - 握手超时分冷/稳态两档（稳态 30s / 冷启动 300s）
 *  - 客户端回调用 Proxy 兜底：未知回调记日志而不崩（omp 已证明会发非标准事件）
 *
 * @module dsh-multi-acp/acp-client
 */
import { spawn } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import { resolveSpawn } from './engines.js'

/**
 * `prompt` 的默认超时（毫秒）。可被 `engine.promptTimeoutMs` 覆盖；
 * `<= 0` 表示不超时。见 {@link AcpClient#_budgetMs} 里的实测记录。
 */
export const DEFAULT_PROMPT_TIMEOUT_MS = 300_000

/**
 * ⚠️ ACP SDK **惰性加载**，不在模块顶层 import。
 *
 * 原因：插件加载期任何顶层 import 失败都会让整个插件进入「启动失败」。
 * 而 SDK 只在真正要用（开 ACP 连接）时才需要。
 * 用时再 import，加载期就少一个故障面。
 */
let acp = null
async function loadAcp() {
  if (acp) return acp
  acp = await import('@agentclientprotocol/sdk')
  return acp
}

/** 客户端回调的默认实现。未知方法由 Proxy 兜底。 */
function createCallbackSink({ onUpdate, onPermission, onFsRead, onFsWrite, logger, rawLines }) {
  const seen = new Map()
  const base = {
    async sessionUpdate(params) {
      const type = params?.update?.sessionUpdate ?? 'unknown'
      seen.set(`sessionUpdate:${type}`, (seen.get(`sessionUpdate:${type}`) ?? 0) + 1)
      onUpdate?.(params)
    },
    async requestPermission(params) {
      if (onPermission) return onPermission(params)
      // 默认策略：拒绝（不擅自放行）。上层必须显式提供策略。
      return { outcome: { outcome: 'cancelled' } }
    },
    async readTextFile(params) {
      if (onFsRead) return onFsRead(params)
      // 未声明 fs 能力（initialize 里 fs:false）：正常不应被调用；被调用则记警告并如实回空。
      logger?.warn?.('acp: readTextFile called although fs support was NOT advertised')
      return { content: '' }
    },
    async writeTextFile(params) {
      if (onFsWrite) return onFsWrite(params)
      logger?.warn?.('acp: writeTextFile called although fs support was NOT advertised')
      return {}
    },
  }
  return {
    callbacks: new Proxy(base, {
      get(target, prop) {
        if (prop in target) return target[prop]
        if (typeof prop === 'symbol') return undefined
        return async (...args) => {
          // ⚠️ 未知回调：记录但不当错误。omp 已经证明会有非标准事件。
          logger?.debug?.(`acp: unknown client callback "${String(prop)}"`)
          rawLines?.recordCallback?.(String(prop), args)
          return {}
        }
      },
    }),
    counts: seen,
  }
}

export class AcpClient {
  /**
   * @param {object} opts
   * @param {object} opts.engine      归一化后的引擎定义（见 engines.js）
   * @param {string} opts.cwd         会话工作目录
   * @param {object} [opts.logger]
   * @param {(params:any)=>void} [opts.onUpdate]
   * @param {(params:any)=>Promise<any>} [opts.onPermission]
   */
  constructor({ engine, cwd, logger, onUpdate, onPermission, onFsRead, onFsWrite }) {
    this.engine = engine
    this.cwd = cwd
    this.logger = logger
    this.child = null
    this.connection = null
    this.rawLines = []
    this.parseFailures = 0
    this.initializeResult = null
    this.sessions = new Map()
    this._disposed = false
    this._sinkCounts = new Map()

    this._onUpdate = onUpdate
    this._onPermission = onPermission
    this._onFsRead = onFsRead
    this._onFsWrite = onFsWrite
  }

  get running() {
    return this.child !== null && this.child.exitCode === null && !this._disposed
  }

  /** 冷启动判定：npx 系引擎的首次安装在握手窗口内发生（📖 AionCore acp_init_budget.rs）。 */
  _budgetMs(kind) {
    const b = this.engine.initBudget ?? {}
    if (kind === 'initialize') {
      const cold = b.coldProbe && b.coldProbe !== 'none'
      // TODO(P2): 真正实现 npx 缓存探测（_npx/<hash>）/ 首次运行标记
      const secs = cold ? (b.coldSecs ?? 300) : (b.steadySecs ?? 30)
      return secs * 1000
    }
    // ── prompt 超时（2026-10-09 可配置；2026-10-10 改成"双闸"）────────────────
    // A16：墙钟上限会把**正在干活**的长任务误杀（实测 session-503ea973：omp 已成功跑完
    // 21 次工具调用、还在吐 thought 时被 300s 掐断）。因此：
    //   · 这里只负责**总时长闸**（`engine.promptTimeoutMs`，默认 0 = 不限）；
    //   · **空闲闸**（多久没有任何 session/update 才算卡死）在 agent 侧实现
    //     （它才知道"最后一次 update"是什么时候），见 lib/prompt-timeout.js。
    const configured = this.engine.promptTimeoutMs
    if (typeof configured === 'number' && Number.isFinite(configured)) {
      return configured <= 0 ? 0 : configured
    }
    return DEFAULT_PROMPT_TIMEOUT_MS
  }

  async start() {
    if (this.running) return this
    const sp = resolveSpawn(this.engine)
    this.logger?.info?.(`acp[${this.engine.id}]: spawning ${sp.command} (${sp.via}) cwd=${this.cwd}`)

    this.child = spawn(sp.command, sp.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
      env: { ...process.env, ...(this.engine.env ?? {}) },
      windowsHide: true,
    })

    this.child.on('error', (error) => {
      this.logger?.error?.(`acp[${this.engine.id}]: spawn failed: ${error.message}`)
      this._fatal = String(error?.message ?? error)
    })
    this.child.stderr.on('data', (buf) => {
      const text = buf.toString().trimEnd()
      if (text) this.logger?.debug?.(`acp[${this.engine.id}] stderr: ${text}`)
    })

    // 原始行留档 + 透传
    const tee = new Readable({ read() {} })
    this.child.stdout.on('data', (buf) => {
      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue
        if (this.rawLines.length < 5000) this.rawLines.push(line)
        try {
          JSON.parse(line)
        } catch {
          this.parseFailures++
        }
      }
      tee.push(buf)
    })
    this.child.stdout.on('end', () => tee.push(null))

    const { callbacks } = createCallbackSink({
      onUpdate: this._onUpdate,
      onPermission: this._onPermission,
      onFsRead: this._onFsRead,
      onFsWrite: this._onFsWrite,
      logger: this.logger,
    })

    const sdk = await loadAcp()
    const stream = sdk.ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(tee))
    this.connection = new sdk.ClientSideConnection(() => callbacks, stream)
    return this
  }

  _assertConnection() {
    if (this._fatal) throw new Error(`acp[${this.engine.id}]: ${this._fatal}`)
    if (!this.connection) throw new Error(`acp[${this.engine.id}]: not started`)
    return this.connection
  }

  /** initialize。返回 SDK 的 InitializeResponse。 */
  async initialize({ clientCapabilities } = {}) {
    const connection = this._assertConnection()
    const sdk = await loadAcp()
    const started = Date.now()
    const result = await withTimeout(
      connection.initialize({
        protocolVersion: sdk.PROTOCOL_VERSION,
        clientCapabilities: clientCapabilities ?? {
          // ISSUE-04：**如实声明**能力。此前写 true 但 handler 只返回空内容，等于向引擎
          // "谎报"支持 fs —— 引擎会依赖一个空实现，写文件静默失败。
          // 未实现 → 声明 false，引擎改用自己的 fs 工具。
          fs: { readTextFile: false, writeTextFile: false },
        },
      }),
      this._budgetMs('initialize'),
      `acp[${this.engine.id}]: initialize`,
    )
    this.initializeResult = { ...result, latencyMs: Date.now() - started }
    this.logger?.info?.(
      `acp[${this.engine.id}]: initialized in ${this.initializeResult.latencyMs}ms ` +
        `agent=${JSON.stringify(result?.agentInfo ?? null)}`,
    )
    return this.initializeResult
  }

  /** 能力快照，供 UI / 试连报告使用。 */
  capabilities() {
    const r = this.initializeResult ?? {}
    return {
      agentInfo: r.agentInfo ?? null,
      authMethods: r.authMethods ?? null,
      ...(r.agentCapabilities ?? {}),
      latencyMs: r.latencyMs ?? null,
      parseFailures: this.parseFailures,
      rawLineCount: this.rawLines.length,
    }
  }

  async newSession({ cwd, mcpServers = [] } = {}) {
    const connection = this._assertConnection()
    const result = await withTimeout(
      connection.newSession({ cwd: cwd ?? this.cwd, mcpServers }),
      this._budgetMs('session'),
      `acp[${this.engine.id}]: session/new`,
    )
    this.sessions.set(result.sessionId, { cwd: cwd ?? this.cwd, raw: result })
    return result
  }

  async loadSession({ sessionId, cwd, mcpServers = [] } = {}) {
    const connection = this._assertConnection()
    const result = await withTimeout(
      connection.loadSession({ sessionId, cwd: cwd ?? this.cwd, mcpServers }),
      this._budgetMs('session'),
      `acp[${this.engine.id}]: session/load`,
    )
    this.sessions.set(sessionId, { cwd: cwd ?? this.cwd, raw: result })
    return result
  }

  async prompt({ sessionId, prompt }) {
    const connection = this._assertConnection()
    return withTimeout(
      connection.prompt({ sessionId, prompt }),
      this._budgetMs('prompt'),
      `acp[${this.engine.id}]: session/prompt`,
    )
  }

  async cancel({ sessionId }) {
    const connection = this._assertConnection()
    return connection.cancel({ sessionId })
  }

  /** ✅ 实测：opencode 的 model / effort / mode 走这条；omp 同时提供 configOptions 与 modes。 */
  async setConfigOption({ sessionId, configId, value }) {
    const connection = this._assertConnection()
    return connection.setSessionConfigOption({ sessionId, configId, value })
  }

  async dispose() {
    if (this._disposed) return
    this._disposed = true
    const child = this.child
    this.child = null
    this.connection = null
    this.sessions.clear()
    if (!child || child.exitCode !== null) return

    const grace = this.engine.disposeGraceMs ?? 6000
    const killed = new Promise((resolve) => {
      child.once('exit', resolve)
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve()
      }, grace)
    })
    try {
      child.stdin?.end()
      child.kill()
    } catch {
      /* ignore */
    }
    await killed
    this.logger?.info?.(`acp[${this.engine.id}]: disposed`)
  }
}

/**
 * 带超时的 Promise。超时错误里带上引擎 id，便于用户区分"挂住"与"没实现"。
 *
 * `ms <= 0` = **不设超时**（直接等 promise）。长任务引擎（深度 agent、大仓库重构）会跑很久，
 * 硬编码上限会把正常任务判成失败——实测 omp 就撞过 300s。
 */
export function withTimeout(promise, ms, label) {
  if (!(typeof ms === 'number') || !Number.isFinite(ms) || ms <= 0) {
    return promise
  }
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label}: timed out after ${Math.round(ms / 1000)}s`))
      }, ms)
    }),
  ])
}
