# ADR-0004 · 配置面采纳 Schemastery `Config`，并允许求值失败时降级

- **状态**：已接受（2026-10-10）
- **证据等级**：实测
- **相关**：`lib/config.js`、`lib/index.js`、`lib/index.impl.js`、`test/config.test.mjs`

## 背景

插件早期**刻意回避** Schemastery，理由留在旧注释里：

> 宿主用的是 `@deepseek-ai/schemastery`，与公开的 `schemastery` 未必同源 ——
> 一旦构造期抛错，整个插件就是「启动失败」。

担心成立，但结论错了：正确的解法不是放弃 schema，而是去掉让 schema 危险的两个前提。

同时官方与社区规范都把 `Config` 列为硬要求（moneka `AGENTS.md`：「所有部署可调值使用
Schemastery `Config`」「默认值放在 Schema，不藏在执行逻辑的 `?? default` 里」）。

实测（2026-10-10）：

- `@deepseek-ai/schemastery@3.18.4` 可从 profile 解析，是 **dual 包**
  （`lib/index.cjs` + `lib/index.mjs`），**同步 `require` 可用** → 不需要顶层 await。
- **Schemastery 不做类型强转**：`promptTimeoutMs: "0"` 抛
  `ValidationError: $.promptTimeoutMs expected number but got 0`。
- **Schemastery 不拒绝未知键**：自带 patch 里的 `idleDisposeMs` / `disposeGraceMs` 会被保留。
- 原来的 `dependencies` 里放的是**公共** `schemastery@^3.17.0` —— 正是当年担心的同源问题。

## 决定

1. **新建 `lib/config.js`** 拥有整个配置面：`DEFAULT_CONFIG`、`Config` schema、
   `normalizeConfig()`（边界/跨字段校验）、`schemaDiagnostics`。
   `index.impl.js` 不再自己持有默认值与归一化。
2. **解析宿主那一份** `@deepseek-ai/schemastery`（`hostRequire()` 优先，插件自身依赖兜底），
   从 `dependencies` 移除公共 `schemastery`。
3. **求值期绝不抛**：`resolveSchema()` 与 `buildSchema()` 都在 `try` 里；
   失败 → `Config === undefined`（Cordis 允许插件无 Config）+ 一条 `schemaDiagnostics`，
   由 `apply()` 记日志。这是**响亮降级**，不是静默降级。
4. **每字段都有 default，没有 `required()`。** schema 只在"类型确实写错"时失败。
5. **对历史上宽松接受的形式用 `union`**：数字或数字字符串、布尔或 `'true'/'false'` 字符串、
   `presetTools` 的 bool/数组/逗号串。schema 管形状，`normalizeConfig` 管语义。
6. **`Config` 必须从入口模块 `lib/index.js` 静态 re-export** —— Cordis 从入口读取它，
   而 `index.impl.js` 是动态 import 的。
7. **`normalizeConfig()` 在 schema 生效时仍然执行** —— 它负责跨字段关系
   （这是 schema 表达不了的）与未知输入兜底。两条路径收敛到同一结果。
8. **把"过去静默丢掉的输入"变成诊断**：`presetTools` 里的未知分组以前被无声过滤；
   现在会报出未知组名**并列出可用分组**（用户否则无法自救）。

## 后果

**正面**

- 配置面有了唯一来源与唯一文档；`DEFAULT_CONFIG` 的每个值都在测试里被钉住。
- 新增三类跨字段告警，每一条都对应一次真实事故：
  - `promptTimeoutMs < idleTimeoutMs` → 总时长闸会先触发，空闲闸形同虚设（会把长任务误杀）；
  - `idleTimeoutMs = 0` → 只剩墙钟闸，卡死的引擎会一直占着会话；
  - `mcp.include` 与 `mcp.exclude` 同名 → 说明 exclude 优先。
- 未声明 `Config` 也不影响加载（降级路径已测）。

**负面 / 已知代价**

- **`normalizeConfig` 与 schema 并存**＝两处要维护。**缓解**：职责切得干净
  （schema＝形状/默认值，normalize＝语义/跨字段），且测试同时覆盖两条路径。
- 配置里的**类型错误现在会硬失败**（例如 `defaultEngine: 123`），而旧实现对任何非法值都
  静默回落默认值。这是**有意的行为变更**（规范要求"配置错误在最早可判定点明确失败"），
  已记录在 CHANGELOG。
- 宿主 schemastery 缺失时**没有 schema**（只有 JS 归一化）。此时配置仍然被校验，
  只是错误发现得晚一些 —— 并且会有一条 warn 说明这件事。

## 替代方案与为何不选

| 方案 | 为何不选 |
| --- | --- |
| 继续用公共 `schemastery` 包 | 与宿主不同源，正是当年拒绝 schema 的原因。 |
| 顶层 `await import()` 取 schemastery | 给模块求值引入异步与新的失败面，而同步 `require` 实测可用。 |
| 全宽松（`S.any()`）包一层 | 那样 schema 只剩"文档"作用，拿不到任何检查力。 |
| 严格 `S.number()` | 会让用户 YAML 里带引号的数字（常见写法）**硬失败** —— 是行为回归。 |
