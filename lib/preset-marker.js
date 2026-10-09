/**
 * Preset marker 插件。
 *
 * 每个引擎的 preset 组合里**只有这一行**。它把"本预设属于 multi-acp 的哪个引擎"
 * 携带进 preset 的 mount context，供 MultiAcpRouterFactory 在创建 agent 时识别。
 *
 * 📖 参考：dsh-grok-acp 的 presets/grok-build/agent.cordis.yml 就是一个
 *    `{ id, name: 'dsh-grok-acp/preset-marker', config }` 的单行组合。
 *
 * ⚠️ 注意（来自 0.2.0-rc.2 的强制审计）：
 *    preset 内的**服务行**必须放在带 `isolate` realm 的组里，否则挂载后
 *    会被审计拒绝并报：
 *      `preset "..." published process-global service(s) [...] after its mount was audited`
 *    本 marker **不发布任何服务**，只记录标记，因此无需 isolate 组。
 *
 * @module dsh-multi-acp/preset-marker
 */
/**
 * ⚠️ 刻意不使用 schemastery 构造 Config。
 *
 * 本模块处于**插件加载期的 import 链**上（acp-agent.js 会 import 它的 readMarker），
 * 而宿主用的是 `@deepseek-ai/schemastery`，与公开 `schemastery` 未必同源 ——
 * 一旦这里抛错，整个插件就是「启动失败」。
 * Cordis 允许插件不带 Config，engineId 由读 marker 的一方自行校验。
 */
export const name = 'dsh-multi-acp/preset-marker'

/**
 * 标记注册表：preset 挂载时把 engineId 记到 agent 的 ctx 上。
 * 用 WeakMap 而不是全局变量，避免多会话串味。
 */
export const markers = new WeakMap()

export function apply(ctx, config) {
  markers.set(ctx, config.engineId)
}

/** 从 agent 的 ctx 上读取引擎 id（沿 ctx 链向上找）。 */
export function readMarker(agentCtx) {
  let current = agentCtx
  while (current) {
    const hit = markers.get(current)
    if (hit !== undefined) return hit
    current = current.parent
  }
  return undefined
}
