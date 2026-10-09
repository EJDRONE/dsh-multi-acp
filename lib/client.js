/* dsh-multi-acp · 浏览器侧（B4）
 *
 * 手写 bundle：直接采用加载器约定的 `window.__ModuleLoader__.load({ id, factory })`
 * 包裹，**不使用 JSX**（用 React.createElement），因此**无需 esbuild**。
 *
 * 契约（见 docs/evidence/B0-ui-contract-findings.md）：
 *   - `require('react')` 由加载器的 seeded require table 提供（平台模块），不进 bundle。
 *   - 注册设置分区：`ctx.slots.inject('settings.section', () => ctx.slots.register(spec, Comp))`。
 *   - i18n：`ctx.locale.register(ns, 'zh'|'en', dict)`。
 *   - 数据面：`fetch('/multi-acp/...')` 打回宿主路由（B2）。
 *
 * 依赖「@deepseek-ai/dsh-client-ui-primitives」的用法**刻意避开**：只使用原生
 * `div/button/input/textarea/span/select` + 内联样式，减少与宿主版本的耦合。
 *
 * ── B4（2026-10-09）──────────────────────────────────────────────────────
 * ① 可编辑启动方式：command / args / cwdPolicy → PUT `resolvedCommand` / `args` /
 *    `cwdPolicy`（字段名以 routes.js#mergeEnginePatch 为准）。
 * ② 环境变量行编辑：KEY/VALUE 行 + 👁 查看 + 🗑 删除 + ＋ 新增；删除的键必须以
 *    `{KEY: null}` 形式下发（mergeEnginePatch 用 null 表示"删掉"），否则删不掉。
 * 另外补上设计稿 §4.1 的四态过滤桶 + 搜索、默认引擎徽章，以及 §4.2 的**握手诊断行**
 * （含 B1 的 MCP 下发、C1 的引擎命令/技能上报 —— 见 lib/engine-runtime.js）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-multi-acp',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    let React = null
    try {
      React = require('react')
    } catch {
      /* 纯 Node 下（契约测试）退回最小 shim，保证源码可加载 */
    }
    if (!React || typeof React.createElement !== 'function') {
      React = {
        createElement(type, props, ...kids) {
          return { type, props: props || {}, kids: kids.flat(9).filter((k) => k !== null && k !== undefined && k !== false) }
        },
        useState(init) {
          const v = [typeof init === 'function' ? init() : init]
          return [v[0], (x) => { v[0] = typeof x === 'function' ? x(v[0]) : x }]
        },
        useEffect() {},
        useMemo(fn) { return fn() },
      }
    }
    const h = React.createElement
    const { useState, useEffect } = React

    const CLIENT_NAME = 'dsh-multi-acp'
    const NS = 'multi-acp'
    const API = '/multi-acp'

    const ZH = {
      title: '引擎管理',
      subtitle: '管理本机可用的 ACP 引擎。新增引擎需该 CLI 支持 ACP over stdio。',
      refresh: '刷新', test: '测试连接', testing: '测试中…', edit: '编辑', save: '保存并测试', cancel: '取消',
      state_available: '可用', state_not_installed: '未安装', state_unavailable: '不可用', state_disabled: '已停用',
      executable: '可执行体', connected: '已连接', failed: '失败', empty: '暂无引擎', loading: '加载中…',
      defaultEngine: '默认引擎', officialDsh: '官方 DSH loop', isDefault: '默认',
      search: '搜索引擎…',
      filter_all: '全部', filter_available: '可用', filter_not_installed: '未安装', filter_unavailable: '不可用',
      envTitle: '环境变量',
      envHint: '每行填一个变量。保存后自动试连。此配置无法替代 CLI 内的账号登录（OAuth 请在终端里完成）。',
      addVar: '＋ 添加变量', show: '显示', hide: '隐藏', remove: '删除',
      launchTitle: '启动方式',
      launchOverride: '覆盖启动方式', launchCollapse: '收起',
      command: 'command', args: 'args（空格分隔）', cwdPolicy: 'cwdPolicy',
      cwdSession: 'session（跟随会话目录）', cwdFixed: 'fixed（固定 cwd）',
      mcpTitle: 'MCP 随会话下发',
      permissionTitle: '权限模式',
      permDefault: 'default（引擎照常询问，交互安全）',
      permDontAsk: 'dont_ask（不询问 —— 定时任务/无人值守推荐）',
      permBypass: 'bypass（完全跳过权限检查 ⚠️）',
      permissionAutoHint: '会话档位为【完全权限】时，本引擎会自动以上面的「不询问」档启动（定时任务不会被"审批没人批"卡死）；【工作区内修改】/【仅可查看】沿用这里的设置并打告警。',
      permissionUnsupported: '本引擎未声明某些档的启动参数（下拉里是灰的）：可在【覆盖启动方式 → args】手填，或在该引擎行的 permissionTemplates 里声明。',
      timeoutTitle: '超时',
      timeoutIdle: '空闲(ms)',
      timeoutOverall: '总时长(ms)',
      timeoutHint: '空闲 = 多久没有引擎消息才算卡死（主闸，默认 180000）；总时长 = 墙钟上限，0 = 不限（长任务建议 0，否则会把正在干活的引擎误杀）。留空 = 用插件默认。',
      skillsTitle: 'SKILLS 目录',
      skillsAuto: 'auto（引擎自扫 ~/.agents/skills）',
      skillsArgs: 'args（启动时追加 --skill <目录>）',
      skillsNone: 'none（不下发）',
      skillsHint: 'ACP 协议没有 skills 字段，技能靠磁盘目录共享：omp / OpenCode 自扫 ~/.agents/skills（DSH 的 skill 就在那里）；Command Code 需要 --skill 显式挂载。',
      skillsFound: '已找到 {n} 个 skill',
      skillsMissing: '目录不存在',
      skillsAdd: '＋ 添加目录',
      pickerTitle: '选择目录',
      pickerUp: '← 上级',
      pickerChoose: '选择此目录',
      pickerQuick: '快捷',
      pickerEmpty: '（该目录下没有子目录）',
      addAgent: '＋ 添加自定义 Agent',
      addManual: '手动添加',
      addByChat: '通过对话添加',
      manualHint: '填命令与参数 → 先「探测」跑一次真实 ACP 握手，通过后再保存（避免写进不认 ACP 的 CLI）。',
      engineId: 'id',
      engineLabel: '显示名',
      probe: '探测',
      probing: '探测中…',
      probeOk: '握手成功',
      probeFail: '握手失败',
      probeFirst: '需先探测成功才能保存',
      saveEngine: '保存引擎',
      discoverHint: '给个线索（如 qoder / kimi / gemini），宿主会在 PATH 与已知安装位里找候选并逐个跑 ACP 握手，只列出真能跑的。',
      discoverPlaceholder: '线索，例如 qoder',
      discover: '发现',
      discovering: '发现中…（每个候选最多 15s）',
      noCandidates: '没有找到可探测的候选（换个线索，或用「手动添加」直接给路径）',
      addThis: '添加',
      skillsSummary: 'SKILLS',
      mcpInherit: 'inherit（继承 DSH 的 MCP 配置）', mcpNone: 'none（不下发）',
      enable: '启用', disable: '停用', diagnostic: '诊断',
      // ── UI 打磨（2026-10-10）：元信息网格 + 诊断胶囊 ──
      launchLabel: '启动', capsLabel: '能力',
      unitCount: '个', extraArgs: '追加参数',
      diagMcp: 'MCP', diagCommands: '引擎命令/技能', diagPerm: '权限映射',
      diagRunning: '运行中', diagIdle: '上次回合', diagHandshake: '最近握手',
      diagNoRun: '未跑过会话', diagNoReport: '未上报', diagEmpty: '尚未跑过会话 · 暂无运行时数据',
      timeoutUnlimited: '不限', permSkipped: '跳过权限检查',
      toolsCount: '次工具调用', elapsed: '已耗时',
      // ⚠️ key 必须与 permission-bridge 的 reason 字面量一一对应（kebab-case）
      'permReason_disabled': '已关闭',
      'permReason_no-preset': '未生效（读不到会话档位）',
      'permReason_engine-unsupported': '未生效（引擎未声明该档参数）',
      'permReason_read-only-unsupported': '仅可查看：ACP 无只读语义',
      'permReason_workspace-write-asks': '工作区内修改：引擎照常询问',
      'permReason_unmapped': '未生效（没有映射规则）',
      'permReason_unknown': '未生效',
      noRows: '没有匹配的引擎', more: '更多',
    }
    const EN = {
      title: 'Engines',
      subtitle: 'Manage local ACP engines. A new engine must speak ACP over stdio.',
      refresh: 'Refresh', test: 'Test connection', testing: 'Testing…', edit: 'Edit', save: 'Save & test', cancel: 'Cancel',
      state_available: 'Available', state_not_installed: 'Not installed', state_unavailable: 'Unavailable', state_disabled: 'Disabled',
      executable: 'Executable', connected: 'Connected', failed: 'Failed', empty: 'No engines', loading: 'Loading…',
      defaultEngine: 'Default engine', officialDsh: 'official DSH loop', isDefault: 'default',
      search: 'Search engines…',
      filter_all: 'All', filter_available: 'Available', filter_not_installed: 'Not installed', filter_unavailable: 'Unavailable',
      envTitle: 'Environment',
      envHint: 'One variable per row. Auto-tests after save. This cannot replace CLI login (finish OAuth in a terminal).',
      addVar: '+ Add variable', show: 'Show', hide: 'Hide', remove: 'Remove',
      launchTitle: 'Launch',
      launchOverride: 'Override launch', launchCollapse: 'Collapse',
      command: 'command', args: 'args (space separated)', cwdPolicy: 'cwdPolicy',
      cwdSession: 'session (follow session cwd)', cwdFixed: 'fixed (pinned cwd)',
      mcpTitle: 'MCP servers per session',
      permissionTitle: 'Permission mode',
      permDefault: 'default (engine keeps asking — safe for interactive use)',
      permDontAsk: 'dont_ask (never ask — recommended for scheduled/unattended runs)',
      permBypass: 'bypass (skip all permission checks ⚠️)',
      permissionAutoHint: 'When the session preset is "Full access", this engine is started in the "never ask" mode automatically (so scheduled tasks never get stuck on unanswered approvals). "Workspace write" / "Read only" keep the setting above and log a warning.',
      permissionUnsupported: 'This engine does not declare args for some modes (they are greyed out): fill them in "Override launch → args", or declare permissionTemplates on the engine row.',
      timeoutTitle: 'Timeouts',
      timeoutIdle: 'idle(ms)',
      timeoutOverall: 'overall(ms)',
      timeoutHint: 'idle = how long without any engine update before we call it stuck (main guard, default 180000); overall = wall-clock cap, 0 = unlimited (recommended for long tasks, otherwise a working engine gets killed). Blank = plugin default.',
      skillsTitle: 'SKILLS directories',
      skillsAuto: 'auto (engine scans ~/.agents/skills)',
      skillsArgs: 'args (append --skill <dir> at launch)',
      skillsNone: 'none (do not deliver)',
      skillsHint: 'ACP has no skills field — skills are shared through directories: omp / OpenCode scan ~/.agents/skills (where DSH keeps them); Command Code needs an explicit --skill mount.',
      skillsFound: '{n} skill(s) found',
      skillsMissing: 'directory not found',
      skillsAdd: '+ Add directory',
      pickerTitle: 'Choose directory',
      pickerUp: '← Up',
      pickerChoose: 'Use this directory',
      pickerQuick: 'Quick',
      pickerEmpty: '(no subdirectories)',
      addAgent: '+ Add custom agent',
      addManual: 'Add manually',
      addByChat: 'Add from a hint',
      manualHint: 'Fill in the command and arguments → run "Probe" (a real ACP handshake) before saving, so a non-ACP CLI never lands in the table.',
      engineId: 'id',
      engineLabel: 'Display name',
      probe: 'Probe',
      probing: 'Probing…',
      probeOk: 'Handshake OK',
      probeFail: 'Handshake failed',
      probeFirst: 'Probe must succeed before saving',
      saveEngine: 'Save engine',
      discoverHint: 'Give a hint (e.g. qoder / kimi / gemini). The host searches PATH and known install locations, runs an ACP handshake on each candidate and lists only the ones that really work.',
      discoverPlaceholder: 'hint, e.g. qoder',
      discover: 'Discover',
      discovering: 'Discovering… (up to 15s each)',
      noCandidates: 'No candidates found — try another hint, or use "Add manually" with an explicit path',
      addThis: 'Add',
      skillsSummary: 'SKILLS',
      mcpInherit: 'inherit (use DSH MCP config)', mcpNone: 'none (send nothing)',
      enable: 'Enable', disable: 'Disable', diagnostic: 'Diagnostics',
      launchLabel: 'Launch', capsLabel: 'Capabilities',
      unitCount: '', extraArgs: 'extra args',
      diagMcp: 'MCP', diagCommands: 'Engine cmds/skills', diagPerm: 'Permission map',
      diagRunning: 'Running', diagIdle: 'Last turn', diagHandshake: 'Last handshake',
      diagNoRun: 'no session yet', diagNoReport: 'not reported', diagEmpty: 'No session yet · no runtime data',
      timeoutUnlimited: 'unlimited', permSkipped: 'skips permission checks',
      toolsCount: 'tool calls', elapsed: 'elapsed',
      'permReason_disabled': 'off',
      'permReason_no-preset': 'not applied (no session preset)',
      'permReason_engine-unsupported': 'not applied (engine declares no args for this mode)',
      'permReason_read-only-unsupported': 'read-only: ACP has no read-only semantics',
      'permReason_workspace-write-asks': 'workspace-write: engine keeps asking',
      'permReason_unmapped': 'not applied (no mapping rule)',
      'permReason_unknown': 'not applied',
      noRows: 'No engine matches', more: 'more',
    }

    const STATE_COLOR = {
      available: '#2ea043', not_installed: '#8b949e', unavailable: '#d29922', disabled: '#8b949e',
    }

    const STYLE = `
.macp-wrap { padding: 4px 2px; color: var(--dsw-text-primary, #1f2328); font-size: 13px; }
.macp-head { display:flex; align-items:baseline; gap:10px; }
.macp-title { font-size:15px; font-weight:600; }
.macp-sub { color: var(--dsw-text-secondary,#656d76); font-size:12px; }
.macp-btn { border:1px solid var(--dsw-border,#d0d7de); background:var(--dsw-bg,#fff); color:inherit; border-radius:6px; padding:3px 10px; cursor:pointer; font-size:12px; }
.macp-btn:disabled { opacity:.5; cursor:default; }
.macp-btn:focus-visible { outline:2px solid #0969da; outline-offset:1px; }
.macp-btn-primary { background:#0969da; border-color:#0969da; color:#fff; }
.macp-tools { display:flex; align-items:center; gap:8px; margin-top:10px; flex-wrap:wrap; }
.macp-chip { border:1px solid var(--dsw-border,#d0d7de); background:transparent; color:inherit; border-radius:999px; padding:2px 10px; cursor:pointer; font-size:12px; }
.macp-chip-on { border-color:#0969da; color:#0969da; }
.macp-search { border:1px solid var(--dsw-border,#d0d7de); background:var(--dsw-bg,#fff); color:inherit; border-radius:6px; padding:3px 8px; font-size:12px; min-width:180px; }
.macp-row { border:1px solid var(--dsw-border,#d0d7de); border-left:3px solid transparent; border-radius:8px; padding:11px 14px; margin-top:10px; transition:box-shadow .15s ease; }
.macp-row:hover { box-shadow:0 2px 10px rgba(31,35,40,.07); }
.macp-row-s-available { border-left-color:#2ea043; }
.macp-row-s-unavailable { border-left-color:#d29922; }
.macp-row-s-not_installed, .macp-row-s-disabled { border-left-color:#c3ccd6; }
.macp-rowtop { display:flex; align-items:center; gap:10px; }
.macp-name { font-weight:600; }
.macp-badge { font-size:11px; padding:1px 8px; border-radius:999px; color:#fff; }
.macp-badge-plain { font-size:11px; padding:1px 8px; border-radius:999px; border:1px solid var(--dsw-border,#d0d7de); }
.macp-meta { color:var(--dsw-text-secondary,#656d76); font-size:12px; margin-top:4px; word-break:break-all; }
.macp-diag { color:var(--dsw-text-secondary,#656d76); font-size:12px; margin-top:4px; }
/* ── 2026-10-10 UI 打磨：元信息网格 + 诊断胶囊 ── */
.macp-grid { display:grid; grid-template-columns:max-content 1fr; gap:3px 12px; margin-top:9px; }
.macp-grid > .macp-k2 { color:var(--dsw-text-secondary,#656d76); font-size:11px; white-space:nowrap; padding-top:1px; min-width:52px; }
.macp-grid > .macp-v2 { color:var(--dsw-text-primary,#1f2328); font-size:12px; overflow-wrap:anywhere;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.macp-mono { font-family:ui-monospace,Consolas,monospace; font-size:11px; }
.macp-diagwrap { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:9px; }
.macp-dchip { display:inline-flex; align-items:center; gap:4px; font-size:11px; line-height:1.65; padding:2px 9px; border-radius:999px;
  border:1px solid var(--dsw-border,#d0d7de); background:var(--dsw-bg-secondary,#f6f8fa); color:var(--dsw-text-secondary,#656d76); max-width:100%; }
.macp-dchip-ok { border-color:#2ea04366; color:#1a7f37; background:#2ea0430f; }
.macp-dchip-warn { border-color:#d2992266; color:#9a6700; background:#d299220f; }
.macp-dchip-live { border-color:#0969da66; color:#0969da; background:#0969da0f; }
/* 能力胶囊（引擎自报）：虚框无底色，与"运行时胶囊"（实框）区分开 */
.macp-dchip-cap { background:transparent; border-style:dashed; }
.macp-dchip-label { font-weight:600; }
.macp-grid > .macp-v2.macp-warn { color:#9a6700; }
.macp-dchip + .macp-dchip { margin-left:0; }
.macp-diagwrap + .macp-grid, .macp-grid + .macp-diagwrap { margin-top:7px; }
.macp-actions { margin-left:auto; display:flex; gap:8px; }
.macp-pre { margin-top:8px; background:var(--dsw-bg-secondary,#f6f8fa); border-radius:6px; padding:8px; font-size:12px; white-space:pre-wrap; word-break:break-all; }
.macp-err { color:#d1242f; margin-top:8px; }
.macp-edit { margin-top:10px; border-top:1px solid var(--dsw-border,#d0d7de); padding-top:10px; }
.macp-plugin { font-size:11px; color:var(--dsw-text-secondary,#656d76); border:1px solid var(--dsw-border,#d0d7de); border-radius:999px; padding:1px 8px; }
.macp-picker { margin-top:8px; border:1px solid var(--dsw-border,#d0d7de); border-radius:6px; padding:8px; background:var(--dsw-bg-secondary,#f6f8fa); }
.macp-picker-list { max-height:180px; overflow:auto; display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
.macp-picker-item { border:1px solid var(--dsw-border,#d0d7de); background:var(--dsw-bg,#fff); color:inherit; border-radius:6px; padding:2px 8px; cursor:pointer; font-size:12px; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.macp-envrow { display:flex; align-items:center; gap:6px; margin-top:6px; }
.macp-skillrow { display:flex; align-items:center; gap:6px; margin-top:6px; }
.macp-in { border:1px solid var(--dsw-border,#d0d7de); background:var(--dsw-bg,#fff); color:inherit; border-radius:6px; padding:4px 8px; font-size:12px; font-family:ui-monospace,Consolas,monospace; }
.macp-k { width:34%; }
.macp-v { flex:1; min-width:120px; }
.macp-launch { display:flex; gap:6px; margin-top:6px; flex-wrap:wrap; }
/* UI 打磨：编辑面板的标签列定宽 → 各输入框左边缘对齐（以前宽窄不一，参差不齐） */
.macp-legend { color:var(--dsw-text-secondary,#656d76); font-size:11px; margin-right:4px; align-self:center; min-width:96px; }
.macp-edit > .macp-launch > .macp-in { flex:1; min-width:150px; }
.macp-edit > .macp-launch > select.macp-in { flex:0 1 420px; }
.macp-save { margin-top:10px; display:flex; gap:8px; align-items:center; }
.macp-hint { color:var(--dsw-text-secondary,#656d76); font-size:11px; margin-top:2px; }
`

    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById('multi-acp-styles')) return
      const el = document.createElement('style')
      el.id = 'multi-acp-styles'
      el.textContent = STYLE
      document.head.appendChild(el)
    }

    async function fetchJson(url, init) {
      const res = await fetch(url, init)
      const text = await res.text()
      let body = null
      try { body = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
      if (!res.ok) throw new Error((body && body.error) || `${res.status} ${res.statusText}`)
      return body
    }

    /** B4-①：args 输入框 → 数组。支持双引号包裹的整段参数。 */
    function parseArgs(text) {
      const out = []
      const src = String(text ?? '')
      const re = /"([^"]*)"|'([^']*)'|(\S+)/g
      let m
      while ((m = re.exec(src)) !== null) out.push(m[1] ?? m[2] ?? m[3])
      return out
    }

    /**
     * B4-②：行编辑状态 → `env` patch。
     * 规则（routes.js#mergeEnginePatch）：给出的键写入，`null` 表示删除。
     */
    function envPatch(rows, removed) {
      const env = {}
      const seen = new Set()
      for (const row of rows || []) {
        const key = String(row.key ?? '').trim()
        if (!key) continue
        env[key] = String(row.value ?? '')
        seen.add(key)
      }
      for (const key of removed || []) {
        if (!seen.has(key)) env[key] = null
      }
      return env
    }

    /** ISSUE-07：把试连缓存的能力快照渲染成一行徽章文本。 */
    function capText(caps) {
      if (!caps || typeof caps !== 'object') return null
      const parts = []
      const mcp = caps.mcpCapabilities || {}
      const mcpModes = ['http', 'sse'].filter((k) => mcp[k])
      if (mcpModes.length) parts.push(`MCP ${mcpModes.join('/')}`)
      const sessions = Object.keys(caps.sessionCapabilities || {})
      if (sessions.length) parts.push(`session ${sessions.join(',')}`)
      const prompt = Object.keys(caps.promptCapabilities || {}).filter((k) => caps.promptCapabilities[k])
      if (prompt.length) parts.push(`prompt ${prompt.join(',')}`)
      if (caps.agentInfo && caps.agentInfo.name) parts.push(`${caps.agentInfo.name} ${caps.agentInfo.version ?? ''}`.trim())
      if (typeof caps.latencyMs === 'number') parts.push(`${caps.latencyMs}ms`)
      return parts.length > 0 ? parts.join(' · ') : null
    }

    /** UI 打磨（2026-10-10）：时长格式化，给"运行中/上次回合"胶囊用。 */
    function fmtDur(ms) {
      const s = Math.max(0, Math.round(Number(ms) || 0) / 1000)
      if (s < 60) return `${s}s`
      const m = Math.floor(s / 60)
      if (m < 60) return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`
      return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
    }

    /**
     * UI 打磨（2026-10-10）：把引擎运行时观测（engineRuntime 快照）拆成独立诊断胶囊。
     * 之前是服务端拼好的一长串灰字（MCP：… · 引擎命令/技能：… · 权限：…），
     * 现在每项一个胶囊，并按语义着色：ok=正常、warn=需要注意、live=正在跑。
     * 返回 [{key, tone, text, title}]，纯函数便于单测。
     */
    function diagChips(rt, t) {
      const r = rt && typeof rt === 'object' ? rt : {}
      const chips = []
      const countText = (n) => (t('unitCount') ? `${n} ${t('unitCount')}` : `${n}`)

      // 0) 完全没跑过（连一次握手都没有）：不铺两三个"未上报"胶囊，收成一颗，减少噪音
      const touched = typeof r.mcpCount === 'number' || typeof r.commandCount === 'number' ||
        !!r.progressState || !!r.permissionReason || !!r.mcpAt || !!r.commandsAt
      if (!touched) {
        const empty = t('diagEmpty')
        if (empty && empty !== 'diagEmpty') chips.push({ key: 'empty', tone: '', text: empty })
        return chips
      }

      // 1) 下发给引擎的 MCP server 数
      if (typeof r.mcpCount !== 'number') {
        chips.push({ key: 'mcp', tone: '', text: `${t('diagMcp')}：${t('diagNoRun')}` })
      } else {
        chips.push({
          key: 'mcp', tone: r.mcpCount > 0 ? 'ok' : 'warn',
          text: `${t('diagMcp')}：${countText(r.mcpCount)}`, title: r.mcpSummary || '',
        })
      }

      // 2) 引擎上报的命令/技能数（available_commands_update）
      if (typeof r.commandCount !== 'number') {
        chips.push({ key: 'cmd', tone: '', text: `${t('diagCommands')}：${t('diagNoReport')}` })
      } else {
        chips.push({
          key: 'cmd', tone: r.commandCount > 0 ? 'ok' : 'warn',
          text: `${t('diagCommands')}：${countText(r.commandCount)}`,
          title: (r.commands || []).map((c) => (c && c.name) || String(c)).join(', '),
        })
      }

      // 3) 权限映射结果（preset → engine permissionMode）
      //    reason 是 permission-bridge 的字面量（mapped / no-preset / engine-unsupported /
      //    read-only-unsupported / workspace-write-asks / unmapped:<preset> / disabled），
      //    字典 key 与之严格同名，查不到再回落到 unmapped/unknown，绝不直接把 key 当文案显示。
      const reason = r.permissionReason
      if (reason && reason !== 'disabled') {
        const mapped = reason === 'mapped'
        const bare = String(reason).split(':')[0]
        const label = t(`permReason_${bare}`)
        const warnText = label === `permReason_${bare}`
          ? t('permReason_unmapped')
          : label
        const text = mapped
          ? `${t('diagPerm')}：${r.permissionPreset} → ${r.permissionMapped}`
          : `${t('diagPerm')}：${warnText}`
        chips.push({ key: 'perm', tone: mapped ? 'ok' : 'warn', text, title: r.permissionPoolKey || '' })
      } else if (reason === 'disabled') {
        chips.push({ key: 'perm', tone: '', text: `${t('diagPerm')}：${t('permReason_disabled')}` })
      }

      // 4) 回合进度 / 最近一次回合
      const running = r.progressState === 'running'
      if (running) {
        const tools = r.progressTools ? ` · ${r.progressTools} ${t('toolsCount')}` : ''
        chips.push({
          key: 'turn', tone: 'live',
          text: `${t('diagRunning')}${tools} · ${t('elapsed')} ${fmtDur(r.progressElapsedMs)}`,
          title: r.progressAt ? new Date(r.progressAt).toLocaleTimeString() : '',
        })
      } else if (typeof r.progressTools === 'number') {
        const tools = r.progressTools ? `${r.progressTools} ${t('toolsCount')}` : ''
        const parts = [t('diagIdle'), tools, r.progressElapsedMs ? `${t('elapsed')} ${fmtDur(r.progressElapsedMs)}` : '']
        chips.push({ key: 'turn', tone: '', text: parts.filter(Boolean).join(' · ') })
      }

      // 5) 最近一次握手时间（试连或真实会话都记）
      const at = r.mcpAt || r.commandsAt
      if (at) chips.push({ key: 'at', tone: '', text: `${t('diagHandshake')} ${new Date(at).toLocaleString()}` })

      return chips
    }

    function StateBadge(props) {
      const color = STATE_COLOR[props.state] || '#8b949e'
      return h('span', { className: 'macp-badge', style: { background: color } }, props.label)
    }

    function EngineManager(props) {
      const t = props.__t || ((k) => ZH[k] ?? k)
      useEffect(ensureStyles, [])
      const [rows, setRows] = useState(null)
      const [meta, setMeta] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState({})
      const [reports, setReports] = useState({})
      const [editing, setEditing] = useState(null)
      const [draft, setDraft] = useState(null)
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('all')
      /**
       * 【添加自定义 Agent】状态（2026-10-09）
       *   adding: null | 'menu' | 'manual' | 'discover'
       *   manual: { id, label, command, args, cwdPolicy, probing, probe, saving, error }
       *   discover: { hint, loading, results, error }
       */
      const [adding, setAdding] = useState(null)
      const [manual, setManual] = useState(null)
      const [discover, setDiscover] = useState(null)
      /**
       * 路径选择器状态：`{ index, path, data, loading, error }`。
       * 用宿主路由 `GET /multi-acp/browse?path=…` 列子目录 —— 不依赖 Electron 原生对话框，
       * 在 DSH 的 webview / 浏览器里都能用。
       */
      const [picker, setPicker] = useState(null)

      const openManual = () => {
        setAdding('manual')
        setManual({ id: '', label: '', command: '', args: 'acp', cwdPolicy: 'session', probing: false, probe: null, saving: false, error: null })
      }
      const openDiscover = () => {
        setAdding('discover')
        setDiscover({ hint: '', loading: false, results: null, error: null })
      }

      /** 手动添加：先跑一次真实 ACP 握手（POST /multi-acp/probe） */
      const runManualProbe = async () => {
        setManual((m) => ({ ...m, probing: true, error: null, probe: null }))
        try {
          const report = await fetchJson(`${API}/probe`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ command: manual.command, args: parseArgs(manual.args) }),
          })
          setManual((m) => ({ ...m, probing: false, probe: report }))
        } catch (e) {
          setManual((m) => ({ ...m, probing: false, error: String(e?.message ?? e) }))
        }
      }

      /** 保存新引擎（POST /multi-acp/engines） */
      const saveNewEngine = async () => {
        setManual((m) => ({ ...m, saving: true, error: null }))
        try {
          const id = (manual.id || manual.command || '').trim().replace(/[^\w.\-]+/g, '-').toLowerCase()
          await fetchJson(`${API}/engines`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id,
              label: manual.label || manual.command,
              command: manual.command,
              args: parseArgs(manual.args),
              cwdPolicy: manual.cwdPolicy,
              enabled: true,
            }),
          })
          setAdding(null)
          setManual(null)
          load()
        } catch (e) {
          setManual((m) => ({ ...m, saving: false, error: String(e?.message ?? e) }))
        }
      }

      /** 通过对话添加：给个线索，让宿主扫描 + 逐个探测（POST /multi-acp/discover） */
      const runDiscover = async () => {
        setDiscover((d) => ({ ...(d ?? {}), loading: true, error: null }))
        try {
          const report = await fetchJson(`${API}/discover`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hint: discover?.hint ?? '' }),
          })
          setDiscover((d) => ({ ...(d ?? {}), loading: false, results: report }))
        } catch (e) {
          setDiscover((d) => ({ ...(d ?? {}), loading: false, error: String(e?.message ?? e) }))
        }
      }

      /** 把探测成功的候选一键加进引擎表 */
      const addDiscovered = async (candidate) => {
        try {
          await fetchJson(`${API}/engines`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: candidate.id || candidate.command,
              label: candidate.label,
              command: candidate.resolved ?? candidate.command,
              args: candidate.args ?? [],
              cwdPolicy: 'session',
              enabled: true,
            }),
          })
          setAdding(null)
          setDiscover(null)
          load()
        } catch (e) {
          setDiscover((d) => ({ ...(d ?? {}), error: String(e?.message ?? e) }))
        }
      }

      /** 打开选择器并加载某个目录（index = 要回填的 skillsDirs 下标）。 */
      const openPicker = async (index, path) => {
        setPicker({ index, path: path || '', data: null, loading: true, error: null })
        await loadBrowse(index, path || '')
      }

      const loadBrowse = async (index, path) => {
        setPicker((p) => ({ ...(p ?? { index }), index, path, loading: true, error: null }))
        try {
          const data = await fetchJson(`${API}/browse?path=${encodeURIComponent(path ?? '')}`)
          setPicker((p) => ({ ...(p ?? { index }), index, path: data.path, data, loading: false, error: data.error ?? null }))
        } catch (e) {
          setPicker((p) => ({ ...(p ?? { index }), index, path, loading: false, error: String(e?.message ?? e) }))
        }
      }

      const load = () => {
        setError(null)
        fetchJson(`${API}/engines`)
          .then((body) => {
            setMeta(body || null)
            setRows(Array.isArray(body?.engines) ? body.engines : [])
          })
          .catch((e) => setError(String(e?.message ?? e)))
      }
      useEffect(() => {
        load()
        // B2（2026-10-10）：引擎行诊断行里有"运行中：第 N 次工具调用 · 已耗时 3m20s"这类进度，
        // 面板开着时每 3 秒静默刷新一次，让数字动起来。
        // ⚠️ 只在真实浏览器里开：node 单测环境没有 `document`，避免定时器把测试进程挂住。
        if (typeof document === 'undefined' || typeof setInterval !== 'function') return undefined
        const timer = setInterval(() => { load() }, 3000)
        return () => clearInterval(timer)
      }, [])

      const setBusyId = (id, value) => setBusy((b) => {
        const next = { ...b }
        if (value === null) delete next[id]
        else next[id] = value
        return next
      })

      const test = async (id) => {
        setBusyId(id, 'test')
        setError(null)
        try {
          const report = await fetchJson(`${API}/engines/${encodeURIComponent(id)}/test`, { method: 'POST' })
          setReports((p) => ({ ...p, [id]: report }))
        } catch (e) {
          setReports((p) => ({ ...p, [id]: { ok: false, error: String(e?.message ?? e) } }))
        } finally {
          setBusyId(id, null)
        }
      }

      /** B4：进入编辑态 —— 环境变量拆成行，启动方式预填当前覆盖值。 */
      const startEdit = (row) => {
        setEditing(row.id)
        setDraft({
          env: Object.entries(row.env || {}).map(([key, value]) => ({ key, value: String(value ?? '') })),
          removed: [],
          reveal: {},
          showLaunch: false,
          resolvedCommand: row.resolvedCommand ?? '',
          args: Array.isArray(row.args) ? row.args.join(' ') : '',
          cwdPolicy: row.cwdPolicy ?? 'session',
          mcp: row.mcp === 'none' || row.mcp === false ? 'none' : 'inherit',
          // SKILLS（2026-10-09）：投递方式 + 目录行（目录为空 = 后端用默认 ~/.agents/skills）
          skillDelivery: row.skills?.delivery ?? 'auto',
          skillsDirs: (row.skills?.dirs ?? []).map((d) => ({ path: d.path, exists: d.exists, count: d.count })),
          // 权限档（2026-10-10）：default（交互确认）/ dont_ask（无人值守）/ bypass（跳过检查）
          permissionMode: row.permission?.mode ?? 'default',
          // 超时（A16）：总时长闸 / 空闲闸（空字符串 = 用插件默认）
          promptTimeoutMs: row.promptTimeoutMs === null || row.promptTimeoutMs === undefined ? '' : String(row.promptTimeoutMs),
          idleTimeoutMs: row.idleTimeoutMs === null || row.idleTimeoutMs === undefined ? '' : String(row.idleTimeoutMs),
        })
      }

      const mutate = (partial) => setDraft((d) => ({ ...d, ...partial }))

      const save = async (row) => {
        setBusyId(row.id, 'save')
        setError(null)
        try {
          const patch = { env: envPatch(draft.env, draft.removed), mcp: draft.mcp }
          const cmd = String(draft.resolvedCommand ?? '').trim()
          if (cmd) patch.resolvedCommand = cmd
          const argsText = String(draft.args ?? '').trim()
          const currentArgs = Array.isArray(row.args) ? row.args.join(' ') : ''
          if (argsText !== currentArgs) patch.args = parseArgs(argsText)
          if (draft.cwdPolicy) patch.cwdPolicy = draft.cwdPolicy
          // SKILLS：投递方式 + 目录列表（空目录列表会让后端回落到默认 ~/.agents/skills）
          if (draft.skillDelivery) patch.skillDelivery = draft.skillDelivery
          patch.skillsDirs = (draft.skillsDirs ?? []).map((d) => String(d.path ?? '').trim()).filter(Boolean)
          // 权限档
          if (draft.permissionMode) patch.permissionMode = draft.permissionMode
          // 超时（A16）：留空 = 不改（沿用插件默认）；填 0 = 关闭该闸
          if (String(draft.promptTimeoutMs ?? '').trim() !== '') patch.promptTimeoutMs = Number(draft.promptTimeoutMs)
          if (String(draft.idleTimeoutMs ?? '').trim() !== '') patch.idleTimeoutMs = Number(draft.idleTimeoutMs)
          await fetchJson(`${API}/engines/${encodeURIComponent(row.id)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          setEditing(null)
          setDraft(null)
          await test(row.id)
          load()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setBusyId(row.id, null)
        }
      }

      /** 启用 / 停用（mergeEnginePatch 支持 enabled）。 */
      const toggleEnabled = async (row) => {
        setBusyId(row.id, 'toggle')
        try {
          await fetchJson(`${API}/engines/${encodeURIComponent(row.id)}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: !row.enabled }),
          })
          load()
        } catch (e) {
          setError(String(e?.message ?? e))
        } finally {
          setBusyId(row.id, null)
        }
      }

      const stateLabel = (state) => t(`state_${String(state).replace(/-/g, '_')}`)

      const counts = { all: (rows || []).length, available: 0, not_installed: 0, unavailable: 0 }
      for (const r of rows || []) {
        const key = stateLabelKey(r)
        if (counts[key] !== undefined) counts[key] += 1
      }

      const visible = (rows || []).filter((row) => {
        if (filter !== 'all' && stateLabelKey(row) !== filter) return false
        const q = query.trim().toLowerCase()
        if (!q) return true
        const hay = [row.id, row.label?.zh, row.label?.en, row.executable, row.command].filter(Boolean).join(' ').toLowerCase()
        return hay.includes(q)
      })

      const children = []
      children.push(h('div', { className: 'macp-head', key: 'head' },
        h('div', { className: 'macp-title' }, t('title')),
        // 2026-10-09：右上角显示插件名 + 版本号（来自 /multi-acp/engines 的 plugin 字段）
        meta?.plugin
          ? h('span', { className: 'macp-plugin', key: 'plugin', title: meta.plugin.description ?? '' },
              `${meta.plugin.name} v${meta.plugin.version}`)
          : null,
        h('button', { className: 'macp-btn', onClick: load, style: { marginLeft: 'auto' } }, t('refresh')),
      ))
      children.push(h('div', { className: 'macp-sub', key: 'sub' }, t('subtitle')))
      if (meta) {
        children.push(h('div', { className: 'macp-sub', key: 'default' },
          `${t('defaultEngine')}: ${meta.defaultEngine || t('officialDsh')}`))
      }

      // 四态过滤桶 + 搜索（设计稿 §4.1）
      const chip = (id, label) => h('button', {
        key: `chip-${id}`,
        className: `macp-chip${filter === id ? ' macp-chip-on' : ''}`,
        onClick: () => setFilter(id),
      }, `${label} ${counts[id] ?? 0}`)
      children.push(h('div', { className: 'macp-tools', key: 'tools' },
        chip('all', t('filter_all')),
        chip('available', t('filter_available')),
        chip('not_installed', t('filter_not_installed')),
        chip('unavailable', t('filter_unavailable')),
        h('input', {
          key: 'search',
          className: 'macp-search',
          placeholder: t('search'),
          value: query,
          onChange: (e) => setQuery(e.target.value),
          style: { marginLeft: 'auto' },
        }),
      ))

      // ── 【添加自定义 Agent】入口（2026-10-09）──────────────────────────
      children.push(h('div', { className: 'macp-tools', key: 'add-agent' },
        h('button', {
          className: 'macp-btn macp-btn-primary',
          onClick: () => setAdding(adding === 'menu' ? null : 'menu'),
        }, `${t('addAgent')} ${adding === 'menu' ? '▴' : '▾'}`),
        adding === 'menu'
          ? h('span', { key: 'menu' },
              h('button', { className: 'macp-btn', style: { marginLeft: 6 }, onClick: openManual }, t('addManual')),
              h('button', { className: 'macp-btn', style: { marginLeft: 6 }, onClick: openDiscover }, t('addByChat')),
            )
          : null,
      ))

      if (adding === 'manual' && manual) {
        const probe = manual.probe
        children.push(h('div', { className: 'macp-picker', key: 'manual' },
          h('div', { className: 'macp-launch' },
            h('span', { className: 'macp-legend' }, t('addManual')),
            h('button', { className: 'macp-btn', style: { marginLeft: 'auto' }, onClick: () => { setAdding(null); setManual(null) } }, t('cancel')),
          ),
          h('div', { className: 'macp-hint' }, t('manualHint')),
          h('div', { className: 'macp-launch' },
            h('span', { className: 'macp-legend' }, t('engineId')),
            h('input', { className: 'macp-in', style: { width: 140 }, value: manual.id, placeholder: 'mytool', onChange: (e) => setManual({ ...manual, id: e.target.value }) }),
            h('span', { className: 'macp-legend' }, t('engineLabel')),
            h('input', { className: 'macp-in', style: { flex: 1, minWidth: 120 }, value: manual.label, placeholder: 'My Tool', onChange: (e) => setManual({ ...manual, label: e.target.value }) }),
          ),
          h('div', { className: 'macp-launch' },
            h('span', { className: 'macp-legend' }, t('command')),
            h('input', { className: 'macp-in', style: { flex: 1, minWidth: 160 }, value: manual.command, placeholder: 'mytool  /  C:\\path\\to\\cli.exe', onChange: (e) => setManual({ ...manual, command: e.target.value }) }),
          ),
          h('div', { className: 'macp-launch' },
            h('span', { className: 'macp-legend' }, t('args')),
            h('input', { className: 'macp-in', style: { flex: 1, minWidth: 160 }, value: manual.args, placeholder: 'acp', onChange: (e) => setManual({ ...manual, args: e.target.value }) }),
            h('select', { className: 'macp-in', value: manual.cwdPolicy, onChange: (e) => setManual({ ...manual, cwdPolicy: e.target.value }) },
              h('option', { value: 'session' }, t('cwdSession')),
              h('option', { value: 'fixed' }, t('cwdFixed')),
            ),
          ),
          manual.error ? h('div', { className: 'macp-err' }, manual.error) : null,
          probe
            ? h('div', { className: probe.ok ? 'macp-hint' : 'macp-err' },
                probe.ok
                  ? `${t('probeOk')} · ${probe.agentInfo?.name ?? '?'} ${probe.agentInfo?.version ?? ''} · ${probe.ms}ms`
                  : `${t('probeFail')}: ${probe.error}`)
            : null,
          h('div', { className: 'macp-save' },
            h('button', { className: 'macp-btn', disabled: manual.probing || !manual.command, onClick: runManualProbe }, manual.probing ? t('probing') : t('probe')),
            h('button', { className: 'macp-btn', disabled: manual.saving || !manual.command || !(probe?.ok), onClick: saveNewEngine },
              manual.saving ? t('loading') : t('saveEngine')),
            !probe?.ok ? h('span', { className: 'macp-hint' }, t('probeFirst')) : null,
          ),
        ))
      }

      if (adding === 'discover' && discover) {
        const report = discover.results
        children.push(h('div', { className: 'macp-picker', key: 'discover' },
          h('div', { className: 'macp-launch' },
            h('span', { className: 'macp-legend' }, t('addByChat')),
            h('button', { className: 'macp-btn', style: { marginLeft: 'auto' }, onClick: () => { setAdding(null); setDiscover(null) } }, t('cancel')),
          ),
          h('div', { className: 'macp-hint' }, t('discoverHint')),
          h('div', { className: 'macp-launch' },
            h('input', {
              className: 'macp-in',
              style: { flex: 1, minWidth: 160 },
              placeholder: t('discoverPlaceholder'),
              value: discover.hint,
              onChange: (e) => setDiscover({ ...discover, hint: e.target.value }),
            }),
            h('button', { className: 'macp-btn', disabled: discover.loading, onClick: runDiscover }, discover.loading ? t('discovering') : t('discover')),
          ),
          discover.error ? h('div', { className: 'macp-err' }, discover.error) : null,
          report
            ? h('div', { className: 'macp-picker-list' },
                report.results.length === 0
                  ? h('div', { className: 'macp-hint' }, t('noCandidates'))
                  : report.results.map((r) => h('div', { className: 'macp-launch', key: r.resolved ?? r.command, style: { width: '100%' } },
                      h('span', { className: 'macp-badge-plain', style: r.ok ? { color: '#2ea043', borderColor: '#2ea043' } : { color: '#d29922', borderColor: '#d29922' } },
                        r.ok ? `${r.agentInfo?.name ?? 'ACP'} ${r.agentInfo?.version ?? ''}` : t('probeFail')),
                      h('span', { className: 'macp-meta', style: { marginTop: 0, flex: 1, textAlign: 'left' } },
                        `${r.label} · ${r.resolved ?? r.command} ${(r.args ?? []).join(' ')}${r.ok ? ` · ${r.ms}ms` : ` · ${r.error ?? ''}`}`),
                      r.ok ? h('button', { className: 'macp-btn', onClick: () => addDiscovered(r) }, t('addThis')) : null,
                    )),
              )
            : null,
        ))
      }

      if (error) children.push(h('div', { className: 'macp-err', key: 'err' }, error))
      if (rows === null) children.push(h('div', { className: 'macp-sub', key: 'loading', style: { marginTop: 10 } }, t('loading')))
      else if (rows.length === 0) children.push(h('div', { className: 'macp-sub', key: 'empty', style: { marginTop: 10 } }, t('empty')))
      else if (visible.length === 0) children.push(h('div', { className: 'macp-sub', key: 'norows', style: { marginTop: 10 } }, t('noRows')))

      for (const row of visible) {
        const isBusy = busy[row.id]
        const report = reports[row.id]
        const isDefault = !!meta?.defaultEngine && meta.defaultEngine === row.id
        const actions = h('div', { className: 'macp-actions' },
          h('button', { className: 'macp-btn', disabled: !!isBusy, onClick: () => test(row.id), key: 'test' },
            isBusy === 'test' ? t('testing') : t('test')),
          h('button', { className: 'macp-btn', disabled: !!isBusy, onClick: () => startEdit(row), key: 'edit' }, t('edit')),
          h('button', { className: 'macp-btn', disabled: !!isBusy, onClick: () => toggleEnabled(row), key: 'toggle' },
            row.enabled ? t('disable') : t('enable')),
        )
        // ── UI 打磨（2026-10-10）───────────────────────────────────────────────
        // 以前这里是 5~6 行等宽灰字（可执行体 / launch / SKILLS / 权限 / 诊断）全糊成一片，
        // 现在拆成三层：① 两列网格（标签 + 等宽值，扫读友好）
        //              ② 能力胶囊（引擎自报的能力/版本/握手耗时）
        //              ③ 运行时胶囊（MCP / 引擎命令·技能 / 权限映射 / 回合进度 / 最近握手）
        const metaRows = [
          ['exec', t('executable'), row.executable || '—', row.executable ? 'macp-mono' : 'macp-mono macp-warn'],
          // B4-①：始终显示当前生效的启动方式（未覆盖时 = 内置 command/args）
          ['launch', t('launchLabel'),
            `${row.resolvedCommand || row.command || '—'}${(row.args || []).length ? ` ${(row.args || []).join(' ')}` : ''}` +
            ` · cwdPolicy=${row.cwdPolicy ?? 'session'}`,
            'macp-mono'],
        ]
        if (row.skills) {
          const extra = row.skills.delivery === 'args' && (row.skills.mounted ?? []).length
            ? ` · ${t('extraArgs')}: ${row.skills.mounted.join(' ')}`
            : ''
          metaRows.push(['skills', t('skillsSummary'), `${row.skills.delivery} · ${row.skills.summary}${extra}`, ''])
        }
        // 权限档摘要（2026-10-10）：网格化后一律显示（统一行高，避免"有的引擎没这行"的跳变）
        if (row.permission && row.permission.mode) {
          const pm = row.permission
          metaRows.push(['perm', t('permissionTitle'),
            `${pm.mode}` +
            ((pm.args ?? []).length ? ` · ${t('extraArgs')}: ${pm.args.join(' ')}` : '') +
            (pm.mode === 'bypass' ? ` · ⚠️ ${t('permSkipped')}` : ''),
            pm.mode === 'bypass' ? 'macp-warn' : ''])
        }
        // 超时：行上有生效值就用行上的，否则回落到 /engines 的 defaults（0 = 不限）
        const dflt = (meta && meta.defaults) || {}
        const overall = row.promptTimeoutMs ?? dflt.promptTimeoutMs ?? 0
        metaRows.push(['timeout', t('timeoutTitle'),
          `${t('timeoutIdle')} ${row.idleTimeoutMs ?? dflt.idleTimeoutMs ?? 180000} · ` +
          `${t('timeoutOverall')} ${overall === 0 ? t('timeoutUnlimited') : overall}`,
          'macp-mono'])
        const rowChildren = [
          h('div', { className: 'macp-rowtop', key: 'top' },
            h('span', { className: 'macp-name' }, (row.label && (row.label.zh || row.label.en)) || row.id),
            h(StateBadge, { state: row.state, label: stateLabel(row.state), key: 'badge' }),
            isDefault ? h('span', { className: 'macp-badge-plain', key: 'def' }, t('isDefault')) : null,
            actions,
          ),
          h('div', { className: 'macp-grid', key: 'grid' }, metaRows.flatMap(([k, label, value, cls]) => [
            h('div', { className: 'macp-k2', key: `k-${k}` }, label),
            // 值一律单行省略号（设置弹窗很窄，长路径换行会把行撑高）+ title 兜底看全量
            h('div', { className: `macp-v2${cls ? ` ${cls}` : ''}`, title: String(value), key: `v-${k}` }, value),
          ])),
        ]
        // 能力胶囊（ISSUE-07）：引擎自报能力，拆成一颗颗小药丸
        const caps = capText(row.capabilities)
        if (caps) {
          rowChildren.push(h('div', { className: 'macp-diagwrap', key: 'caps' },
            caps.split(' · ').map((part, i) => h('span', { className: 'macp-dchip macp-dchip-cap', key: `cap-${i}` }, part))))
        }
        // 运行时胶囊（B4）：MCP 下发 + 引擎上报的命令/技能 + 权限映射 + 回合进度 + 最近握手
        const chips = diagChips(row.runtime, t)
        if (chips.length) {
          rowChildren.push(h('div', { className: 'macp-diagwrap', key: 'diag' },
            chips.map((c) => h('span', {
              className: `macp-dchip${c.tone ? ` macp-dchip-${c.tone}` : ''}`,
              title: c.title || undefined,
              key: c.key,
            }, c.text))))
        } else if (row.diagnostic) {
          rowChildren.push(h('div', { className: 'macp-diagwrap', key: 'diag' },
            h('span', { className: 'macp-dchip' }, row.diagnostic)))
        }
        if (report) {
          rowChildren.push(h('div', { className: 'macp-pre', key: 'report' },
            report.ok
              ? `${t('connected')} · ${report.totalMs ?? '?'}ms` +
                (report.agentInfo ? ` · ${report.agentInfo.name} ${report.agentInfo.version ?? ''}` : '')
              : `${t('failed')}: ${report.error ?? 'unknown'}`,
          ))
        }
        if (editing === row.id && draft) rowChildren.push(renderEditor(row, draft, { t, isBusy, mutate, save, cancel: () => { setEditing(null); setDraft(null) }, picker, openPicker, loadBrowse, closePicker: () => setPicker(null), defaults: meta?.defaults }))
        children.push(h('div', { className: `macp-row macp-row-s-${row.state || 'unknown'}`, key: row.id }, rowChildren))
      }

      return h('div', { className: 'macp-wrap' }, children)
    }

    /**
     * 路径选择器面板（2026-10-09）。
     *
     * 数据来自宿主 `GET /multi-acp/browse?path=…`（只列子目录）；点目录进入、`上级`回退、
     * `选择此目录` 回填到对应的 skillsDirs 行。纯 DOM 实现，不依赖 Electron 原生对话框。
     */
    function renderPicker(api, draft, mutate) {
      const picker = api.picker
      const t = api.t
      if (!picker || picker.index === undefined) return null
      const data = picker.data
      const children = []
      children.push(h('div', { className: 'macp-launch', key: 'p-head' },
        h('span', { className: 'macp-legend' }, t('pickerTitle')),
        h('span', { className: 'macp-meta', style: { flex: 1, marginTop: 0, wordBreak: 'break-all' } }, picker.path || '…'),
        data?.parent ? h('button', { className: 'macp-btn', onClick: () => api.loadBrowse(picker.index, data.parent) }, t('pickerUp')) : null,
        h('button', { className: 'macp-btn', onClick: api.closePicker }, t('cancel')),
      ))
      if (picker.loading) children.push(h('div', { className: 'macp-hint', key: 'p-loading' }, t('loading')))
      if (picker.error) children.push(h('div', { className: 'macp-err', key: 'p-err' }, picker.error))
      if (data?.quick?.length) {
        children.push(h('div', { className: 'macp-launch', key: 'p-quick' },
          h('span', { className: 'macp-legend' }, t('pickerQuick')),
          ...data.quick.map((q, i) => h('button', {
            className: 'macp-chip',
            key: `q-${i}`,
            title: q.path,
            onClick: () => api.loadBrowse(picker.index, q.path),
          }, q.label)),
        ))
      }
      if (data && !picker.loading) {
        children.push(h('div', { className: 'macp-picker-list', key: 'p-list' },
          data.dirs.length === 0
            ? h('div', { className: 'macp-hint' }, t('pickerEmpty'))
            : data.dirs.map((d) => h('button', {
                className: 'macp-picker-item',
                key: d.path,
                title: d.path,
                onClick: () => api.loadBrowse(picker.index, d.path),
              }, '📁 ' + d.name)),
        ))
        children.push(h('div', { className: 'macp-save', key: 'p-save' },
          h('button', {
            className: 'macp-btn',
            disabled: !data.exists,
            onClick: () => {
              mutate({
                skillsDirs: (draft.skillsDirs ?? []).map((d, i) => (i === picker.index ? { ...d, path: picker.path } : d)),
              })
              api.closePicker?.()
            },
          }, t('pickerChoose')),
        ))
      }
      return h('div', { className: 'macp-picker', key: 'picker' }, children)
    }

    /** 状态 → 过滤桶 key（disabled 归到不可用桶，避免出现第五个桶）。 */
    function stateLabelKey(row) {
      const state = row.state === 'disabled' ? 'unavailable' : row.state
      return state || 'unavailable'
    }

    /** B4-① / B4-② 的编辑面板。 */
    function renderEditor(row, draft, api) {
      const { t, isBusy, mutate, save, cancel } = api
      const envRows = []

      envRows.push(h('div', { className: 'macp-sub', key: 'envtitle', style: { fontWeight: 600 } }, t('envTitle')))
      envRows.push(h('div', { className: 'macp-hint', key: 'envhint' }, t('envHint')))

      draft.env.forEach((item, index) => {
        const revealed = !!draft.reveal[index]
        envRows.push(h('div', { className: 'macp-envrow', key: `env-${index}` },
          h('input', {
            className: 'macp-in macp-k',
            placeholder: 'KEY',
            value: item.key,
            onChange: (e) => mutate({ env: draft.env.map((v, i) => (i === index ? { ...v, key: e.target.value } : v)) }),
          }),
          h('input', {
            className: 'macp-in macp-v',
            placeholder: 'VALUE',
            type: revealed ? 'text' : 'password',
            value: item.value,
            onChange: (e) => mutate({ env: draft.env.map((v, i) => (i === index ? { ...v, value: e.target.value } : v)) }),
          }),
          h('button', {
            className: 'macp-btn',
            title: revealed ? t('hide') : t('show'),
            onClick: () => mutate({ reveal: { ...draft.reveal, [index]: !revealed } }),
          }, revealed ? '🙈' : '👁'),
          h('button', {
            className: 'macp-btn',
            title: t('remove'),
            onClick: () => mutate({
              env: draft.env.filter((_, i) => i !== index),
              // 已保存过的键必须记进 removed，保存时下发 `KEY: null` 才删得掉
              removed: item.key.trim() && row.env && Object.prototype.hasOwnProperty.call(row.env, item.key.trim())
                ? [...draft.removed, item.key.trim()]
                : draft.removed,
            }),
          }, '🗑'),
        ))
      })

      envRows.push(h('button', {
        className: 'macp-btn',
        key: 'add',
        style: { marginTop: 6 },
        onClick: () => mutate({ env: [...draft.env, { key: '', value: '' }] }),
      }, t('addVar')))

      // B4-①：启动方式覆盖
      const launchBody = []
      if (draft.showLaunch) {
        launchBody.push(h('div', { className: 'macp-launch', key: 'launch-row' },
          h('span', { className: 'macp-legend' }, t('command')),
          h('input', {
            className: 'macp-in',
            style: { flex: 1, minWidth: 160 },
            placeholder: row.executable || row.command || '',
            value: draft.resolvedCommand,
            onChange: (e) => mutate({ resolvedCommand: e.target.value }),
          }),
        ))
        launchBody.push(h('div', { className: 'macp-launch', key: 'args-row' },
          h('span', { className: 'macp-legend' }, t('args')),
          h('input', {
            className: 'macp-in',
            style: { flex: 1, minWidth: 160 },
            value: draft.args,
            onChange: (e) => mutate({ args: e.target.value }),
          }),
        ))
        launchBody.push(h('div', { className: 'macp-launch', key: 'cwd-row' },
          h('span', { className: 'macp-legend' }, t('cwdPolicy')),
          h('select', {
            className: 'macp-in',
            value: draft.cwdPolicy,
            onChange: (e) => mutate({ cwdPolicy: e.target.value }),
          },
          h('option', { value: 'session' }, t('cwdSession')),
          h('option', { value: 'fixed' }, t('cwdFixed')),
          ),
        ))
      }

      /**
       * SKILLS 配置块（2026-10-09 新增）。
       *
       * 为什么需要它：ACP **协议里没有 skills 字段**（`session/new` 只有 `cwd`/`mcpServers`），
       * 技能"共享"靠磁盘目录。三种投递方式：
       *   auto —— 引擎自扫通用目录（omp/OpenCode 认 `~/.agents/skills`，DSH 的 skill 就在那）；
       *   args —— 启动时追加 `--skill <dir>`（Command Code 属于这种，实测有效）；
       *   none —— 不下发。
       * 目录状态（存在/数量）由宿主 `describeSkills()` 探测后随引擎列表带回，这里只渲染。
       */
      const skillDirs = draft.skillsDirs ?? []
      const skillsBlock = h('div', { key: 'skills', style: { marginTop: 10 } },
        h('div', { className: 'macp-launch', key: 'skills-row' },
          h('span', { className: 'macp-legend' }, t('skillsTitle')),
          h('select', {
            className: 'macp-in',
            value: draft.skillDelivery,
            onChange: (e) => mutate({ skillDelivery: e.target.value }),
          },
          h('option', { value: 'auto' }, t('skillsAuto')),
          h('option', { value: 'args' }, t('skillsArgs')),
          h('option', { value: 'none' }, t('skillsNone')),
          ),
        ),
        h('div', { className: 'macp-hint', key: 'skills-hint' }, t('skillsHint')),
        ...skillDirs.map((dir, index) =>
          h('div', { className: 'macp-skillrow', key: `skillsdir-${index}` },
            h('input', {
              className: 'macp-in macp-v',
              placeholder: '%USERPROFILE%\\.agents\\skills',
              value: dir.path,
              onChange: (e) => mutate({ skillsDirs: skillDirs.map((d, i) => (i === index ? { ...d, path: e.target.value } : d)) }),
            }),
            h('span', {
              className: 'macp-badge-plain',
              title: dir.path,
              style: dir.exists ? { color: '#2ea043', borderColor: '#2ea043' } : { color: '#d29922', borderColor: '#d29922' },
            }, dir.exists ? t('skillsFound').replace('{n}', String(dir.count ?? 0)) : t('skillsMissing')),
            h('button', {
              className: 'macp-btn',
              title: t('pickerTitle'),
              onClick: () => api.openPicker?.(index, dir.path),
            }, '📁'),
            h('button', {
              className: 'macp-btn',
              title: t('remove'),
              onClick: () => mutate({ skillsDirs: skillDirs.filter((_, i) => i !== index) }),
            }, '🗑'),
          ),
        ),
        h('button', {
          className: 'macp-btn',
          key: 'skills-add',
          style: { marginTop: 6 },
          onClick: () => mutate({ skillsDirs: [...skillDirs, { path: '', exists: false, count: 0 }] }),
        }, t('skillsAdd')),
        renderPicker(api, draft, mutate),
      )

      // B1：MCP 下发策略（任务 4 的 UI 面）
      const mcpRow = h('div', { className: 'macp-launch', key: 'mcp-row' },
        h('span', { className: 'macp-legend' }, t('mcpTitle')),
        h('select', {
          className: 'macp-in',
          value: draft.mcp,
          onChange: (e) => mutate({ mcp: e.target.value }),
        },
        h('option', { value: 'inherit' }, t('mcpInherit')),
        h('option', { value: 'none' }, t('mcpNone')),
        ),
      )

      // 权限档（2026-10-10）：无人值守任务的关键开关
      //   default  —— 引擎照常发 ACP 权限请求（交互会话安全档）
      //   dont_ask —— 引擎不再询问（cron/定时任务推荐：否则 DSH 无人批准 ⇒ 全通道被拒）
      //   bypass   —— 完全跳过权限检查（危险）
      // 未声明模板的档位禁用并给出说明（各家 CLI 开关不同）
      const permission = row.permission ?? {}
      const supported = Array.isArray(permission.supported) ? permission.supported : ['default']
      const permissionRow = h('div', { className: 'macp-launch', key: 'perm-row' },
        h('span', { className: 'macp-legend' }, t('permissionTitle')),
        h('select', {
          className: 'macp-in',
          value: draft.permissionMode,
          onChange: (e) => mutate({ permissionMode: e.target.value }),
        },
        h('option', { value: 'default' }, t('permDefault')),
        h('option', { value: 'dont_ask', disabled: !supported.includes('dont_ask') }, t('permDontAsk')),
        h('option', { value: 'bypass', disabled: !supported.includes('bypass') }, t('permBypass')),
        ),
        draft.permissionMode !== 'default' && (permission.templates?.[draft.permissionMode] ?? []).length
          ? h('span', { className: 'macp-hint' }, `→ ${(permission.templates?.[draft.permissionMode] ?? []).join(' ')}`)
          : null,
      )
      // 2026-10-10：会话权限档 → 引擎档的自动映射（见 lib/permission-bridge.js）
      const permissionHint = h('div', { className: 'macp-hint', key: 'perm-hint' },
        t('permissionAutoHint') +
          (supported.includes('dont_ask') && supported.includes('bypass')
            ? ''
            : ` ⚠️ ${t('permissionUnsupported')}`))

      /**
       * 超时（A16，2026-10-10）：两闸并排。
       *   · 空闲闸（主闸）：多久**没有任何 session/update** 才算卡死 —— 默认 180000；
       *   · 总时长闸：墙钟上限，**0 = 不限** —— 长任务（定时采集等）建议 0，否则会把正在干活的
       *     引擎误杀（实测 session-503ea973：omp 跑完 21 次工具调用仍在思考时被 300s 掐断）。
       * 留空 = 沿用插件默认（右上角…见 `/engines` 的 defaults）。
       */
      const timeoutsRow = (() => {
        const rowDefaults = api.defaults ?? {}
        return h('div', { className: 'macp-launch', key: 'timeout-row' },
        h('span', { className: 'macp-legend' }, t('timeoutTitle')),
        h('span', { className: 'macp-legend' }, t('timeoutIdle')),
        h('input', {
          className: 'macp-in',
          style: { width: 100 },
          placeholder: String(rowDefaults?.idleTimeoutMs ?? 180000),
          value: draft.idleTimeoutMs,
          onChange: (e) => mutate({ idleTimeoutMs: e.target.value }),
        }),
        h('span', { className: 'macp-legend' }, t('timeoutOverall')),
        h('input', {
          className: 'macp-in',
          style: { width: 100 },
          placeholder: String(rowDefaults?.promptTimeoutMs ?? 0),
          value: draft.promptTimeoutMs,
          onChange: (e) => mutate({ promptTimeoutMs: e.target.value }),
        }),
        )
      })()
      const timeoutsHint = h('div', { className: 'macp-hint', key: 'timeout-hint' }, t('timeoutHint'))

      return h('div', { className: 'macp-edit', key: 'edit' },
        envRows,
        h('div', { key: 'launch', style: { marginTop: 10 } },
          h('button', {
            className: 'macp-btn',
            onClick: () => mutate({ showLaunch: !draft.showLaunch }),
          }, draft.showLaunch ? `${t('launchOverride')} ▾ ${t('launchCollapse')}` : `${t('launchOverride')} ▸`),
          h('div', { className: 'macp-hint' },
            `${t('launchTitle')}: ${draft.resolvedCommand || row.executable || row.command || '—'} ${draft.args}` +
            ` · cwdPolicy=${draft.cwdPolicy}`),
          launchBody,
          mcpRow,
          permissionRow,
          permissionHint,
          timeoutsRow,
          timeoutsHint,
        ),
        skillsBlock,
        h('div', { className: 'macp-save', key: 'save' },
          h('button', { className: 'macp-btn', disabled: !!isBusy, onClick: () => save(row) }, isBusy === 'save' ? t('testing') : t('save')),
          h('button', { className: 'macp-btn', disabled: !!isBusy, onClick: cancel }, t('cancel')),
        ),
      )
    }

    module.exports = {
      name: CLIENT_NAME,
      // ⚠️ 客户端模块**必须**静态声明所依赖的服务，否则访问 `ctx.locale` / `ctx.slots`
      //    会抛 `cannot get property "…" without inject`，导致该入口激活失败并中止 web boot。
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
        try {
          if (ctx.locale && typeof ctx.locale.register === 'function') {
            ctx.locale.register(NS, 'zh', ZH)
            ctx.locale.register(NS, 'en', EN)
          }
        } catch (e) { try { console.error('[dsh-multi-acp] locale:', e) } catch {} }

        let t = (key) => (ZH[key] !== undefined ? ZH[key] : key)
        try {
          const bound = ctx.locale && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : null
          if (bound) t = (key) => bound(key) || key
        } catch { /* keep fallback */ }

        ctx.effect(
          () => ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: CLIENT_NAME,
            order: 92,
            locale: NS,
            label: () => t('title'),
            inject: () => ({}),
          }, function MultiAcpSettingsSection() {
            return h(EngineManager, { __t: t })
          })),
          'dsh-multi-acp: settings section',
        )
        } catch (e) {
          // 韧性（v0.1.12 教训）：客户端注册失败**绝不** rethrow —— 否则 web boot 会因
          // 单个插件整体中止、DSH 起不来。这里只记录日志。
          try { console.error('[dsh-multi-acp] client apply failed:', e) } catch {}
        }
      },
    }

    return module.exports
  },
})
