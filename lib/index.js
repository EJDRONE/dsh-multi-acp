/**
 * 自报错加载器（diagnostic loader）
 *
 * 目的：把「启动失败」变成**可读的错误堆栈**。
 *
 * 原理：
 *   - Cordis 只做**静态** import 时，模块求值期抛错是无法捕获的 —— 插件直接「启动失败」。
 *   - 本文件保持自身极简（不含任何可能抛错的代码），然后**动态 import()** 真实实现。
 *   - 动态 import 的失败是**可捕获**的 Rejection → 能把 error + stack 写进文件。
 *
 * 因此无论真实实现在哪个模块、哪一行炸掉，都能拿到确切位置。
 *
 * 真实实现位于 `lib/index.impl.js`。
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-multi-acp'

/**
 * 静态声明，保证 Cordis 在加载期就能看到。
 *
 * ⚠️ 2026-10-09 起**必须**含 `tools` / `systemPrompt` / `llm`：`lib/index.impl.js` 用
 * `createScope(rootCtx, agent)` 造 agent 的 scoped ctx，而 dsh-scope 的注释写明
 * "the scoped context **inherits the minting plugin's dependency API**" —— 这里少声明一个，
 * 别的插件（如 `dsh-experimental-tool-agent-team`）访问 `agent.ctx.systemPrompt` 就会
 * `cannot get property … without inject`，把宿主进程直接带崩（见 index.impl.js 的详注）。
 */
export const inject = ['agents', 'agentPresets', 'sessions', 'commands', 'tools', 'systemPrompt', 'llm']

const OUT_DIR = join(process.env.DSH_HOME || '.', 'multi-acp')
const OUT_FILE = join(OUT_DIR, 'load-report.txt')

function report(text) {
  try {
    if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(OUT_FILE, text, 'utf8')
  } catch {
    /* 连写文件都失败就没办法了 */
  }
}

export async function apply(ctx, config) {
  const t0 = Date.now()
  let stage = 'start'
  try {
    report(`loader: apply entered at ${new Date().toISOString()}\n`)

    stage = 'import ./index.impl.js'
    const impl = await import('./index.impl.js')
    report(`loader: impl imported OK (${Date.now() - t0}ms)\n`)

    stage = 'impl.apply()'
    const result = await impl.apply(ctx, config)
    report(
      `loader: impl.apply() returned OK (${Date.now() - t0}ms)\n` +
        `result: ${String(result)}\n` +
        `loader-rev: v2-trace-probe\n`,
    )
    return result
  } catch (error) {
    const detail =
      `loader: FAILED at stage "${stage}" after ${Date.now() - t0}ms\n` +
      `\n=== error ===\n` +
      `${error?.name ?? '(no name)'}: ${error?.message ?? String(error)}\n` +
      `\n=== stack ===\n` +
      `${error?.stack ?? '(no stack)'}\n` +
      (error?.cause ? `\n=== cause ===\n${error.cause?.stack ?? String(error.cause)}\n` : '')
    report(detail)
    ctx.logger?.error?.(`dsh-multi-acp: ${detail}`)
    throw error
  }
}
