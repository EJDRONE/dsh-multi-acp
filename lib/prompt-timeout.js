/**
 * prompt 超时判定（2026-10-10，A16）—— 纯函数，便于单测。
 *
 * ── 为什么改成"双闸" ─────────────────────────────────────────────────────
 * 实测（`session-503ea973`，定时任务跑 acp-omp 的新闻采集）：omp 一口气做了
 * **21 次工具调用**（execute 13 / read 6 / fetch 2）全成功，仍在持续吐
 * `agent_thought_chunk`，却被我们的**墙钟 300s** 掐断：
 *   `acp[omp]: session/prompt: timed out after 300s (last engine update 0s ago: agent_thought_chunk " pinned")`
 * —— "最后一次 update 是 0 秒前"说明它**正在干活**。墙钟上限会把长任务误杀。
 *
 * 所以改成两个闸：
 *   · **空闲闸**（`idleTimeoutMs`，默认 180s）：多久**没有任何 session/update** 才算卡死 → 主闸；
 *   · **总时长闸**（`promptTimeoutMs`，默认 **0 = 不限**）：仍可显式设置上限，防极端情况。
 * 任一触发都会带上"最后一次引擎 update"的摘要（A11-2 的诊断）。
 *
 * @module dsh-multi-acp/prompt-timeout
 */

export const DEFAULT_IDLE_TIMEOUT_MS = 180_000

/**
 * 判断当前是否该中断 prompt。
 *
 * @returns {{kind:'idle'|'overall', idleMs:number, elapsedMs:number, message:string}|null}
 */
export function evaluateTimeout({ startedAt, lastActivityAt, now = Date.now(), overallMs = 0, idleMs = 0 }) {
  const activity = typeof lastActivityAt === 'number' && lastActivityAt > 0 ? lastActivityAt : startedAt
  const idleFor = now - activity
  const elapsed = now - startedAt

  if (idleMs > 0 && idleFor >= idleMs) {
    return {
      kind: 'idle',
      idleMs: idleFor,
      elapsedMs: elapsed,
      message: `no session/update from the engine for ${Math.round(idleFor / 1000)}s (engine looks stuck)`,
    }
  }
  if (overallMs > 0 && elapsed >= overallMs) {
    return {
      kind: 'overall',
      idleMs: idleFor,
      elapsedMs: elapsed,
      message: `timed out after ${Math.round(elapsed / 1000)}s (overall cap; last engine update ${Math.round(idleFor / 1000)}s ago)`,
    }
  }
  return null
}
