# ADR-0002 · 语言与类型：纯 JS + JSDoc + `checkJs`，不迁 TypeScript

- **状态**：已接受（2026-10-10）
- **证据等级**：实测
- **相关**：`tsconfig.json`、`types/globals.d.ts`、`docs/adr/0006-route-b-replaces-private-factory.md`

## 背景

三条路：纯 JS（现状）、TS + tsdown、JS + JSDoc + `checkJs`。

关键的实测事实（2026-10-10）：

1. **宿主包带完整 `.d.ts`**，且 `0.2.0-rc.2` 与目标宿主精确同版本。例如
   `@deepseek-ai/dsh-session@0.2.0-rc.2` 的 `append` 签名是

   ```ts
   append<T extends SessionEventType>(type: T, data: SessionEventMap[T],
     ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []): SessionEvent<T>
   ```

   —— 条件可变参数，**精确编码**了我们踩过的 `surfaceOp` 漏传事故。

2. `npm latest` 标签**不可用**：`@deepseek-ai/dsh-tools@latest` = `0.0.1-rc.1`（损坏线），
   而可用线是 `0.2.0-rc.2`。必须精确 pin。

3. 用 `tsc --checkJs` 对**本仓库真实踩过的三个错误**做探测：

   | 探测 | 结果 |
   | --- | --- |
   | `append('user/message', data)` 漏第三参 | ✅ `TS2554: Expected 3 arguments, but got 2` |
   | `reason: 'end-turn'` | ✅ `TS2322: Type 'string' is not assignable to 'TurnEndReason'` |
   | `agents.factory = { target }` | ✅ `TS2341: Property 'factory' is private…` |

   同一组探测的**正向对照**（改成宿主要求的正确形态）→ **0 error**。所以这是精确信号。

4. 官方 `publish.zh.md` 自己的例子是**纯 JS**；社区成熟的零依赖插件
   `diceroyang/dsh-report-studio` 也是纯 JS + `node --test`。

## 决定

**保持 `.js` 作为唯一真源，加 `tsconfig.json`（`checkJs`，松模式）+ 宿主 devDependencies。**

- 松模式：`strict:false` / `noImplicitAny:false` —— 不需要为 6590 行补全 JSDoc 就能
  拿到「属性名 / 调用签名 / 枚举字面量」这三类致命错误的检查力。
- `lib/` **同时是源码与产物**，不做 `src/`↔`lib/` 双份。
- devDependencies **精确 pin `0.2.0-rc.2`**（不用 `^`，绝不裸装）。

## 后果

**正面**

- 类型检查的收益（宿主 `.d.ts`）**完整拿到**，与 TS 源码一致 —— 因为类型来自宿主，不来自我们的源码。
- **改码循环不变**：`lib/*.js` 原地编辑 → pnpm 硬链接自动同步。
  若插进构建步骤，构建器重写 `lib/*.js` 会换 inode，**复现安装脚本里记录的那类「断链」故障**。
- 迁移成本不对称：JS→TS 是机械的（`allowJs` 可逐文件），TS→JS 是重写。先 JS 保留回头路。

**负面 / 已知代价**

- **JSDoc 纪律会衰减**，而 TS 会强制。**缓解**：`checkJs` 进 CI（见下），衰减会被看见。
- **类型基线曾欠账，现已清零（2026-10-10）**：首次运行 `tsc` 有 **43 个错误**，
  绝大多数是既有 JSDoc 只写 `@param {object} opts` 而没写字段，导致 TS 推出 `{}`。
  那一轮逐模块补齐了 JSDoc 描述，并把**唯一一处真实的契约越界**保留为
  **带原因的显式抑制**而不是留红。CI 里 `typecheck` 现在**阻断**。

  清零过程中修掉的三类真问题（都不是"为了让检查通过"）：
  1. **`Agent` 的类型导错了路径。** 原 JSDoc 写
     `import('@deepseek-ai/dsh-agent/types').Agent`，而运行时 `Agent` 的成员
     （`session`/`status`/`inbox`/`options`/`ctx`/`cancel`/`whenIdle`）是通过
     `runtime-types.d.ts` 里 `declare module './types.ts'` 的**模块增强**加进去的，
     **只有从包根导入**（`index.d.ts` 有 `export * from './runtime-types.ts'`）才带上。
     引子路径 → `Agent` 退化成只剩 `{ id }` → 5 个"成员不存在"的错误，
     本质是**我们对 agent 装配的检查一直是空转的**。
  2. **函数签名说明不了选项对象。** `probeCandidate` / `createRoutesHandler` /
     `AcpClient#initialize|newSession|loadSession` 等处的选项参数此前没有 `@param`，
     TS 只能从默认值推出部分字段 → 调用方传 `command`/`logger`/`defaultEngine` 等
     会被判为"未知属性"。补齐后这些接缝才真正被检查。
  3. **`setStatus` 写的是宿主的 `readonly status`。** 宿主契约把
     `Agent.status` 声明为 `readonly`（"mirrored on every `agent/status` transition"），
     而这个 agent 的持有者就是我们自己 —— 没有别处维护这个镜像。
     与 ADR-0006 的 factory 越界同属"路线 B 的固有代价"。处理方式：**显式
     `@ts-expect-error` + 原因 + ADR 指针**。`tsc` 会校验该抑制是否仍然有效，
     所以 DSH 一旦把它改成可写，这里会**反向报错**，等于免费的升级探测器。
- 客户端半边（`lib/client.js`）需要手写全局声明（`types/globals.d.ts` 声明
  `window.__ModuleLoader__`），因为那是浏览器加载器契约、不在 DOM 类型里。

## 替代方案与为何不选

| 方案 | 为何不选 |
| --- | --- |
| TS + tsdown | 收益（检查力）与 JS+checkJs **完全相同**，但要多一份产物、多一个构建步骤，并把「原地编辑 → 硬链接同步」这个已经验证过的循环换成「构建 → 可能断链」。 |
| 不做任何类型检查 | 上面三张探测表就是它的代价：每一个都是**静默或灾难性**的（宿主崩溃 / 静默数据丢失）。 |
| 只在 tsconfig 里排除 `client.js` | 该类文件正是「加载器契约」最容易写错的地方（漏 `inject` 会让 web boot 中止）。用 `types/globals.d.ts` 声明契约比排除它更有价值。 |
