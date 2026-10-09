/**
 * Preset 与引擎 id 的双向映射。
 *
 * 单独成模块是为了避免 index.js ↔ acp-agent.js 的循环 import。
 *
 * @module dsh-multi-acp/preset-ids
 */

export const PRESET_ID_PREFIX = 'acp-'

/** 引擎 id → preset id */
export const presetIdFor = (engineId) => `${PRESET_ID_PREFIX}${engineId}`

/** preset id → 引擎 id（不属于本插件的 preset 返回 undefined） */
export const engineIdFromPreset = (presetId) =>
  typeof presetId === 'string' && presetId.startsWith(PRESET_ID_PREFIX)
    ? presetId.slice(PRESET_ID_PREFIX.length)
    : undefined
