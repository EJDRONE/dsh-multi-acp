/**
 * 临时诊断追踪（verification 用）。
 *
 * 把 ACP 路由的关键决策追加到 <stateDir>/trace.log，用于回答：
 *   - ctx.agents.factory 是否真的被本插件替换？
 *   - createAgent/resume 收到的 agentPreset 是什么？解析出哪个引擎？
 *   - 是否走了"降级回官方 factory"的分支，原因是什么？
 *
 * 任何异常都被吞掉 —— 追踪绝不能影响主流程。
 * 可用 DSH_MULTI_ACP_TRACE 覆盖输出路径。
 */
import { appendFileSync } from 'node:fs'

const file = process.env.DSH_MULTI_ACP_TRACE || 'D:\\Ecode\\.dsh\\multi-acp\\trace.log'

export function trace(event, data = {}) {
  try {
    appendFileSync(
      file,
      JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, data }) + '\n',
      'utf8',
    )
  } catch {
    /* never break the host */
  }
}
