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

const DEFAULT_FILE = 'D:\\Ecode\\.dsh\\multi-acp\\trace.log'

/**
 * 解析本次要写的文件。**每次调用都读**（不是在模块加载期读一次），
 * 这样测试/脚本可以在 import 之后重定向或关掉它。
 *
 * - `DSH_MULTI_ACP_TRACE` 环境变量优先；
 * - 显式设为 `''` / `0` / `off` → **关闭**；
 * - 兜底：**在 `node:test` 下绝不写默认路径**（运行器会设置 `NODE_TEST_CONTEXT`）。
 *
 * ⚠️ 这三条都是**事故修来的**（2026-10-10，见 docs/ISSUES.md ISSUE-18）：
 * 本模块曾在**加载期**把路径定死成生产路径，于是 `npm test` 与任何用假 ctx 调
 * `apply()` 的脚本会把**假宿主的事件写进用户的真 trace.log**。最典型的是测试
 * 故意构造的 `{ target: 'not-a-factory' }` —— 它在真机上读起来就是
 * `install.factory-bad-shape {shape:"object{target:string(not-a-factory)}"}`，
 * 让人断定"宿主返回了无法识别的形状"，从而去考虑放宽一项**本来不该动**的保守策略。
 * 诊断数据被自己的测试污染，比没有诊断更糟。
 */
function resolveFile() {
  const raw = process.env.DSH_MULTI_ACP_TRACE
  if (raw !== undefined) {
    const value = String(raw).trim()
    return value === '' || value === '0' || value.toLowerCase() === 'off' ? null : value
  }
  if (process.env.NODE_TEST_CONTEXT) return null
  return DEFAULT_FILE
}

export function trace(event, data = {}) {
  try {
    const file = resolveFile()
    if (!file) return
    appendFileSync(
      file,
      JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, data }) + '\n',
      'utf8',
    )
  } catch {
    /* never break the host */
  }
}
