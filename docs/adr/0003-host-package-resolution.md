# ADR-0003 · 宿主包解析：锚定 profile 目录，且结论必须带解析上下文

- **状态**：已接受（2026-10-10）
- **证据等级**：实测
- **相关**：`lib/dsh-imports.js`、`scripts/diagnose-host-resolution.mjs`、`test/plugin-smoke.test.mjs`

## 背景

插件要 import 宿主的包（`@deepseek-ai/dsh-agent` / `dsh-session` / `dsh-scope` / `dsh-llm`），
而**解析到哪一份取决于"谁在跑"**。三条路，只有一条是真的：

| 上下文 | 实测命中 | 结论 |
| --- | --- | --- |
| **宿主进程内**（真实运行） | 宿主自带运行时 **0.2.0-rc.2** | ✅ |
| **宿主外裸 node**（验证脚本 / 我的诊断） | `profiles/node_modules` 的 junction → 全局 `@deepseek-ai/dsh@0.1.1-rc.2` | ❌ |

实测证据（2026-10-10）：

1. 宿主的 `app.asar` 内自带 `@deepseek-ai/dsh-session|dsh-agent|dsh-tools|dsh-agent-preset-registry`
   全部 = `0.2.0-rc.2`；`resources/runtime/runtime.json` 的 `desktopVersion` = `0.2.0-rc.2`。
2. `profiles/node_modules/@deepseek-ai/*`（244 条）是**指向全局 npm 安装的绝对路径链接**，
   指向 `...\nvm\v22.20.0\node_modules\@deepseek-ai\dsh\node_modules\...`，
   内容 = `dsh-agent/dsh-session/dsh-tools = 0.1.1-rc.2`、`cordis = 4.0.1`。
   从 profile 锚点 `require.resolve('@deepseek-ai/dsh-session')` → **0.1.1-rc.2**（已实测）。
3. **假阴性实例**：同一个 `probeHostSymbols()` 在裸 node 下报
   `@deepseek-ai/dsh-llm 缺 AssistantStreamAccumulator`；而该符号在 0.2.0-rc.2 里由
   `index.d.ts` 的 `export * from './assistant-stream.ts'` 提供
   （`npm pack @deepseek-ai/dsh-llm@0.2.0-rc.2` 核实）。
4. **宿主内是好的**：`trace.log` 里 `factory.createAgent.contract` = `ok:true` **×12/12，零失败**。

另一个偶发形态：那棵树的链接**硬绑定到某个具体 nvm 版本**（`v22.20.0`），
而 active 是 `v24.21.0`。`nvm use` 换版本会让整棵树**悬空** —— 这正是
`docs/evidence/B0-ui-contract-findings.md` §5 曾记录的状态（该结论当时为真，现已变化）。

## 决定

1. **解析锚点保持为 profile 目录**（官方宿主共享语义建立在此之上），
   **但**修掉两个实现缺陷：
   - 报错信息不再用 `req.resolve('./noop.js')` 反推锚点 —— 那个文件不存在，
     `require.resolve` 自己会抛 `MODULE_NOT_FOUND`，把真正的失败原因盖掉。
     改为暴露 `hostResolveAnchor()`。
   - `importFromDsh` 的每条缓存项记录**解析路径与版本**。
2. **任何宿主契约结论必须带解析上下文**。`probeHostSymbols()` / `assertAgentContract()`
   的每条报告都带 `resolved` / `version` / `expected` / `trustHost`；版本不匹配时，
   结论文本**明确写"本次结论不代表宿主"**。
3. **`expected` 只接受"具体版本"**。早期实现把 `engines.dsh` 的**范围**
   （`>=0.2.0-rc.2 <0.3.0`）当基准去 `===` 比较，产出
   「cordis 4.0.1 ≠ 宿主 >=0.2.0-rc.2 <0.3.0」这种毫无意义的结论。
   拿不到具体版本时正确行为是**说"无法判定"**。
4. **新增 `scripts/diagnose-host-resolution.mjs`**，并定下退出码语义：
   `0` = 解析到的 == 宿主（结论可用）；`1` = 不一致；`2` = 无法判定。
5. **不手工改那棵树**：它由 DSH 维护（官方原文：不要手工复制），
   且 profile 里 40+ 已装插件都靠它解析宿主包。

## 后果

**正面**

- 「假阴性」这一类坑被永久关闭：以后任何宿主外的宿主契约结论都会先自曝其短。
- 宿主外与宿主内的差异**可被一键测量**，而不是靠记忆。

**负面 / 已知代价**

- 宿主外的验证脚本仍会解析到旧版本 —— 我们**不修**那棵树，只是让事实可见。
  这意味着 `tmp/verify-*.mjs` 里依赖宿主符号的历史结论**需要在正确解析下复跑**才能确认。
- `expected` 在宿主外通常未知（裸 node 没 `runtime.json`），此时诊断只能给"无法判定"。
  **缓解**：支持 `--expect <version>` / `DSH_HOST_VERSION`，CI 里显式给基准。

## 替代方案与为何不选

| 方案 | 为何不选 |
| --- | --- |
| 把解析锚点改成宿主 `app.asar` 路径 | 只对"跑在 Desktop 里"成立；web/headless 部署与 CI 都不成立，等于把一种环境写死。 |
| 删掉 / 重建那棵 junction 树 | DSH 的地盘；40+ 插件共享；手工改会被下次 DSH 操作覆盖或造成不一致。**先测量，再决定**。 |
| 让插件自带宿主包副本（打进 `dependencies`） | 直接违反「宿主接口包必须 peer」的硬规则：旧版副本会遮蔽宿主，工具调用全挂（市场规范 §6.6 的真实案例）。 |
| 什么都不做（只留文档） | 已经因此产出过一次假阴性，且未来会以「全 pass」这种更难发现的形式复发。 |
