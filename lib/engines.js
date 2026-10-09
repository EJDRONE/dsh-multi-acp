/**
 * 引擎注册表 —— 本插件的核心设计：**引擎是数据行，不是代码**。
 *
 * 所有 command/args 取值均来自 2026-10-07 的本机实测（见 docs/ENGINE-SPEC.md §8）。
 * 新增一个引擎 = 往 BUILTIN 或 <stateDir>/engines.json 里加一行。
 *
 * @module dsh-multi-acp/engines
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, readdirSync } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'

/** 默认握手预算（📖 借自 AionCore acp_init_budget.rs 的实测取值） */
const DEFAULT_INIT_BUDGET = { steadySecs: 30, coldSecs: 300, coldProbe: 'none' }

/**
 * 内置引擎。
 *
 * ⚠️ `commandOverrides.windows` 是本机实测值。其他机器上路径可能不同 ——
 *    解析顺序为：用户配置 > 内置 overrides > PATH 查找（见 resolveCommand）。
 */
export const BUILTIN = [
  {
    // 实测：579ms 握手 / 5.2s 往返；唯一支持 MCP over SSE；复用 ~/.omp 本地凭据
    id: 'omp',
    label: { zh: 'omp（oh-my-pi）', en: 'omp (oh-my-pi)' },
    description: {
      zh: '三个候选中最快、ACP 实现最完整；复用 ~/.omp 本地凭据，无需重新登录。',
      en: 'Fastest and most complete ACP implementation of the three; reuses ~/.omp local credentials.',
    },
    // ISSUE-02：内置只用**裸命令**交给 PATH / 常见安装位解析；本机绝对路径不再写死在源码里。
    command: 'omp',
    fallbackPaths: ['%LOCALAPPDATA%\\omp\\omp.exe', '%USERPROFILE%\\.omp\\bin\\omp.exe', '%APPDATA%\\npm\\omp.cmd'],
    args: ['acp'],
    env: {},
    cwdPolicy: 'session',
    initBudget: DEFAULT_INIT_BUDGET,
    dialect: 'canonical',
    disposeGraceMs: 6000,
    idleDisposeMs: 30000,
    enabled: true,
    sortOrder: 10,
    // 权限档（实测取自 `omp --help`）：
    //   --auto-approve                "Auto-approve all tool calls (skip approval prompts)"
    //   --approval-mode=<value>       always-ask | write | yolo
    // 注意：交互会话用默认档；定时任务/无人值守建议在 UI 里选 dont_ask（否则 DSH 没人批 → 全拒）。
    permissionMode: 'default',
    permissionTemplates: {
      dont_ask: ['--auto-approve'],
      bypass: ['--approval-mode', 'yolo'],
    },
  },
  {
    // 实测：782ms / 15.8s；能力最宽（session/delete、additionalDirectories）；可 per-session 切模型
    id: 'opencode',
    label: { zh: 'OpenCode', en: 'OpenCode' },
    description: {
      zh: '能力最宽（session/fork、session/delete、additionalDirectories）；支持 per-session 切换模型。',
      en: 'Widest capabilities; supports per-session model switching.',
    },
    command: 'opencode',
    fallbackPaths: [
      '%USERPROFILE%\\.opencode\\bin\\opencode.exe',
      '%LOCALAPPDATA%\\opencode\\bin\\opencode.exe',
      '%APPDATA%\\npm\\opencode.cmd',
    ],
    args: ['acp'],
    env: {},
    // ISSUE-01：OpenCode 默认模型是**付费**模型（实测默认 `opencode-go/claude-haiku-5-5`
    // 触发 "Insufficient account funds"）。预置一个免费模型，避免"选了就坏"。
    // 可在 `<stateDir>/engines.json` 覆盖；若该模型被下架，切换失败只记警告、不影响会话。
    initialConfigOptions: [{ configId: 'model', value: 'opencode/nemotron-3.5-lightning-free' }],
    cwdPolicy: 'session',
    initBudget: DEFAULT_INIT_BUDGET,
    dialect: 'canonical',
    disposeGraceMs: 6000,
    idleDisposeMs: 30000,
    enabled: true,
    sortOrder: 20,
    // 权限档（实测取自 `opencode --help`）：
    //   --auto   "Auto-approve permissions that are not explicitly denied"
    // 它没有更宽的"完全跳过"档，所以只声明 dont_ask（bypass 不声明 → UI 里该档禁用）。
    permissionMode: 'default',
    permissionTemplates: {
      dont_ask: ['--auto'],
    },
  },
  {
    // 实测：3130ms / 19.3s；5 档原生权限 mode；.ps1 shim 需经 pwsh -File
    id: 'commandcode',
    label: { zh: 'Command Code', en: 'Command Code' },
    description: {
      zh: '5 档原生权限 mode（default / auto-accept / plan / dont-ask / bypass）。',
      en: 'Five native permission modes.',
    },
    // ISSUE-03：真实 CLI 名是 `commandcode`（不是 `cmd`）；`.ps1`/`.cmd` shim 由 resolveSpawn 处理。
    command: 'commandcode',
    fallbackPaths: ['%APPDATA%\\npm\\commandcode.cmd', '%APPDATA%\\npm\\commandcode.ps1'],
    args: ['acp'],
    env: {},
    cwdPolicy: 'session',
    initBudget: DEFAULT_INIT_BUDGET,
    dialect: 'canonical',
    disposeGraceMs: 6000,
    idleDisposeMs: 30000,
    enabled: true,
    sortOrder: 30,
    // 2026-10-09：Command Code **不会**自扫 `~/.agents/skills`，需要 `--skill <dir>` 显式挂载
    //（实测：加参数后 ACP 会话里 `activate_skill{"name":"agent-reach"}` 成功）。
    skillDelivery: 'args',
    // 权限档（实测取自 `commandcode --help`）：
    //   --permission-mode <mode>   standard | plan | accept-edits | yolo
    //   --yolo                     等价于 --dangerously-skip-permissions（跳过所有提示）
    permissionMode: 'default',
    permissionTemplates: {
      dont_ask: ['--permission-mode', 'yolo'],
      bypass: ['--yolo'],
    },
  },
  {
    // 2026-10-09 实测（`qoderclicn.exe --acp`，Qoder CLI CN 1.1.65）：
    //   initialize 924ms → `{"name":"qoder-cli-cn","title":"Qoder CLI CN","version":"1.1.65"}`
    //   session/new 接受 5 个 mcpServers → 真的调用 weknora 两个端点的 MCP 工具并取回真实数据
    //   available_commands 137 个
    // ⚠️ ACP 模式是**开关**不是子命令：`qoderclicn acp` 无法握手，必须 `--acp`
    //（二进制里另有 `QODER_ACP` 环境变量线索，未验证）。
    id: 'qodercn',
    label: { zh: 'Qoder CLI CN', en: 'Qoder CLI CN' },
    description: {
      zh: 'Qoder CN 命令行（ACP over stdio，`--acp` 开启）。自带 `skills link <path>` 挂载技能。',
      en: 'Qoder CN CLI (ACP over stdio via --acp).',
    },
    command: 'qoder-cn',
    fallbackPaths: [
      '%USERPROFILE%\\.qoder-cn\\entry\\qoder-cn.cmd',
      '%USERPROFILE%\\.qoder-cn\\bin\\qoderclicn\\qoderclicn.exe',
    ],
    args: ['--acp'],
    env: {},
    cwdPolicy: 'session',
    initBudget: DEFAULT_INIT_BUDGET,
    dialect: 'canonical',
    disposeGraceMs: 6000,
    idleDisposeMs: 30000,
    enabled: true,
    sortOrder: 35,
    // Qoder 用自己的技能库（`qoderclicn skills link <path>` 挂载）；`~/.agents/skills` 是否被扫未实测，
    // 因此默认 auto，需要时在 UI 里改成 args/none 或先跑 `skills link`。
    skillDelivery: 'auto',
    // 权限档（实测取自 `qoderclicn --help`）：
    //   default        → 交互确认（保守，默认）
    //   dont_ask       → `--permission-mode dont_ask`：不询问（**无人值守/cron 推荐**）
    //   bypass         → `--dangerously-skip-permissions`：完全跳过检查
    permissionMode: 'default',
    permissionTemplates: {
      dont_ask: ['--permission-mode', 'dont_ask'],
      bypass: ['--dangerously-skip-permissions'],
    },
  },
]

/**
 * Windows shim 解析。
 *
 * ✅ 实测：`.ps1` 经 `pwsh -NoProfile -ExecutionPolicy Bypass -File <shim> <args>`
 *    可以正常拉起并完成 ACP 往返（见 docs/evidence/ 的 commandcode 证据）。
 * ❌ 不允许直接 spawn `.ps1`。
 *
 * @returns {{ command: string, args: string[], via: string }}
 */
export function resolveSpawn(engine) {
  // ISSUE-02：优先用**探测到的绝对路径**（resolvedCommand / 常见安装位 / PATH），
  //   探测不到再退回命令行名（交给 PATH 兜底）。
  const det = detectExecutable(engine)
  const command = det.found ? det.resolved : resolveCommand(engine)
  // 2026-10-09：skills 的 `args` 投递方式在这里生效（`auto`/`none` 不追加任何东西）；
  // 2026-10-10：权限档（permissionMode）同样在这里追加 —— 无人值守任务靠它避免
  // "引擎每题都问、DSH 又没人批" 导致的全通道被拒（实测 session-8a6cb2e1）。
  const args = [...(engine.args ?? []), ...skillArgsFor(engine), ...permissionArgsFor(engine)]
  const lower = String(command).toLowerCase()

  if (lower.endsWith('.ps1')) {
    return {
      command: 'pwsh',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args],
      via: 'pwsh -File',
    }
  }
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return { command: 'cmd', args: ['/c', command, ...args], via: 'cmd /c' }
  }
  return { command, args, via: 'direct' }
}

/**
 * 按当前平台挑选可执行文件。
 * 顺序：用户显式 resolvedCommand > 平台 override > command（交给 PATH）
 */
export function resolveCommand(engine, platform = process.platform) {
  if (engine.resolvedCommand) return engine.resolvedCommand
  const key = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux'
  return engine.commandOverrides?.[key] ?? engine.command
}

/** 展开路径模板里的 `%VAR%` / `${VAR}` / 开头 `~`（缺失变量 → 空串）。 */
export function expandPathTemplate(template, env = process.env) {
  let out = String(template ?? '')
  if (out.startsWith('~')) out = join(env.USERPROFILE ?? env.HOME ?? '', out.replace(/^~[\\/]?/, ''))
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => env[name] ?? '')
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => env[name] ?? '')
  return out
}

/**
 * ── SKILLS 配置（2026-10-09 新增）─────────────────────────────────────────
 *
 * 背景（`docs/ACP-INTEGRATION.md` §5/§6.1 实测）：ACP **协议里没有 skills 字段**——
 * `session/new` 只带 `cwd`/`mcpServers`。技能能"共享"给外部引擎靠的是**磁盘数据**：
 *
 *   · `auto`  —— 引擎自己会扫通用目录（omp / OpenCode 都认 `~/.agents/skills`，
 *                DSH 的 119 个 skill 正好就落在那里）→ 我们什么都不用做；
 *   · `args`  —— 引擎需要显式挂载（Command Code 的 `--skill <path>`，实测有效）
 *                → 启动时按 `skillArgsTemplate` 追加参数；
 *   · `none`  —— 不下发（隔离/排查用）。
 *
 * 实测证据：omp 在 ACP 会话里能列出 119 个 skill 并 `skill://agent-reach` 载入正文；
 * Command Code 加 `--skill <dir>` 后 `activate_skill{"name":"agent-reach"}` 成功。
 */
export const SKILL_DELIVERIES = ['auto', 'args', 'none']

/** 通用 skill 目录（DSH 的 skill 就落在这里，`dsh-agent-sync` 负责保持最新）。 */
export function defaultSkillsDir(env = process.env) {
  return expandPathTemplate('~/.agents/skills', env)
}

/**
 * ── 权限模式（`permissionMode`，2026-10-10 新增）──────────────────────────
 *
 * 为什么需要它：ACP 里引擎每要执行一个动作（shell / 编辑 / 搜索）都可能向客户端发
 * `session/request_permission`，由客户端决定放行还是拒绝。**无人值守的定时任务没人点"批准"**
 * 时，DSH 的审批链会一律拒绝 —— 实测 2026-10-10 `session-8a6cb2e1`（定时任务）里
 * 11 次审批 **11 次 rejected**，引擎的工具（curl / Invoke-WebRequest / node fetch /
 * chrome-devtools / web_search / Edit）全部报 "The user doesn't want to proceed…"，
 * 表现成"所有通道都被拒，连写盘也不行"。
 *
 * 解法：让**引擎自己别问**。各家 CLI 的开关不同，所以用**数据行**声明模板：
 *
 *   permissionTemplates: {
 *     dont_ask: ['--permission-mode', 'dont_ask'],   // 免问（无人值守）
 *     bypass:   ['--dangerously-skip-permissions'],  // 完全跳过检查
 *   }
 *
 * `permissionMode` 三档：`default`（不追加参数，交互安全）/ `dont_ask` / `bypass`。
 * 只有引擎行声明了对应模板，该档才可选（UI 会禁用未声明的档位）。
 */
export const PERMISSION_MODES = ['default', 'dont_ask', 'bypass']

/** 该引擎支持的权限档（default 恒为"支持"，其余看模板是否存在）。 */
export function supportedPermissionModes(engine) {
  const templates = engine?.permissionTemplates ?? {}
  return PERMISSION_MODES.filter((mode) => mode === 'default' || (Array.isArray(templates[mode]) && templates[mode].length > 0))
}

/** 按当前 `permissionMode` 生成要追加的启动参数（`default` / 未声明 → 空数组）。 */
export function permissionArgsFor(engine) {
  const mode = PERMISSION_MODES.includes(engine?.permissionMode) ? engine.permissionMode : 'default'
  if (mode === 'default') return []
  const template = engine?.permissionTemplates?.[mode]
  if (!Array.isArray(template) || template.length === 0) return []
  return template.map(String)
}

/** 解析一个引擎的 skills 配置（补齐默认值 + 展开 `~`/环境变量）。 */
export function resolveSkills(engine, env = process.env) {
  const delivery = SKILL_DELIVERIES.includes(engine?.skillDelivery) ? engine.skillDelivery : 'auto'
  const raw = Array.isArray(engine?.skillsDirs) && engine.skillsDirs.length > 0 ? engine.skillsDirs : [defaultSkillsDir(env)]
  const dirs = raw.map((d) => expandPathTemplate(String(d), env)).filter((d) => d.trim().length > 0)
  const template = Array.isArray(engine?.skillArgsTemplate) && engine.skillArgsTemplate.length > 0
    ? engine.skillArgsTemplate.map(String)
    : ['--skill', '{dir}']
  return { delivery, dirs, template }
}

/** 把 template 里的 `{dir}` 换成实际目录（`['--skill','{dir}']` → `['--skill','D:\\...']`）。 */
function templateToArgs(template, dirs) {
  const out = []
  for (const dir of dirs) {
    for (const part of template) out.push(part.replaceAll('{dir}', dir))
  }
  return out
}

/** `args` 需要追加的 skill 参数（`auto`/`none` 返回空数组）。 */
export function skillArgsFor(engine, env = process.env) {
  const { delivery, dirs, template } = resolveSkills(engine, env)
  if (delivery !== 'args') return []
  return templateToArgs(template, dirs)
}

/**
 * 供 UI 展示的 skills 状态：每个目录是否存在、里面有多少个 skill（子目录数）。
 * 纯只读探测，失败一律降级为 `exists:false`。
 */
export function describeSkills(engine, env = process.env) {
  const { delivery, dirs, template } = resolveSkills(engine, env)
  const resolved = dirs.map((path) => {
    let exists = false
    let count = 0
    try {
      exists = existsSync(path)
      if (exists) count = readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).length
    } catch { /* 无权限等 → 当作不存在 */ }
    return { path, exists, count }
  })
  const mounted = delivery === 'args' ? templateToArgs(template, dirs) : []
  const summary =
    delivery === 'args'
      ? `--skill 挂载 ${resolved.filter((d) => d.exists).length}/${resolved.length} 个目录` +
        (resolved.length ? `（${resolved.reduce((n, d) => n + d.count, 0)} 个 skill）` : '')
      : delivery === 'none'
        ? '不下发'
        : `引擎自扫（${resolved.filter((d) => d.exists).length ? `${resolved.reduce((n, d) => n + d.count, 0)} 个 skill 就位` : '目录不存在'}）`
  return { delivery, dirs: resolved, mounted, summary }
}

/** 在 PATH 里按 PATHEXT（Windows）查找一个裸命令名。 */
function searchPath(name, { platform, env }) {
  const exts =
    platform === 'win32'
      ? env.PATHEXT
        ? env.PATHEXT.split(';').filter(Boolean)
        : ['.COM', '.EXE', '.BAT', '.CMD', '.PS1']
      : ['']
  const dirs = String(env.PATH ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** 解析一个「路径或裸命令」。 */
function findExecutable(nameOrPath, opts) {
  const value = String(nameOrPath ?? '')
  if (value.length === 0) return null
  const pathLike = value.includes('\\') || value.includes('/')
  if (pathLike || isAbsolute(value)) return existsSync(value) ? value : null
  return searchPath(value, opts)
}

/** 归一化 + 校验一条引擎定义。校验失败返回 { ok:false, error }，不抛。 */export function normalizeEngine(raw, { source = 'unknown' } = {}) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'engine must be an object' }
  const id = String(raw.id ?? '').trim()
  if (!id) return { ok: false, error: 'engine.id is required' }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return { ok: false, error: `engine.id "${id}" must be lowercase alphanumeric/dash` }
  }
  if (!raw.command) return { ok: false, error: `engine "${id}": command is required` }

  return {
    ok: true,
    engine: {
      id,
      source,
      label: raw.label ?? { zh: id, en: id },
      description: raw.description ?? null,
      command: raw.command,
      // ISSUE-02：`resolvedCommand` 只承载**用户显式覆盖**；内置不再塞本机绝对路径。
      resolvedCommand: raw.resolvedCommand ?? null,
      commandOverrides: raw.commandOverrides ?? {},
      fallbackPaths: Array.isArray(raw.fallbackPaths) ? raw.fallbackPaths.map(String) : [],
      initialConfigOptions: Array.isArray(raw.initialConfigOptions)
        ? raw.initialConfigOptions
            .filter((o) => o && o.configId !== undefined && o.value !== undefined)
            .map((o) => ({ configId: String(o.configId), value: String(o.value) }))
        : [],
      args: Array.isArray(raw.args) ? raw.args.map(String) : [],
      env: raw.env ?? {},
      cwdPolicy: raw.cwdPolicy === 'fixed' ? 'fixed' : 'session',
      cwd: raw.cwd ?? null,
      initBudget: { ...DEFAULT_INIT_BUDGET, ...(raw.initBudget ?? {}) },
      dialect: raw.dialect ?? 'canonical',
      capabilities: raw.capabilities ?? null,
      // B1：MCP 下发策略 —— undefined/'inherit' = 继承 DSH 的 MCP 存储；
      // `false`/'none' = 不下发；数组 = 只用这些自定义服务器。
      // 详见 lib/mcp-servers.js#resolveMcpServers。
      mcp: raw.mcp ?? 'inherit',
      // ── SKILLS（2026-10-09）──────────────────────────────────────────
      // skillDelivery: 'auto'（引擎自扫通用目录）/ 'args'（启动时追加 --skill <dir>）/ 'none'
      // skillsDirs:   要暴露给该引擎的 skill 目录（空 = 用 defaultSkillsDir()，即 ~/.agents/skills）
      // skillArgsTemplate: 'args' 模式下的参数模板，默认 ['--skill','{dir}']（可换成别的 CLI 的写法）
      ...(SKILL_DELIVERIES.includes(raw.skillDelivery) ? { skillDelivery: raw.skillDelivery } : {}),
      ...(Array.isArray(raw.skillsDirs) ? { skillsDirs: raw.skillsDirs.map(String) } : {}),
      ...(Array.isArray(raw.skillArgsTemplate) ? { skillArgsTemplate: raw.skillArgsTemplate.map(String) } : {}),
      // ── 权限档（2026-10-10）──────────────────────────────────────────
      // permissionMode: 'default'（不追加参数）/ 'dont_ask' / 'bypass'
      // permissionTemplates: { dont_ask: [...args], bypass: [...args] }（数据集驱动，
      //   各家 CLI 的开关名不同；未声明的档位 UI 会禁用）
      ...(PERMISSION_MODES.includes(raw.permissionMode) ? { permissionMode: raw.permissionMode } : {}),
      ...(raw.permissionTemplates && typeof raw.permissionTemplates === 'object'
        ? {
            permissionTemplates: Object.fromEntries(
              Object.entries(raw.permissionTemplates)
                .filter(([k, v]) => PERMISSION_MODES.includes(k) && Array.isArray(v))
                .map(([k, v]) => [k, v.map(String)]),
            ),
          }
        : {}),
      // 2026-10-09：单引擎的 prompt 超时覆盖（毫秒；<=0 = 不超时）。
      // 不设时由插件配置 promptTimeoutMs 注入（见 index.impl.js#apply）。
      ...(raw.promptTimeoutMs === undefined || raw.promptTimeoutMs === null
        ? {}
        : { promptTimeoutMs: Number(raw.promptTimeoutMs) }),
      // A16（2026-10-10）：空闲超时（多久没有 session/update 才算卡死；<=0 = 不判空闲）
      ...(raw.idleTimeoutMs === undefined || raw.idleTimeoutMs === null
        ? {}
        : { idleTimeoutMs: Number(raw.idleTimeoutMs) }),
      disposeGraceMs: Number(raw.disposeGraceMs ?? 6000),
      idleDisposeMs: Number(raw.idleDisposeMs ?? 30000),
      enabled: raw.enabled !== false,
      sortOrder: Number(raw.sortOrder ?? 100),
    },
  }
}

/**
 * 组装引擎表：内置 → 用户文件覆盖/追加。
 *
 * 合并规则（按 id）：
 *  - 用户文件里存在的同 id → 用户字段**整体覆盖**内置同名字段（不做深合并，避免半覆盖导致意外）
 *  - 用户文件里的新 id → 追加
 */
export function loadEngines({ stateDir, configEngines = [] } = {}) {
  const diagnostics = []
  const byId = new Map()

  for (const raw of BUILTIN) {
    const r = normalizeEngine(raw, { source: 'builtin' })
    if (r.ok) byId.set(r.engine.id, r.engine)
    else diagnostics.push({ level: 'error', source: 'builtin', message: r.error })
  }

  // 用户文件：<stateDir>/engines.json
  const userFile = stateDir ? join(stateDir, 'engines.json') : null
  if (userFile && existsSync(userFile)) {
    try {
      const parsed = JSON.parse(readFileSync(userFile, 'utf8'))
      const list = Array.isArray(parsed) ? parsed : (parsed.engines ?? [])
      for (const raw of list) {
        const r = normalizeEngine(raw, { source: 'user-file' })
        if (r.ok) byId.set(r.engine.id, r.engine)
        else diagnostics.push({ level: 'error', source: `user-file:${userFile}`, message: r.error })
      }
    } catch (error) {
      diagnostics.push({
        level: 'error',
        source: `user-file:${userFile}`,
        message: `cannot parse engines.json: ${String(error?.message ?? error)}`,
      })
    }
  }

  // 插件 config.engines（优先级最高，便于快速试验）
  for (const raw of configEngines ?? []) {
    const r = normalizeEngine(raw, { source: 'plugin-config' })
    if (r.ok) byId.set(r.engine.id, r.engine)
    else diagnostics.push({ level: 'error', source: 'plugin-config', message: r.error })
  }

  const engines = [...byId.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
  return { engines, diagnostics }
}

/* ═══════════════════════════════════════════════════════════════════════
 * B1 · 引擎可用性探测（四态）
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * 解析一条引擎的可执行体。
 *
 * 命令取值照 {@link resolveCommand}（用户 resolvedCommand > 平台 override > command），
 * 再做两类判定：
 *   - 命令是**路径**（含分隔符）→ 直接查文件存在性；
 *   - 命令是**裸名** → 在 `PATH` 里按 `PATHEXT`（Windows）查找。
 *
 * @returns {{ found: boolean, resolved: string|null, via: 'missing'|'file'|'path' }}
 */
export function detectExecutable(engine, { platform = process.platform, env = process.env } = {}) {
  const key = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux'
  const candidates = []
  if (engine.resolvedCommand) candidates.push(engine.resolvedCommand)
  if (engine.commandOverrides?.[key]) candidates.push(engine.commandOverrides[key])
  for (const template of engine.fallbackPaths ?? []) candidates.push(expandPathTemplate(template, env))
  candidates.push(engine.command) // 裸命令 → PATH 查找
  for (const candidate of candidates) {
    const hit = findExecutable(candidate, { platform, env })
    if (hit) return { found: true, resolved: hit, via: 'resolved' }
  }
  return { found: false, resolved: null, via: 'missing' }
}

/**
 * 四态：`disabled` → `not-installed` → `unavailable` → `available`。
 *
 * `unavailable` 需要一次失败的试连（`lastError`）；探测本身只区分前两态。
 * @returns {'disabled'|'not-installed'|'unavailable'|'available'}
 */
export function engineState(engine, opts = {}) {
  if (engine.enabled === false) return 'disabled'
  if (!detectExecutable(engine, opts).found) return 'not-installed'
  return opts.lastError ? 'unavailable' : 'available'
}

/** B2/UI 用的引擎行：状态 + 可执行体 + 能力。 */
export function describeEngines(engines, { platform = process.platform, env = process.env, lastErrors = {} } = {}) {
  return engines.map((e) => {
    const det = detectExecutable(e, { platform, env })
    const lastError = lastErrors[e.id]
    return {
      id: e.id,
      label: e.label,
      description: e.description,
      command: e.command,
      args: e.args,
      cwdPolicy: e.cwdPolicy,
      // B4-①：UI 的「覆盖启动方式」块要显示/编辑它（patch 字段名同 routes.js）
      ...(e.resolvedCommand ? { resolvedCommand: e.resolvedCommand } : {}),
      env: e.env,
      // B1：UI 要把「这个引擎会拿到哪些 MCP」显示出来
      mcp: e.mcp ?? 'inherit',
      // 超时（A16）：引擎行自带值（UI 显示/编辑用；未设则为 null = 用插件默认）
      promptTimeoutMs: typeof e.promptTimeoutMs === 'number' ? e.promptTimeoutMs : null,
      idleTimeoutMs: typeof e.idleTimeoutMs === 'number' ? e.idleTimeoutMs : null,
      // SKILLS：UI 的「SKILLS」块（投递方式 + 目录 + 目录状态/数量 + 实际会追加的参数）
      skills: describeSkills(e, env),
      // 权限档：当前档位 + 该引擎支持哪些档 + 实际追加的参数（UI 的「权限模式」下拉）
      permission: {
        mode: PERMISSION_MODES.includes(e.permissionMode) ? e.permissionMode : 'default',
        supported: supportedPermissionModes(e),
        args: permissionArgsFor(e),
        templates: e.permissionTemplates ?? {},
      },
      // 实际会用的参数（= 基础 args + skills 追加项 + 权限档追加项）。这里**不含** shim 包装
      //（pnpm/npx/pwsh 前缀由 resolveSpawn 负责），免得 UI 的 launch 行被前缀淹没。
      effectiveArgs: [...(e.args ?? []), ...skillArgsFor(e, env), ...permissionArgsFor(e)],
      enabled: e.enabled,
      sortOrder: e.sortOrder,
      initialConfigOptions: e.initialConfigOptions ?? [],
      capabilities: e.capabilities,
      source: e.source,
      executable: det.resolved,
      executableFound: det.found,
      state: engineState(e, { platform, env, lastError }),
      ...(lastError === undefined ? {} : { lastError }),
    }
  })
}

/* ── 用户层读写（`<stateDir>/engines.json`）────────────────────────────── */

/** 读取 `engines.json` 的原始行数组（缺失/损坏都退化为空）。 */
export function readUserEngines(stateDir) {
  const file = stateDir ? join(stateDir, 'engines.json') : null
  if (!file || !existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(parsed)) return parsed
    return Array.isArray(parsed?.engines) ? parsed.engines : []
  } catch {
    return []
  }
}

/**
 * 整体覆盖式写入一条用户引擎行（按 id）。先写 `.tmp` 再 rename。
 * @returns {boolean} 是否写入成功
 */
export function saveUserEngine(stateDir, rawEngine) {
  if (!stateDir || !rawEngine?.id) return false
  try {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    const rows = readUserEngines(stateDir).filter((r) => String(r?.id) !== String(rawEngine.id))
    rows.push(rawEngine)
    const file = join(stateDir, 'engines.json')
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify({ engines: rows }, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}
