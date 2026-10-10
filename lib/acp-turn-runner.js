/**
 * ACP turn runner —— 把 inbox 里的工作转成 ACP `session/prompt`，
 * 并把引擎侧的 ACP 事件**桥回 DSH 的会话事件**（A1/A2/A17）。
 *
 * 从 `acp-agent.js` 抽出（Q6 批次二 · 事件桥切片）。这是本插件里最长的一块，
 * 也是唯一需要逐条满足**会话日志契约**的地方（surface 标记、tool 广告块、
 * `turn/end` 的 `{ turn, reason: { kind } }` 形状 —— 见 `docs/VERIFICATION.md` §13）。
 *
 * 抽它是纯搬移：`createAcpAgent` 仍然 `new AcpTurnRunner({...})`，只是 import 变了。
 *
 * @module dsh-multi-acp/acp-turn-runner
 */

import { recordAvailableCommands, recordTurnStart, recordToolProgress, recordTurnEnd } from './engine-runtime.js'
import { evaluateTimeout, DEFAULT_IDLE_TIMEOUT_MS } from './prompt-timeout.js'
import { trace } from './trace.js'

/**
 * A17②：流式落盘的节流参数（间隔 ≥ N ms 或新增 ≥ N 字符才写一条 assistant/message）。
 * 太频繁会把会话日志刷爆；太稀疏则界面既不像"在跑"也不够实时。
 */
const LIVE_FLUSH_INTERVAL_MS = 1200
const LIVE_FLUSH_MIN_CHARS = 400
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
    /** 由 `createAcpAgent` 回填；未回填时是 no-op。 @type {(status: 'idle'|'running') => void} */
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
   * @param {object} [options]
   * @param {boolean} [options.keepInbox]  契约（runtime-types.ts:41-44）原文：
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
    // B2：回合进度（UI 引擎行诊断行显示"它在干活"；不写任何会话事件）
    recordTurnStart(this.engine.id, { turn, step })
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
        // B2：回合结束（UI 诊断行从"运行中"切到"上次回合：N 次工具调用 · 耗时 …"）
        recordTurnEnd(this.engine.id, { reason: reason?.kind ?? null })
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

    // A17②：**已回退为"整段一次写入"**（2026-10-10 实测教训）。
    //
    // 曾试过把助手文本按增量 append 成多条 assistant/message（节流 400 字符 / 1.2s），
    // 结果 UI 上**中间输出被吞**：DSH 会把同一 turn/step 内连续的 assistant/message 折叠成一条
    // 并只显示最新那份，于是用户只看到最后一段碎片。
    //
    // 顺着 `dsh-session/lib/types/surface.d.ts:29-31` 的说明看就更清楚了：
    //   "a landed replacement would erase conversation the user already saw.
    //    Append-origin events are that transcript's durable source material;
    //    replacement copies stay model-only."
    // ⇒ 想"边跑边出字"就必须用 append 打底 + `surfaceOp:{op:'replace',start,end}` +
    //   `sourceEventSeqs` 原地增长，**且**收尾再 append 一次完整文本（否则 durable transcript
    //   里只剩打底那份碎片）。`session.append()` 确实回传 `SessionEvent`（types/index.d.ts:212），
    //   所以技术上可行 —— 但需要在真机上验证 replace 的 range/引用与 UI 折叠行为，故本轮先不做。
    // 现在：助手文本**整段一次写入**（与 A17 之前一致），只保留 ① 的工具事件增量落盘。
    if (text) {
      const message = this.mm.createAssistantMessage({
        content: [{ type: 'text', text }],
        source: { provider: `acp:${this.engine.id}`, model: this.engine.id },
      })
      this.session.append(
        'assistant/message',
        { turn: this._turn, step: this._activeStep, message, stream: [] },
        { surfaceOp: 'append' },
      )
      this._streamedTextLen = text.length
    }
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
        // A17②：曾在此处触发节流落盘，**已回退**（连续 append 会被 UI 折叠、导致中间输出被吞，
        // 见 `_promptOnce` 里的详细说明）。助手文本改为 turn 收尾时整段一次写入。
        this._frames.push({ kind: 'assistant', text: update.content?.text ?? '', time: Date.now() })
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
      // B2：回合进度（UI 诊断行里"第 N 次工具调用 · 最近: … · 已耗时 …"）
      recordToolProgress(this.engine.id, { name: entry.name ?? entry.kind ?? 'tool' })
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
