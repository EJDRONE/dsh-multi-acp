/**
 * `dshSessionId` ↔ `acpSessionId` 映射（A4）。
 *
 * 为什么需要它：ACP 引擎的会话上下文只认**它自己的** sessionId；DSH 重启后要
 * resume 同一会话，必须先找回 `dshSessionId` 对应的 `acpSessionId`
 * （`session/load` 需要它）。该映射不进 DSH profile（那是 pnpm 管理的），
 * 而放在本插件自己的 `stateDir`。
 *
 * 文件：`<stateDir>/sessions.json`
 * 形状：`{ "sessions": { "<dshSessionId>": { engineId, acpSessionId, cwd, updatedAt } } }`
 *
 * @module dsh-multi-acp/session-map
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** `<stateDir>/sessions.json` 的绝对路径。 */
function fileOf(stateDir) {
  return join(stateDir, 'sessions.json')
}

/**
 * 读取映射（任何异常都退化为空表，绝不抛出）。
 * @param {string} stateDir
 * @returns {Record<string, { engineId?: string, acpSessionId?: string, cwd?: string, updatedAt?: string }>}
 */
export function readSessionMap(stateDir) {
  if (!stateDir) return {}
  const file = fileOf(stateDir)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const sessions = parsed?.sessions
    return sessions !== null && typeof sessions === 'object' ? sessions : {}
  } catch {
    return {}
  }
}

/**
 * 写入/更新一条映射（先写 `.tmp` 再 rename，避免半写）。
 * 写失败只影响"重启后 resume"，因此**不抛出**。
 * @param {string} stateDir
 * @param {string} dshSessionId
 * @param {{ engineId?: string, acpSessionId?: string, cwd?: string }} entry
 *   `updatedAt` 由本函数写入（ISO 时间戳），调用方不必传。
 */
export function writeSessionMap(stateDir, dshSessionId, entry) {
  if (!stateDir || dshSessionId === undefined || dshSessionId === null) return
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    const all = readSessionMap(stateDir)
    all[String(dshSessionId)] = { ...entry, updatedAt: new Date().toISOString() }
    const file = fileOf(stateDir)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ sessions: all }, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch {
    /* 映射写失败不影响主流程 */
  }
}
