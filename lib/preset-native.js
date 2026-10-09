/**
 * ACP preset 的**原生工具组合**（native tool composition）。
 *
 * ── 为什么需要这个模块（用户 2026-10-09 反馈的实际缺陷）────────────────────
 * 在 v0.1.14 之前，本插件给每个引擎注册的 preset 组合里**只有一行 marker**：
 *
 *   plugins: [{ name: 'dsh-multi-acp/preset-marker', config: { engineId } }]
 *
 * DSH 的 preset 是"**一层组合**"：`docs/evidence/P0-step0-asar-findings.md` 已核实，
 * 会话若加入一个**没有工具行**的 preset，它的工具目录就只剩**全局层**（部署/仓库插件
 * 注册的那些 MCP 类工具），DSH 原生的 `read` / `write` / `edit` / `glob` / `grep` /
 * `pwsh` / `skill` / `web_search` / `todo_write` **一个都不在**。
 *
 * 实测证据（会话 `session-144c11b2`，preset=`acp-commandcode`）：
 *   模型驱动列表里只有 164 个工具，全是部署层插件工具；
 *   模型自己探到 `unknown tool "write"` / `unknown tool "read"` / `unknown tool "bash"`。
 *
 * 后果：只要这次会话**没有真的落到外部引擎**（引擎未安装、握手失败、或 resume 时
 * preset 无法解析而回落到原生 agent-loop），用户得到的就是一个**没有任何 shell /
 * 文件系统能力**的会话 —— 用户看到的 `write → FS_SANDBOX_DENIED` / `pwsh → error`
 * 就是这条链上的表象（工具不在 → 模型乱试；或落回原生后撞上宿主 sandbox 策略）。
 *
 * ── 组合内容对照 ──────────────────────────────────────────────────────────
 * 行名与 `@deepseek-ai/dsh/config/agent-presets/standard/agent.cordis.yml` 一致，
 * 但**刻意只取"模型面向的工具行"**，不复制 `standard` 的 persona / plan-mode /
 * compaction / delegation 组合：
 *   - persona：留空 → 用部署默认人设（引擎会话里人设本来由引擎自己决定）
 *   - plan-mode / compaction / delegation：它们各自带 realm 与跨 preset 语义，
 *     复制过来只会增加挂载失败面（本插件的 preset 是"引擎入口"，不是第二套
 *     standard）
 *
 * 保留的行（全部是平铺行，不发布服务 → 无需 isolate realm，见 marker 注释）：
 *   skill-filesystem + tool-skill  工具与技能目录（ACP 会话的技能发现，见 ACP-INTEGRATION §5）
 *   tool-pwsh / tool-bash          宿主 shell 工具（按平台二选一）
 *   tool-fs + tool-fs-search       read / write / edit / glob / grep
 *   tool-jobs                      后台任务的控制面
 *   tool-todo / tool-ask-user / tool-web
 *
 * ⚠️ 关于 `fs`：默认**沿用宿主 plane 的 sandboxed fs**（与 standard 一致）——
 * 也就是说写工作区之外的路径仍会被拒（`FS_SANDBOX_DENIED`），这是 DSH 的**策略**
 * 而不是缺陷。想把 ACP 会话变成"不受沙箱约束"的（引擎侧本来自己管权限），
 * 打开 `unsandboxedFs` 即可：那会按 `minimal` preset 的写法在 entry-local realm 里
 * 用 `@deepseek-ai/dsh-fs-local` 遮蔽宿主的 sandboxed provider。
 *
 * @module dsh-multi-acp/preset-native
 */

/** 全部可选的原生工具分组 id。 */
export const NATIVE_TOOL_GROUPS = ['skills', 'shell', 'fs', 'jobs', 'todo', 'ask-user', 'web']

/**
 * `unsandboxedFs` 打开时的文件系统组（照 `minimal` preset 的写法）。
 *
 * ⚠️ 关键细节（2026-10-09 核对 minimal preset 源码后修正）：**消费 fs 的行必须和
 * `fs-local` 待在同一个 `isolate: {fs:true}` 组里**。minimal 的注释写得很直白：
 * "The bare local filesystem shadows the host's sandboxed provider only for this
 *  preset. The editor shares that realm and requires absolute paths."
 *
 * 第一版只把 `fs-local` 放进组里、把 `tool-fs` 平铺在外面 —— 那样 `tool-fs` 仍然注入
 * 宿主的 sandboxed fs，遮蔽等于没做。现在把 `tool-fs` / `tool-fs-search` 一起放进去。
 */
function fsLocalGroup(cwd) {
  return {
    id: 'filesystem-local',
    name: 'cordis:group',
    group: true,
    isolate: { fs: true },
    config: [
      { id: 'fs-local', name: '@deepseek-ai/dsh-fs-local', config: { cwd } },
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
      {
        id: 'tool-fs-search',
        name: '@deepseek-ai/dsh-tool-fs-search',
        config: { sampleOverCapGlobResults: false },
      },
    ],
  }
}

/**
 * 构造一个 ACP preset 的原生工具行。
 *
 * @param {object} [options]
 * @param {string} [options.platform]      `process.platform`，便于测试注入
 * @param {boolean} [options.unsandboxedFs] 用 entry-local 的 `dsh-fs-local` 遮蔽宿主 sandboxed fs
 * @param {string}  [options.cwd]          遮蔽组里 `fs-local` 的 cwd（默认 `process.cwd()`）
 * @param {string[]} [options.groups]      只挂这些分组（默认 `NATIVE_TOOL_GROUPS`）
 * @returns {object[]} preset 组合行（可直接放进 `agentPresets.register({ plugins })`）
 */
export function nativeToolRows(options = {}) {
  const platform = options.platform ?? process.platform
  const isWin = platform === 'win32'
  const groups = new Set(options.groups ?? NATIVE_TOOL_GROUPS)
  const rows = []

  if (groups.has('skills')) {
    rows.push({ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' })
    rows.push({ id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' })
  }

  if (groups.has('shell')) {
    // 与 standard 一致：POSIX 挂 bash，win32 挂 pwsh。这里直接按平台二选一
    // （而不是像 YAML 那样写 `disabled`），少一个语义依赖。
    rows.push(
      isWin
        ? { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' }
        : { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' },
    )
  }

  if (groups.has('fs')) {
    if (options.unsandboxedFs) {
      rows.push(fsLocalGroup(options.cwd ?? process.cwd()))
    } else {
      rows.push({ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' })
      rows.push({
        id: 'tool-fs-search',
        name: '@deepseek-ai/dsh-tool-fs-search',
        config: { sampleOverCapGlobResults: false },
      })
    }
  }

  if (groups.has('jobs')) rows.push({ id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' })
  if (groups.has('todo')) {
    rows.push({ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } })
  }
  if (groups.has('ask-user')) rows.push({ id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' })
  if (groups.has('web')) {
    rows.push({ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: false, searchTimeoutMs: 60000 } })
  }

  return rows
}

/**
 * 把（可能来自用户配置的）分组选择归一化成 `string[]`。
 *
 * 接受：`undefined`（=全部）/ `true` / `false` / 字符串数组 / 逗号分隔字符串。
 * 只认识 `NATIVE_TOOL_GROUPS` 里的名字，其余忽略（保守，避免把拼错的字段塞进组合）。
 */
export function normalizeGroups(value) {
  if (value === undefined || value === null || value === true) return [...NATIVE_TOOL_GROUPS]
  if (value === false) return []
  const list = Array.isArray(value) ? value : String(value).split(',')
  const wanted = list.map((v) => String(v).trim()).filter(Boolean)
  return NATIVE_TOOL_GROUPS.filter((g) => wanted.includes(g))
}
