# ADR-0001 · 安装路径：Desktop profile 走手工脚本，不走官方 `dsh plugin`

- **状态**：已接受（2026-10-10）
- **证据等级**：实测
- **相关**：`tools/install.ps1`、`tools/rollback.ps1`、CI 的 `official-install` job

## 背景

官方 `docs/user/develop/basic/publish.zh.md` 给出的安装路径是
`dsh plugin --profile <name> add <spec>`。但本插件的目标宿主是 **DSH Desktop**，
其 profile 名为 `desktop`。

官方 `reference/index` 明确写着：

> Electron 桌面应用…拥有保留的 `$DSH_HOME/profiles/desktop`。**公开 CLI 不能管理 Desktop profile。**

实测补充（本机）：

- `dsh` **不在 PATH**（唯一可用的 npm 全局 `@deepseek-ai/dsh` 是 `0.1.1-rc.2`，
  比宿主 `0.2.0-rc.2` 老一个版本线，且装在另一个 nvm 版本下）；
- Desktop **自带**与宿主精确同版本的官方 CLI：`resources/runtime/cli/bin/dsh.cmd`
  （实测 `--version` = `0.2.0-rc.2`），但它同样是「公开 CLI」，同样受上文限制。

## 决定

**保留 `tools/install.ps1` 作为 Desktop profile 的唯一安装路径**，其行为等价于
「手工做 `dsh plugin add` 会做的事」：

1. 在 profile 的 `package.json` 里加 `dependencies["dsh-multi-acp"] = "file:<本仓库>"`；
2. 把 `dsh-multi-acp` 追加进 `dsh.profile.bundles`（**这才是插件树的真正来源**）；
3. 在 profile 目录跑 `pnpm install`（唯一正确的安装方式 —— 手工建 junction 会绕过
   pnpm 簿记，loader 看不见）；
4. 可选地在 profile 的 `cordis.patch.yml` 末尾外科式追加配置覆盖行。

同时：**官方安装路径的验证放到 CI**（ubuntu runner、`web` profile、pin `0.2.0-rc.2`），
本机不建 web profile。

## 后果

**正面**

- Desktop 用户有可回滚（`tools/rollback.ps1`）、可校验（`tmp/verify-install.ps1` 逐文件 SHA256）的安装路径。
- 官方管线的兼容性由 CI 持续证明，不依赖本机环境。
- CI 里可以裸装 `@deepseek-ai/dsh@0.2.0-rc.2` —— 干净、可复现、不占开发机。

**负面 / 已知代价**

- 脚本与官方 CLI 的行为可能漂移。**缓解**：脚本的每一步都对应官方文档里的一个动作，
  并在 CI 里用官方 CLI 做等价验证。
- 硬链接树带来的陷阱（`Write` 重写文件会断链）必须写进文档并周期性提醒。已写入 `AGENTS.md` §2。

## 替代方案与为何不选

| 方案 | 为何不选 |
| --- | --- |
| 用 Desktop 自带 CLI 管理 desktop profile | 未实测成功；且在 40+ 已装插件共享 profile 上盲动风险高。若要试，先备份再验证。 |
| 安装一个匹配版本的全局 `dsh` 来管 desktop | 同样受「公开 CLI 不能管理 Desktop profile」限制，装完也管不了。 |
| 本机建 `web` profile 做验证 | 要 pnpm 拉 dsh-base + dsh-web-app（数百 MB），且**验证的仍不是目标宿主**。放 CI 更划算。 |
| 什么都不做，只让人手工改 | 不可回滚、无校验。 |
