/**
 * 配置面：Schemastery `Config` + 边界 / 跨字段校验。
 *
 * ── 为什么现在才用 Schemastery（见 docs/adr/0004-schemastery-config.md）
 *
 * 早期版本**刻意回避** schema，理由写在旧注释里：
 *   "宿主用的是 `@deepseek-ai/schemastery`，与公开的 `schemastery` 未必同源 ——
 *    一旦构造期抛错，整个插件就是「启动失败」。"
 *
 * 这个担心成立，但结论错了。正确解法不是放弃 schema，而是：
 *   1. 解析**宿主那一份** `@deepseek-ai/schemastery`（而不是公共 `schemastery` 包）；
 *   2. 解析或构造**失败时不抛** → `Config` 为 `undefined`（Cordis 允许插件无 Config），
 *      同时把失败原因作为**诊断**交出去，由 `apply()` 记日志 —— 是"响亮降级"，
 *      不是静默降级。
 *
 * 实测（2026-10-10）：`@deepseek-ai/schemastery@3.18.4` 可从 profile 解析，
 * 且是 dual 包（`lib/index.cjs` + `lib/index.mjs`），同步 `require` 可用 ——
 * 因此**不需要顶层 await**，不给加载期引入新的失败面。
 *
 * @module dsh-multi-acp/config
 */

import { createRequire } from 'node:module'
import { hostRequire } from './dsh-imports.js'
import { NATIVE_TOOL_GROUPS, normalizeGroups } from './preset-native.js'

/**
 * @typedef {{ level: 'info' | 'warn' | 'error', source: string, message: string }} Diagnostic
 *
 * 归一化之后的配置形状。注意 `presetTools` 在这里**已经是 `string[]`** ——
 * 用户看到的 `true` / `'fs,shell'` 就是被 `normalizeGroups` 收敛到组名的。
 *
 * @typedef {object} NormalizedConfig
 * @property {string} defaultEngine
 * @property {string} stateDir
 * @property {object[]} engines
 * @property {boolean} verboseStartup
 * @property {string[]} presetTools
 * @property {boolean} unsandboxedFs
 * @property {{ enabled: boolean, include: string[], exclude: string[] }} mcp
 * @property {number} promptTimeoutMs
 * @property {number} idleTimeoutMs
 * @property {boolean} permissionModeFromSession
 */

const SCHEMA_PACKAGE = '@deepseek-ai/schemastery'

/**
 * 解析宿主那一份 schemastery；失败返回 `{ schema: null, reason }`。
 *
 * 顺序：**宿主解析根优先**（peer 语义：要用宿主实例），再退回插件自身依赖。
 */
function resolveSchema() {
  const attempts = [
    { where: 'host', load: () => hostRequire()(SCHEMA_PACKAGE) },
    { where: 'plugin', load: () => createRequire(import.meta.url)(SCHEMA_PACKAGE) },
  ]
  const errors = []
  for (const { where, load } of attempts) {
    try {
      const mod = load()
      const schema = mod?.default ?? mod
      if (schema && typeof schema.object === 'function') return { schema, where, errors }
      errors.push(`${where}: 模块形状不对（无 .object）`)
    } catch (error) {
      errors.push(`${where}: ${String(error?.code ?? error?.message ?? error)}`)
    }
  }
  return { schema: null, where: null, errors }
}

/**
 * 配置默认值 —— **唯一的默认值来源**。
 *
 * 这里与 `cordis.patch.yml` 的分工：本文件是"代码默认"，patch 是"部署覆盖"。
 * 两者的差异**必须**写清楚，否则用户看到的行为与代码不符（例如 patch 里把
 * `promptTimeoutMs` 设成 0 = 不限，而代码默认是 300000）。
 */
export const DEFAULT_CONFIG = {
  /** 没有显式 preset 的会话走哪个引擎；`''` = 走官方 DSH agent loop。 */
  defaultEngine: '',
  /** 引擎定义 / 会话映射 / trace 的落盘目录；`''` = `<DSH_HOME>/multi-acp`。 */
  stateDir: '',
  /** 引擎行（最高优先级的来源，便于试验）。 */
  engines: [],
  /** 启动时打印宿主符号自检结果。 */
  verboseStartup: true,
  /** acp-* preset 挂哪些原生工具组：true=全部 / false=只要 marker / 组名数组。 */
  presetTools: true,
  /** 用 entry-local 的 dsh-fs-local 遮蔽宿主 sandboxed fs。 */
  unsandboxedFs: false,
  /** MCP 随会话下发策略。 */
  mcp: { enabled: true, include: [], exclude: [] },
  /** 一次 `session/prompt` 的**总时长闸**（毫秒）；`<= 0` = 不限。 */
  promptTimeoutMs: 300000,
  /** **空闲闸**（毫秒）：多久没有 `session/update` 才算引擎卡死。`0` = 关闭。 */
  idleTimeoutMs: 180000,
  /** 会话权限档 → 引擎 `permissionMode` 的自动映射。 */
  permissionModeFromSession: true,
}

/**
 * 构造 Cordis 读取的 schema。
 *
 * ── 两条设计约束（都来自实测，不是偏好）
 *
 * 1. **Schemastery 不做类型强转**。实测：`promptTimeoutMs: "0"` 直接抛
 *    `ValidationError: $.promptTimeoutMs expected number but got 0`。
 *    而本插件历史上**刻意接受字符串**（旧 `normalizeMillis` 的注释：
 *    "数字直接用，字符串尽力解析"），用户的 YAML 里写带引号的数字是常见写法。
 *    所以这几个字段用 `union` 表达"两种都合法"，具体语义仍由 `normalizeConfig`
 *    收敛 —— schema 管形状，normalize 管语义。
 *
 * 2. **每个字段都有 default，没有 `required()`**。Cordis 的 Loader 会申请 schema；
 *    申请失败即**插件加载失败**，而"启动失败"是本插件最贵的事故形态
 *    （`lib/index.js` 的整个自报错加载器就是为它存在的）。因此 schema 只在
 *    "类型确实写错"时失败，不制造新的必填项。
 *
 * `presetTools` 同样用 `union` 表达它真实接受的三种形态（bool / 组名数组 / 逗号串）。
 */
function buildSchema(S) {
  /** 数字或可解析的数字字符串（见约束 1）。 */
  const millis = () => S.union([S.number(), S.string()])
  /** 布尔或 `'true'`/`'false'` 字符串（旧代码用 `!== false` / `=== 'true'` 判定）。 */
  const booleanish = () => S.union([S.boolean(), S.string()])

  return S.object({
    defaultEngine: S.string().default(DEFAULT_CONFIG.defaultEngine),
    stateDir: S.string().default(DEFAULT_CONFIG.stateDir),
    engines: S.array(S.any()).default(DEFAULT_CONFIG.engines),
    verboseStartup: booleanish().default(DEFAULT_CONFIG.verboseStartup),
    presetTools: S.union([S.boolean(), S.string(), S.array(S.string())]).default(DEFAULT_CONFIG.presetTools),
    unsandboxedFs: booleanish().default(DEFAULT_CONFIG.unsandboxedFs),
    mcp: S.object({
      enabled: booleanish().default(DEFAULT_CONFIG.mcp.enabled),
      include: S.array(S.string()).default(DEFAULT_CONFIG.mcp.include),
      exclude: S.array(S.string()).default(DEFAULT_CONFIG.mcp.exclude),
    }).default(DEFAULT_CONFIG.mcp),
    promptTimeoutMs: millis().default(DEFAULT_CONFIG.promptTimeoutMs),
    idleTimeoutMs: millis().default(DEFAULT_CONFIG.idleTimeoutMs),
    permissionModeFromSession: booleanish().default(DEFAULT_CONFIG.permissionModeFromSession),
  })
}

const resolved = resolveSchema()

/** 供 `apply()` 记日志的诊断（schema 能/不能建立，以及为什么）。 */
export const schemaDiagnostics = []

let builtSchema
if (resolved.schema) {
  try {
    builtSchema = buildSchema(resolved.schema)
  } catch (error) {
    schemaDiagnostics.push({
      level: 'warn',
      source: 'config',
      message:
        `Schemastery schema 构造失败（${SCHEMA_PACKAGE} 来自 ${resolved.where}）：` +
        `${String(error?.message ?? error)} —— 退回纯 JS 归一化。`,
    })
  }
} else {
  schemaDiagnostics.push({
    level: 'warn',
    source: 'config',
    message:
      `未解析到宿主 ${SCHEMA_PACKAGE}（${resolved.errors.join('; ')}）—— ` +
      '跳过 schema 校验，改用纯 JS 归一化（配置仍会被校验，只是错误发现得晚一些）。',
  })
}

/** Cordis 读取的 `Config`；不可用时为 `undefined`（Cordis 允许插件不带 Config）。 */
export const Config = builtSchema

/** 归一化"毫秒"配置：数字直接用，字符串尽力解析，非法值回落到 `fallback`。 */
function normalizeMillis(raw, fallback) {
  if (raw === undefined || raw === null) return fallback
  const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
  return Number.isFinite(value) ? value : fallback
}

/** 归一化 MCP 注入配置：`{enabled, include, exclude}`（也容忍 `false` / `true`）。 */
function normalizeMcpConfig(raw, diagnostics) {
  if (raw === false) return { enabled: false, include: [], exclude: [] }
  if (raw === true || raw === undefined || raw === null) return { ...DEFAULT_CONFIG.mcp }
  if (typeof raw !== 'object') {
    diagnostics.push({ level: 'warn', source: 'config', message: `mcp 期望对象/布尔，收到 ${typeof raw} —— 用默认值。` })
    return { ...DEFAULT_CONFIG.mcp }
  }
  return {
    enabled: raw.enabled !== false,
    include: Array.isArray(raw.include) ? raw.include.map(String) : [],
    exclude: Array.isArray(raw.exclude) ? raw.exclude.map(String) : [],
  }
}

/**
 * 把（可能来自 loader / patch / 直接调用的）任意配置归一化。
 *
 * **即使在 schema 生效时也仍然执行** —— schema 保证"类型对"，这里保证
 * "跨字段关系对"以及"未知输入不会炸"。两条路径收敛到同一份结果。
 *
 * @returns {{ config: NormalizedConfig, diagnostics: Diagnostic[] }}
 */
export function normalizeConfig(raw) {
  /** @type {Diagnostic[]} */
  const diagnostics = []
  const cfg = raw && typeof raw === 'object' ? raw : {}
  if (raw !== undefined && raw !== null && typeof raw !== 'object') {
    diagnostics.push({
      level: 'warn',
      source: 'config',
      message: `配置期望对象，收到 ${typeof raw} —— 全部用默认值。`,
    })
  }

  const config = {
    defaultEngine: typeof cfg.defaultEngine === 'string' ? cfg.defaultEngine : DEFAULT_CONFIG.defaultEngine,
    stateDir: typeof cfg.stateDir === 'string' ? cfg.stateDir : DEFAULT_CONFIG.stateDir,
    engines: Array.isArray(cfg.engines) ? cfg.engines : DEFAULT_CONFIG.engines,
    verboseStartup: cfg.verboseStartup !== false,
    presetTools: normalizeGroups(cfg.presetTools),
    unsandboxedFs: cfg.unsandboxedFs === true || cfg.unsandboxedFs === 'true',
    mcp: normalizeMcpConfig(cfg.mcp, diagnostics),
    promptTimeoutMs: normalizeMillis(cfg.promptTimeoutMs, DEFAULT_CONFIG.promptTimeoutMs),
    idleTimeoutMs: normalizeMillis(cfg.idleTimeoutMs, DEFAULT_CONFIG.idleTimeoutMs),
    permissionModeFromSession: cfg.permissionModeFromSession !== false,
  }

  reportDroppedGroups(cfg.presetTools, diagnostics)
  diagnostics.push(...validateCrossField(config))
  return { config, diagnostics }
}

/**
 * `presetTools` 里的**未知组名过去是被静默丢掉的**（`normalizeGroups` 只保留
 * `NATIVE_TOOL_GROUPS` 里的名字）。用户写了 `['fs','shell','mcp']` 会得到一个
 * 没有报错、也没有 mcp 工具组的会话 —— 这正是"静默降级"，必须变成可见的诊断。
 */
function reportDroppedGroups(raw, diagnostics) {
  if (raw === undefined || raw === null || raw === true || raw === false) return
  const list = Array.isArray(raw) ? raw : String(raw).split(',')
  const unknown = list.map((v) => String(v).trim()).filter((v) => v && !NATIVE_TOOL_GROUPS.includes(v))
  if (unknown.length > 0) {
    diagnostics.push({
      level: 'warn',
      source: 'config',
      message:
        `presetTools 含未知分组 [${unknown.join(', ')}]，已忽略 —— ` +
        `可用分组：${NATIVE_TOOL_GROUPS.join(' / ')}。`,
    })
  }
}

/**
 * 跨字段 / 边界校验 —— schema 表达不了的关系放这里。
 *
 * 每一条都是"配置看起来合法、行为却与直觉相反"的情况。
 *
 * @param {NormalizedConfig} config
 * @returns {Diagnostic[]}
 */
export function validateCrossField(config) {
  /** @type {Diagnostic[]} */
  const out = []

  // 总时长闸短于空闲闸 ⇒ 空闲闸永远不会生效，等于把 A16 修的东西又退回墙钟误杀。
  // 实测教训：session-503ea973 里 omp 完成 21 次工具调用、仍在思考时被 300s 掐断。
  if (config.promptTimeoutMs > 0 && config.idleTimeoutMs > 0 && config.promptTimeoutMs < config.idleTimeoutMs) {
    out.push({
      level: 'warn',
      source: 'config',
      message:
        `promptTimeoutMs(${config.promptTimeoutMs}) < idleTimeoutMs(${config.idleTimeoutMs})：` +
        '总时长闸会先触发，空闲闸形同虚设 —— 长任务可能被误杀。建议 promptTimeoutMs = 0（不限）。',
    })
  }

  if (config.promptTimeoutMs > 0 && config.promptTimeoutMs > 0 && config.idleTimeoutMs === 0) {
    out.push({
      level: 'warn',
      source: 'config',
      message: 'idleTimeoutMs = 0 关闭了空闲判定，只剩墙钟闸：卡死的引擎会一直占着会话。',
    })
  }

  const both = config.mcp.include.filter((n) => config.mcp.exclude.includes(n))
  if (both.length > 0) {
    out.push({
      level: 'warn',
      source: 'config',
      message: `mcp.include 与 mcp.exclude 同时含 [${both.join(', ')}] —— exclude 优先，这些连接不会下发。`,
    })
  }

  if (config.mcp.enabled && config.mcp.include.length > 0 && config.mcp.exclude.length > 0) {
    out.push({
      level: 'info',
      source: 'config',
      message: 'mcp.include 与 mcp.exclude 同时生效：先按 include 收窄，再排除 exclude。',
    })
  }

  if (config.engines.length > 0 && !Array.isArray(config.engines)) {
    out.push({ level: 'error', source: 'config', message: 'engines 必须是数组。' })
  }

  return out
}
