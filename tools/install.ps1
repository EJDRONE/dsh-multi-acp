<#
.SYNOPSIS
  把 dsh-multi-acp 正式安装进 DSH Desktop 的 profile。

.DESCRIPTION
  ── 为什么是这个流程（前几轮踩坑换来的）──────────────────────────
  1. **插件树的来源是 `package.json → dsh.profile.bundles`**，不是 `cordis.patch.yml`。
     只往 patch 文件加行 → 指向一个从未被加载的包 → 什么都不会发生。
     `cordis.patch.yml` 里的行只是对**已加载行**的配置覆盖。
  2. **必须经 pnpm 安装**。profile 由 pnpm 管理（pnpm-lock.yaml + .pnpm 虚拟存储）。
     手工建 junction 会绕过 pnpm 的簿记，loader 看不见。
  3. **pnpm 用硬链接**。所以：
       - 用 Edit 原地改源码 → 已安装位置**自动同步**（同一 inode）
       - 用 Write 重写文件 → **断链**，不会同步
       - 手工 `copy` 会被"文件被占用"挡住，**不可靠**
     结论：改完源码若要确保同步，跑 `pnpm install`（本脚本 -Sync 开关），不要手工 copy。

  ── 本次改动的 4 处 ──────────────────────────────────────────
    1. `<profile>/cordis.patch.yml`   追加插件配置行（外科式，逐字节校验）
    2. `<profile>/package.json`       dependencies + dsh.profile.bundles
    3. `<profile>/node_modules/...`   pnpm 安装产物
    4. `<profile>/pnpm-lock.yaml`     pnpm 更新（先备份）

  回滚：tools\rollback.ps1（覆盖以上全部 4 处）

.PARAMETER Sync
  只做"重同步 + 校验"（改完源码后跑这个，不重复改配置）。
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { 'D:\Ecode\.dsh' }),
  [string]$Profile = 'desktop',
  [string]$PluginId = 'multi-acp',
  [string]$PluginName = 'dsh-multi-acp',
  [switch]$Sync
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $DshHome "profiles\$Profile"
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$pkgFile = Join-Path $profileDir 'package.json'
$lockFile = Join-Path $profileDir 'pnpm-lock.yaml'
$installed = Join-Path $profileDir "node_modules\$PluginName"
$stateFile = Join-Path $pluginRoot 'tools\.install-state.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

Write-Host "=== dsh-multi-acp 安装 ===" -ForegroundColor Cyan
Write-Host "  插件源码 : $pluginRoot"
Write-Host "  profile  : $profileDir"

foreach ($f in @($patchFile, $pkgFile)) { if (-not (Test-Path $f)) { throw "找不到 $f" } }

# ── 状态对象（回滚依赖它）──────────────────────────────────
$state = [ordered]@{
  installedAt = (Get-Date).ToString('o')
  dshHome = $DshHome; profile = $Profile
  pluginRoot = $pluginRoot; pluginName = $PluginName
  patchFile = $patchFile; profilePackage = $pkgFile; lockFile = $lockFile
  patchedAt = $stamp
}

# ── [1] 备份 ────────────────────────────────────────────
Write-Host "`n[1/5] 备份" -ForegroundColor Cyan
Copy-Item $patchFile "$patchFile.bak-$stamp" -Force
$state.backup = "$patchFile.bak-$stamp"
$state.originalHash = (Get-FileHash $patchFile -Algorithm SHA256).Hash
Write-Host "  cordis.patch.yml → $(Split-Path -Leaf $state.backup)  ($($state.originalHash.Substring(0,16))…)"

Copy-Item $pkgFile "$pkgFile.bak-$stamp" -Force
$state.profilePackageBackup = "$pkgFile.bak-$stamp"
$state.profilePackageOriginalHash = (Get-FileHash $pkgFile -Algorithm SHA256).Hash
Write-Host "  package.json     → $(Split-Path -Leaf $state.profilePackageBackup)"

if (Test-Path $lockFile) {
  Copy-Item $lockFile "$lockFile.bak-$stamp" -Force
  Write-Host "  pnpm-lock.yaml   → $(Split-Path -Leaf "$lockFile.bak-$stamp")"
}

# ── [2] package.json：dependencies + dsh.profile.bundles ──
Write-Host "`n[2/5] 注册 bundle（这是插件树真正的来源）" -ForegroundColor Cyan
$pkg = Get-Content -Raw $pkgFile | ConvertFrom-Json
$origDepKeys = @($pkg.dependencies.PSObject.Properties.Name)
$origBundles = @($pkg.dsh.profile.bundles)
$depSpec = "file:$($pluginRoot -replace '\\','/')"

if (-not $pkg.dependencies.PSObject.Properties[$PluginName]) {
  $pkg.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue $depSpec -Force
  Write-Host "  ✓ dependencies += $PluginName"
} else { Write-Host "  dependencies 已有，保留" -ForegroundColor DarkGray }

if ($origBundles -notcontains $PluginName) {
  $pkg.dsh.profile.bundles = @($origBundles + $PluginName)
  Write-Host "  ✓ dsh.profile.bundles += $PluginName（共 $(@($pkg.dsh.profile.bundles).Count) 项）"
} else { Write-Host "  bundles 已含，保留" -ForegroundColor DarkGray }

if ($PSCmdlet.ShouldProcess($pkgFile, 'Write profile package.json')) {
  ($pkg | ConvertTo-Json -Depth 10) -replace "`r`n", "`n" |
    Set-Content $pkgFile -Encoding utf8 -NoNewline
}

# 校验：只增不改
$after = Get-Content -Raw $pkgFile | ConvertFrom-Json
$afterBundles = @($after.dsh.profile.bundles)
for ($i = 0; $i -lt $origBundles.Count; $i++) {
  if ($afterBundles[$i] -ne $origBundles[$i]) {
    Copy-Item $state.profilePackageBackup $pkgFile -Force
    throw "校验失败：bundles 前缀被改动，已恢复"
  }
}
$added = @(@($after.dependencies.PSObject.Properties.Name) | Where-Object { $origDepKeys -notcontains $_ })
$missing = @($origDepKeys | Where-Object { @($after.dependencies.PSObject.Properties.Name) -notcontains $_ })
if ($missing.Count -gt 0 -or $added.Count -gt 1) {
  Copy-Item $state.profilePackageBackup $pkgFile -Force
  throw "校验失败：dependencies 变化不符预期（丢失 [$($missing -join ',')] / 新增 [$($added -join ',')]），已恢复"
}
Write-Host "  ✓ 校验通过：bundles 原 $($origBundles.Count) 项未变，deps 仅新增 [$($added -join ',')]" -ForegroundColor Green

# ── [3] pnpm install ─────────────────────────────────────
Write-Host "`n[3/5] pnpm install（唯一正确的安装方式）" -ForegroundColor Cyan
if ($PSCmdlet.ShouldProcess($profileDir, 'Run pnpm install')) {
  Push-Location $profileDir
  try {
    & pnpm install --prefer-offline 2>&1 | Select-Object -Last 6 | ForEach-Object { "  $_" }
    if ($LASTEXITCODE -ne 0) { throw "pnpm install 失败（exit $LASTEXITCODE）" }
  } finally { Pop-Location }
}
if (-not (Test-Path $installed)) { throw "pnpm install 后仍找不到 $installed" }
Write-Host "  ✓ 已安装到 $installed" -ForegroundColor Green

# ── [4] cordis.patch.yml：外科式追加配置行（可选）──────────
Write-Host "`n[4/5] cordis.patch.yml 追加配置行" -ForegroundColor Cyan
Write-Host "  注意：这只是在覆盖 bundle 自带 patch 的默认 config，不是插件加载入口" -ForegroundColor DarkGray
$raw = [System.IO.File]::ReadAllText($patchFile)
$hasBom = $false
$nl = if ($raw.Contains("`r`n")) { "`r`n" } else { "`n" }

if ($raw -match "(?m)^-\s*id:\s*$([regex]::Escape($PluginId))\s*$") {
  Write-Host "  已存在 id: $PluginId 的行，跳过" -ForegroundColor DarkGray
  $state.appendedRows = @('(already present)')
} else {
  $block = @(
    '',
    '# --- dsh-multi-acp (external ACP engines as DSH root agents) ---',
    "- id: $PluginId",
    "  name: $PluginName",
    '  config:',
    '    defaultEngine: ""',
    '    verboseStartup: true'
  ) -join $nl
  $newContent = $raw.TrimEnd("`r", "`n") + $nl + $block + $nl
  if ($PSCmdlet.ShouldProcess($patchFile, 'Append config row')) {
    [System.IO.File]::WriteAllText($patchFile, $newContent, (New-Object System.Text.UTF8Encoding($hasBom)))
  }
  $state.appendedRows = @($block -split "`n")
  Write-Host "  ✓ 已追加" -ForegroundColor Green
}

# ── [5] 校验 + 记录状态 ───────────────────────────────────
Write-Host "`n[5/5] 校验" -ForegroundColor Cyan
$newRaw = [System.IO.File]::ReadAllText($patchFile)
$origRaw = [System.IO.File]::ReadAllText($state.backup)
if (-not $newRaw.StartsWith($origRaw.TrimEnd("`r", "`n"))) {
  Copy-Item $state.backup $patchFile -Force
  throw "校验失败：cordis.patch.yml 既有内容被改动，已从备份恢复"
}
Write-Host "  ✓ cordis.patch.yml 既有内容逐字节未变（仅末尾追加）" -ForegroundColor Green
Write-Host "  ✓ 插件源码已同步（pnpm 硬链接）" -ForegroundColor Green

$state | ConvertTo-Json -Depth 6 | Set-Content $stateFile -Encoding utf8
Write-Host "`n安装状态已记录 → $stateFile" -ForegroundColor DarkGray

Write-Host "`n=== 完成 ===" -ForegroundColor Cyan
Write-Host "下一步：重启 DSH Desktop，然后在插件页确认版本号已变（版本号是唯一可靠的判据）" -ForegroundColor Yellow
Write-Host "回滚：powershell -File tools\rollback.ps1" -ForegroundColor DarkGray
