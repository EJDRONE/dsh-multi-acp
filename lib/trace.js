/**
 * 诊断追踪（verification 用）。
 *
 * 把 ACP 路由的关键决策追加到 `<stateDir>/trace.log`，用于回答：
 *   - `ctx.agents.factory` 是否真的被本插件替换？
 *   - createAgent/resume 收到的 agentPreset 是什么？解析出哪个引擎？
 *   - 是否走了"降级回官方 factory"的分支，原因是什么？
 *
 * ⚠️ **本文件会写用户磁盘，因此有两条硬约束**（都来自真实事故）：
 *
 * 1. **中央脱敏**（ISSUE-13）。此前 `acp.tool-call` 记录引擎工具调用的**原标题**，
 *    实测含 `mcp_…` token、`sk-…` API key、账号邮箱与**明文密码** —— 而 trace.log
 *    是个容易被贴进 issue 的旁路文件。现在**所有** value 都过一遍 `redact()`：
 *    按**键名**（token/secret/password/…）与**值的形状**（sk-/mcp_/JWT/Bearer/邮箱/…）脱敏，
 *    并截断超长字符串。调用方仍然应当**不要**传敏感字段（纵深防御，不是唯一防线）。
 *
 * 2. **默认路径绝不能在被测试污染**（ISSUE-18）。本模块曾在**加载期**把路径定死成生产路径，
 *    于是 `npm test` 与任何用假 ctx 调 `apply()` 的脚本会把**假宿主事件写进用户的真 trace** ——
 *    最典型的是测试故意构造的 `{ target: 'not-a-factory' }`，在真机上读起来就是
 *    `install.factory-bad-shape`，让人误判"宿主返回了无法识别的形状"。
 *
 * 关闭 / 改道（优先级：`configureTrace` > 环境变量 > 默认）：
 *   · 插件配置 `trace: false`（关闭）或 `trace: '<path>'`（改道）—— **Desktop 用户的正确开关**
 *     （Desktop 从快捷方式启动，用户改不了它的环境变量）；
 *   · 环境变量 `DSH_MULTI_ACP_TRACE=''`/`'0'`/`'off'` = 关闭，其它值 = 改道；
 *   · `node:test` 下**绝不**写默认路径。
 *
 * @module dsh-multi-acp/trace
 */
import { appendFileSync } from 'node:fs'

const DEFAULT_FILE = 'D:\\Ecode\\.dsh\\multi-acp\\trace.log'

/** 键名命中即整值脱敏（不看值的形状）。**注意不要加 `sessionId`** —— 那是诊断的主键。 */
const SECRET_KEY_RE = /(token|secret|password|passwd|api[-_]?key|apikey|authorization|bearer|credential|cookie)/i

/**
 * 值的形状。覆盖实测泄漏过的那几类 + 常见凭据前缀 + 邮箱（PII）。
 * 这些正则同时作用于**任意字符串**，所以错误信息里内嵌的 URL/token 也会被盖住。
 *
 * 每项是 `[正则, 替换]`：带捕获组的那些**保留键名**（`password=<redacted>`），
 * 因为"是哪个字段泄漏的"对排查有价值；不带的整段替换。
 */
const SECRET_VALUE_RESETS = /** @type {[RegExp, string][]} */ ([
  [/\bsk-[A-Za-z0-9_-]{10,}/g, '<redacted>'],
  [/\bmcp_[A-Za-z0-9_-]{10,}/g, '<redacted>'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '<redacted>'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '<redacted>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<redacted>'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '<redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi, 'Bearer <redacted>'],
  // 自由文本里的 `key=value` / `key: value` / `--flag value` / `密码 xxx`
  // —— 覆盖 URL query（?token=…）、命令行参数（--password …）与中文标签。
  // 值必须 ≥6 个非空白字符，否则"the secret is not set"这类正常句子会被误伤。
  [
    /([\w.-]*(?:token|secret|password|passwd|api[-_]?key)[\w.-]*|密码|口令|密钥|令牌|凭据)\s*(?:[=:：]\s*|\s+)["']?[^\s&,;'")\]}，。；：、！？]{6,}/gi,
    '$1<redacted>',
  ],
  // 邮箱：不是凭据，但属 PII —— trace.log 常被贴进 issue
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
])

/** 单个字符串的上限：超出即截断（避免一整篇 prompt 落盘）。 */
const MAX_STRING = 300
/** 对象字段数上限 / 递归深度上限。 */
const MAX_FIELDS = 40
const MAX_DEPTH = 6

/**
 * 脱敏一个字符串（先按形状替换，再截断）。
 * @param {string} value
 * @returns {string}
 */
function redactString(value) {
  let out = value
  for (const [re, to] of SECRET_VALUE_RESETS) out = out.replace(re, to)
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}…(+${out.length - MAX_STRING} chars)`
  return out
}

/**
 * 递归脱敏任意 data。数组/对象/原始值都吃；不认识的类型转成 `<type>` 占位。
 * @param {unknown} value
 * @param {string} [key] 该值所在的字段名（命中 SECRET_KEY_RE 则整值脱敏）
 * @param {number} [depth]
 * @returns {unknown}
 */
function redact(value, key, depth = 0) {
  if (value === null || value === undefined) return value
  if (depth > MAX_DEPTH) return '<max-depth>'

  if (typeof value === 'string') {
    return key !== undefined && SECRET_KEY_RE.test(key) ? '<redacted>' : redactString(value)
  }
  const type = typeof value
  if (type === 'number' || type === 'boolean') return value
  if (type === 'bigint') return String(value)
  if (Array.isArray(value)) return value.map((v) => redact(v, undefined, depth + 1))
  if (type === 'object') {
    const out = {}
    let seen = 0
    for (const [k, v] of Object.entries(value)) {
      if (++seen > MAX_FIELDS) {
        out['…'] = `<+${Object.keys(value).length - MAX_FIELDS} more fields>`
        break
      }
      out[k] = redact(v, k, depth + 1)
    }
    return out
  }
  return `<${type}>`
}

/** 由插件 config 设置的覆盖（比环境变量更适合 Desktop 用户）。 */
let configured = null

/**
 * 由 `apply()` 按插件配置调用。
 *
 * @param {{ enabled?: boolean, file?: string | null } | null} next
 *   `enabled:false` = 关闭；`file` 非空 = 改道到该路径；传 `null` = 清除覆盖。
 */
export function configureTrace(next) {
  configured =
    next && typeof next === 'object'
      ? {
          enabled: next.enabled !== false,
          file: typeof next.file === 'string' && next.file.length > 0 ? next.file : null,
        }
      : null
}

/** 解析本次要写的文件。**每次调用都读**（不是在模块加载期读一次），以便随时开关/改道。 */
function resolveFile() {
  if (configured) {
    if (!configured.enabled) return null
    if (configured.file) return configured.file
  }
  const raw = process.env.DSH_MULTI_ACP_TRACE
  if (raw !== undefined) {
    const value = String(raw).trim()
    return value === '' || value === '0' || value.toLowerCase() === 'off' ? null : value
  }
  if (process.env.NODE_TEST_CONTEXT) return null
  return DEFAULT_FILE
}

/**
 * 追加一条事件。任何异常都被吞掉 —— 追踪绝不能影响主流程。
 *
 * @param {string} event
 * @param {object} [data] 会被 `redact()` 处理后再落盘
 */
export function trace(event, data = {}) {
  try {
    const file = resolveFile()
    if (!file) return
    appendFileSync(
      file,
      JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, data: redact(data) }) + '\n',
      'utf8',
    )
  } catch {
    /* never break the host */
  }
}
