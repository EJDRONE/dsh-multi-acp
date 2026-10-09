/**
 * 会话权限档 → 引擎 `permissionMode` 映射（2026-10-10）。
 *
 * ── 为什么需要 ────────────────────────────────────────────────────────────
 * DSH 的权限档（【仅可查看】/【工作区内修改】/【完全权限】）写的是 `sandbox/mode` +
 * `approval/policy` 两个旋钮，**管的是 DSH 自己的工具**。ACP 会话里 shell/写盘是**引擎自己的**
 * 工具，DSH 只能通过 ACP `session/request_permission` 参与"批不批"。
 *
 * 实测（2026-10-10 `session-8a6cb2e1`）：定时任务里 11 次审批 **11 次 rejected** ——
 * 因为请求里的"工具"是引擎给的整条命令行（`curl.exe -s -o /dev/null …`），DSH 的策略引擎
 * 认不出它，只能"问人"；无人值守 ⇒ 拒。切到【完全权限】后第二轮仍全拒 ⇒ **档位不会自动放行引擎侧请求**。
 *
 * 所以把两者**接通**：建 ACP agent 时读会话的 `permissions` 投影
 * （`dsh-permission-presets` 的 `KnobState = {preset, sandbox, approval}`），按下面的表决定
 * 本次会话该用哪个 `permissionMode` 启动引擎。
 *
 * ── 映射表 ────────────────────────────────────────────────────────────────
 *   danger-full-access（完全权限）   → `dont_ask`（引擎行支持时优先 bypass 之外的最宽档）
 *   workspace-write（工作区内修改）  → 保持引擎默认（照常询问）+ 无人值守提示
 *   read-only（仅可查看）           → 保持默认 + 明确告警（ACP 没有"只读引擎"语义，
 *                                     不能假装受限）
 *   custom / 未记录                  → 保持默认
 *
 * @module dsh-multi-acp/permission-bridge
 */

/** 会话档位 → 期望的引擎权限档（`null` = 不改动）。 */
const PRESET_TO_MODE = {
  'danger-full-access': 'dont_ask',
  'workspace-write': null,
  'read-only': null,
}

/**
 * 从会话投影里读权限档。
 *
 * @param {object|undefined} projections DSH 的 `ctx.sessionProjections`
 * @param {object} session 会话对象
 * @returns {{preset:string|null, sandbox:string|null, approval:string|null}|null}
 */
export function readSessionPermissions(projections, session) {
  try {
    const state = projections?.stateOf?.(session, 'permissions')
    if (!state || typeof state !== 'object') return null
    return {
      preset: typeof state.preset === 'string' ? state.preset : null,
      sandbox: typeof state.sandbox === 'string' ? state.sandbox : null,
      approval: typeof state.approval === 'string' ? state.approval : null,
    }
  } catch {
    return null
  }
}

/**
 * 计算"本次会话该用哪个权限档启动引擎"。
 *
 * @param {object} args
 * @param {{preset:string|null}|null} args.permissions 会话权限档（`readSessionPermissions` 的结果）
 * @param {object} args.engine 引擎行（用它声明的 `permissionTemplates` 判断能不能落到想要的那档）
 * @param {boolean} [args.enabled=true] 插件配置 `permissionModeFromSession`
 * @param {(engine:object)=>string[]} args.supported 支持档位查询（注入以便测试）
 * @returns {{mode:string|null, wanted:string|null, reason:string, warn:string|null}}
 *   `mode` = 要覆盖成的档（`null` = 不改）；`wanted` = 表面上想要的档（用于 UI/日志说明）
 */
export function mapPresetToMode({ permissions, engine, enabled = true, supported = () => ['default'] }) {
  const preset = permissions?.preset ?? null
  if (!enabled) return { mode: null, wanted: null, reason: 'disabled', warn: null }
  if (!preset) return { mode: null, wanted: null, reason: 'no-preset', warn: null }

  const wanted = PRESET_TO_MODE[preset] ?? null
  if (!wanted) {
    // workspace-write / read-only / custom：不动引擎配置，但把"会发生什么"讲清楚
    if (preset === 'read-only') {
      return {
        mode: null,
        wanted: null,
        reason: 'read-only-unsupported',
        warn:
          '会话档位是【仅可查看】，但 ACP 没有"只读引擎"语义 —— 引擎仍可能写文件/执行命令；' +
          '需要真正只读请别用引擎会话。',
      }
    }
    if (preset === 'workspace-write') {
      return {
        mode: null,
        wanted: null,
        reason: 'workspace-write-asks',
        warn:
          '会话档位是【工作区内修改】：引擎会照常发权限请求。交互会话可点批准；' +
          '**无人值守（定时任务）会一律被拒** —— 那种场景请把引擎的「权限模式」设为 dont_ask。',
      }
    }
    return { mode: null, wanted: null, reason: `unmapped:${preset}`, warn: null }
  }

  const modes = supported(engine)
  if (!modes.includes(wanted)) {
    // 引擎没声明这一档（例如 omp/opencode/command-code 目前没有权限模板）→ 保持默认并告警
    return {
      mode: null,
      wanted,
      reason: 'engine-unsupported',
      warn:
        `会话档位是【完全权限】，但引擎「${engine.id}」没声明 ${wanted} 的启动参数，` +
        '仍会照常询问（无人值守会被拒）。可在【覆盖启动方式 → args】手填，或换支持该档的引擎。',
    }
  }
  return { mode: wanted, wanted, reason: 'mapped', warn: null }
}

/**
 * 把映射结果应用到一个引擎行上，得到"本次会话专用"的引擎变体。
 *
 * `poolKey` 让宿主池不再复用同一个进程（免问 / 询问必须分开，见 acp-host.js#get）。
 * 其余字段（尤其 `id`）保持不变 —— `id` 还用于 preset、session-map、事件 source。
 */
export function applyPermissionMode(engine, mode) {
  if (!mode || mode === engine.permissionMode) return engine
  return { ...engine, permissionMode: mode, poolKey: `${engine.id}#${mode}`, permissionModeFrom: 'session' }
}
