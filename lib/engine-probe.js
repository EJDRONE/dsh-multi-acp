/**
 * 引擎发现与探测（2026-10-09）—— 支撑【添加自定义 Agent】的两个入口：
 *
 *   · 手动添加：用户填 command/args → `probeCandidate()` 跑一次真实 ACP 握手（initialize）
 *     再决定要不要保存（避免把"不认 ACP 的 CLI"写进引擎表）。
 *   · 通过对话添加：用户给一个线索（如 `qoder` / `kimi` / `aider`）→ `discoverCandidates()`
 *     在 PATH 与已知安装位里找同名候选 → 逐个 `probeCandidate()` → 只把**握手成功**的列出来。
 *
 * 探测用**生产同款**客户端（`lib/acp-client.js`），所以"探测通过 = 会话里也能跑"。
 *
 * @module dsh-multi-acp/engine-probe
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import { AcpClient } from './acp-client.js'
import { expandPathTemplate } from './engines.js'

/** 已知的 ACP 候选（id 仅用于提示；实际还是靠探测说话）。 */
export const KNOWN_ACP_CANDIDATES = [
  { id: 'omp', label: 'omp (oh-my-pi)', commands: ['omp'], args: ['acp'], fallbackPaths: ['%USERPROFILE%\\.omp\\omp.exe'] },
  { id: 'opencode', label: 'OpenCode', commands: ['opencode'], args: ['acp'], fallbackPaths: ['%USERPROFILE%\\opencode\\bin\\opencode.exe'] },
  { id: 'commandcode', label: 'Command Code', commands: ['commandcode', 'command-code'], args: ['acp'], fallbackPaths: ['C:\\nvm4w\\nodejs\\commandcode.cmd'] },
  { id: 'qodercn', label: 'Qoder CLI CN', commands: ['qoder-cn'], args: ['--acp'], fallbackPaths: ['%USERPROFILE%\\.qoder-cn\\entry\\qoder-cn.cmd'] },
  { id: 'gemini', label: 'Gemini CLI', commands: ['gemini'], args: ['--experimental-acp'] },
  { id: 'claude', label: 'Claude Code', commands: ['claude'], args: ['--acp'] },
  { id: 'cursor-agent', label: 'Cursor Agent', commands: ['cursor-agent'], args: ['acp'] },
  { id: 'kimi', label: 'Kimi CLI', commands: ['kimi'], args: ['acp'] },
  { id: 'iflow', label: 'iFlow', commands: ['iflow'], args: ['acp'] },
  { id: 'auggie', label: 'Auggie', commands: ['auggie'], args: ['--acp'] },
  { id: 'goose', label: 'Goose', commands: ['goose'], args: ['acp'] },
]

/** 可执行后缀（Windows 优先 .cmd/.exe；也接受无后缀的 POSIX 风格）。 */
const EXEC_EXTS = ['', '.exe', '.cmd', '.bat', '.ps1']

/** 只在 PATH 目录里做浅层扫描，避免全盘遍历。 */
function pathDirs(env = process.env) {
  return String(env.PATH ?? env.Path ?? '')
    .split(';')
    .filter((d) => d && existsSync(d))
}

/**
 * 把 `command` 解析成可执行文件的绝对路径（PATH 浅扫 + 常见后缀）。
 * 找不到返回 undefined（调用方可以仍然尝试直接用命令行名 spawn）。
 */
export function resolveExecutable(command, env = process.env) {
  if (!command) return undefined
  const expanded = expandPathTemplate(command, env)
  if (/[\\/]/.test(expanded)) {
    for (const ext of EXEC_EXTS) {
      const candidate = expanded + (extname(expanded) ? '' : ext)
      if (existsSync(candidate)) return candidate
    }
    return undefined
  }
  for (const dir of pathDirs(env)) {
    for (const ext of EXEC_EXTS) {
      const candidate = join(dir, command + ext)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch { /* 忽略无权限目录 */ }
    }
  }
  return undefined
}

/**
 * 发现候选：已知表（按 hint 过滤）+ PATH 里名字含 hint 的可执行文件。
 *
 * @param {string} hint 用户给的线索（空 = 只列已知表里能解析到路径的那些）
 * @returns {{id:string,label:string,command:string,args:string[],resolved?:string}[]}
 */
export function discoverCandidates(hint = '', env = process.env) {
  const needle = String(hint ?? '').trim().toLowerCase()
  const out = []
  const seen = new Set()

  for (const known of KNOWN_ACP_CANDIDATES) {
    const haystack = `${known.id} ${known.label} ${known.commands.join(' ')}`.toLowerCase()
    if (needle && !haystack.includes(needle)) continue
    let resolved
    for (const cmd of known.commands) {
      resolved = resolveExecutable(cmd, env)
      if (resolved) break
    }
    if (!resolved) {
      for (const p of known.fallbackPaths ?? []) {
        const expanded = expandPathTemplate(p, env)
        if (existsSync(expanded)) { resolved = expanded; break }
      }
    }
    if (!resolved) continue
    seen.add(resolved.toLowerCase())
    out.push({ id: known.id, label: known.label, command: known.commands[0], args: [...known.args], resolved, source: 'known' })
  }

  // PATH 浅扫：文件名含 hint 的可执行文件（hint 至少 2 个字符才扫，避免列出一堆）
  if (needle.length >= 2) {
    for (const dir of pathDirs(env)) {
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const lower = entry.name.toLowerCase()
        if (!lower.includes(needle)) continue
        if (!EXEC_EXTS.includes(extname(lower))) continue
        const full = join(dir, entry.name)
        if (seen.has(full.toLowerCase())) continue
        seen.add(full.toLowerCase())
        out.push({
          id: basename(lower, extname(lower)),
          label: entry.name,
          command: entry.name,
          args: [],
          resolved: full,
          source: 'path-scan',
        })
      }
    }
  }
  return out.slice(0, 20)
}

/**
 * 跑一次真实 ACP 握手（initialize），用来判断"这个 CLI 到底认不认 ACP"。
 *
 * @returns {Promise<{ok:boolean,ms:number,agentInfo?:object,error?:string,command:string,args:string[]}>}
 */
export async function probeCandidate({ command, args = [], cwd = process.cwd(), timeoutMs = 20000, logger } = {}) {
  const started = Date.now()
  const engine = {
    id: 'probe',
    command,
    resolvedCommand: command,
    args: [...args],
    env: {},
    cwdPolicy: 'session',
    initBudget: { coldProbe: 'none', steadySecs: Math.max(5, Math.round(timeoutMs / 1000)), coldSecs: Math.max(30, Math.round(timeoutMs / 1000)) },
    promptTimeoutMs: 1000,
    disposeGraceMs: 3000,
  }
  const client = new AcpClient({ engine, cwd, logger: logger ?? { debug() {}, info() {}, warn() {}, error() {} }, onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) })
  try {
    await client.start()
    const info = await client.initialize({})
    return { ok: true, ms: Date.now() - started, agentInfo: info?.agentInfo ?? info, command, args }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: String(error?.message ?? error), command, args }
  } finally {
    try { await client.dispose() } catch { /* 忽略 */ }
  }
}
