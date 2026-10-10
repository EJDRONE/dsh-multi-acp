/**
 * 宿主契约探测与错误分类。
 *
 * 从 `acp-agent.js` 抽出来的第一个切片（Q6 批次二）。抽它的理由：
 *   · **自包含** —— 只依赖 `dsh-imports.js`，不闭包任何运行时状态；
 *   · **边界清楚** —— 回答的是"宿主是否满足我们需要的形状"，与"怎么装配 agent"是两件事；
 *   · **能被测试** —— `test/plugin-smoke.test.mjs` 里已有一条断言它的**报告形状**必须带
 *     解析来源与版本（Q5d）。
 * 抽它**不触碰任何运行时路径语义**（调用方按名字 import），因此不需要真实会话护航。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️ 本模块产出的每条结论都必须带「解析上下文」——见 `docs/adr/0003-host-package-resolution.md`。
 *
 * 宿主进程内与宿主外（裸 node / 验证脚本）会命中**不同**的宿主树
 * （实测：宿主内 0.2.0-rc.2，宿主外 0.1.1-rc.2）。只报"缺什么"而不报"对谁说的"，
 * 会产出**假阴性** —— 2026-10-10 已真实发生过一次（`probeHostSymbols` 报
 * `dsh-llm` 缺 `AssistantStreamAccumulator`，而该符号在 0.2.0-rc.2 里存在）。
 *
 * @module dsh-multi-acp/agent-contract
 */

import { importFromDsh, resolveHostPackage, expectedHostVersion } from './dsh-imports.js'

/**
 * 区分"我们明知做不到"与"意外崩了"。
 *
 * 前者应当明确报错（用户需要看到原因），后者应当降级兜底（保住普通会话）。
 * 用错误名前缀标记，避免依赖 message 文本匹配。
 */
export function isExplicitAcpFailure(error) {
  return error?.name === 'MultiAcpContractError' || error?.name === 'MultiAcpUnavailableError'
}

/**
 * 单写所有权冲突（A10）：会话的写句柄还在别人手里。
 *
 * 官方 resume 走 `persistence.prepare()`，我们走 `persistence.open(id,'write')`，
 * 两者都会撞上这条；报错文本由 dsh-session-persistence 给出。
 */
export function isWriteHandleConflict(error) {
  return /already owned by an active write handle/i.test(String(error?.message ?? error))
}

/** 契约不满足 —— 「我们明知自己没准备好」，必须让用户看到，不降级。 */
export function contractError(message) {
  const error = new Error(message)
  error.name = 'MultiAcpContractError'
  return error
}

/**
 * 我们需要的宿主导出。**每一项都对应一次真实的契约事故**，不是想当然的清单：
 *   · `dsh-session` 的 `SessionPreparation` / `interruptedTurnClosers`：surface 与 repair 语义；
 *   · `dsh-scope` 的 `createScope`：`agent.ctx` 必须是 scoped（否则 mount 抛错，见 A7）；
 *   · `dsh-llm` 的四个消息构造器 + `AssistantStreamAccumulator` + `errorChain`：
 *     我们替宿主组装 assistant/tool-result 消息与 stream。
 */
const REQUIRED_HOST_EXPORTS = [
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

/** 缓存：契约不满足是**致命**的，成功一次就没必要每次建 agent 都重探。 */
let cached = null

/**
 * 探测宿主契约。**不抛异常** —— 把"缺什么"交给调用方决定怎么呈现。
 *
 * @param {{ refresh?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, report: object[], scope: string, message?: string }>}
 */
export async function assertAgentContract({ refresh = false } = {}) {
  if (cached && !refresh) return cached

  const expected = expectedHostVersion().version
  const report = []
  for (const { pkg, names } of REQUIRED_HOST_EXPORTS) {
    const probe = resolveHostPackage(pkg)
    try {
      const mod = await importFromDsh(pkg)
      const missing = names.filter((n) => mod[n] === undefined)
      report.push({
        pkg,
        missing,
        ok: missing.length === 0,
        resolved: probe.resolved,
        version: probe.version,
        expected,
        trustHost: probe.ok && probe.version !== undefined && probe.version === expected,
      })
    } catch (error) {
      report.push({
        pkg,
        missing: names,
        ok: false,
        resolved: probe.resolved,
        version: probe.version,
        expected,
        trustHost: false,
        error: String(error?.message ?? error),
      })
    }
  }

  /** 一句话说清"这次探测对着谁" —— 不匹配时必须让调用方知道结论不可用于验收。 */
  const scope = report.every((r) => r.trustHost)
    ? `宿主 ${expected}`
    : `⚠️ 版本不匹配（解析到 ${[...new Set(report.map((r) => r.version ?? '?'))].join(', ')}，` +
      `期望 ${expected ?? '未知'}）—— 本次结论**不代表宿主**，请在宿主进程内复跑`

  const bad = report.filter((r) => r.ok === false)
  cached = bad.length
    ? {
        ok: false,
        report,
        scope,
        message:
          'dsh-multi-acp: host contract not satisfied — cannot create an ACP root agent:\n' +
          `  ${scope}\n` +
          bad.map((b) => `  • ${b.pkg}: missing [${b.missing.join(', ')}]${b.error ? ` — ${b.error}` : ''}`).join('\n'),
      }
    : { ok: true, report, scope }
  return cached
}
