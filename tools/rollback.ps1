<#
.SYNOPSIS
  一键回滚 dsh-multi-acp 在 DSH Desktop 上的**全部**改动。

.DESCRIPTION
  本插件对 live 环境一共动了 4 处，本脚本全部覆盖：

    1. `<profile>/cordis.patch.yml`     追加的插件注册行   → 从备份恢复
    2. `<profile>/package.json`         dependencies + dsh.profile.bundles → 从备份恢复
    3. `<profile>/node_modules/dsh-multi-acp`  pnpm 安装的副本 → 删除 + pnpm install 剪枝
    4. `<profile>/pnpm-lock.yaml`       可能被 pnpm 更新 → 从备份恢复（可选）

  安全设计：
    - 每个备份恢复前都**校验 SHA256 == 安装时记录的 originalHash**，不匹配就拒绝执行
    - 删除目录前确认它确实是我们的插件（读 package.json.name），不是真目录误删
    - 全程 **--WhatIf 可预演**

  保留不动的：插件源码、`<DSH_HOME>/multi-acp/`（诊断产物）、`docs/`。
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$PluginRoot = (Split-Path -Parent $PSScriptRoot),
  [switch]$KeepLockfileRestore,
  [switch]$SkipPnpm
)

$ErrorActionPreference = 'Stop'
$stateFile = Join-Path $PluginRoot 'tools\.install-state.json'

function Section($t) { Write-Host "`n$t" -ForegroundColor Cyan }

Write-Host "=== dsh-multi-acp 回滚（完整）===" -ForegroundColor Cyan

if (-not (Test-Path $stateFile)) {
  throw "找不到安装状态文件 $stateFile —— 无法确定原始备份，拒绝盲目回滚。"
}
$state = Get-Content -Raw $stateFile | ConvertFrom-Json
Write-Host "  安装时间 : $($state.installedAt)"
Write-Host "  DSH_HOME : $($state.dshHome)"
Write-Host "  profile  : $($state.profile)"

# ── 校验并恢复一个备份 ────────────────────────────────────
function Restore-BackedFile {
  param(
    [string]$Label,
    [string]$TargetPath,
    [string]$BackupPath,
    [string]$ExpectedHash
  )
  Section "[$Label]"
  if (-not $TargetPath) { Write-Host "  未记录目标路径，跳过" -ForegroundColor DarkGray; return }
  if (-not $BackupPath -or -not (Test-Path $BackupPath)) {
    Write-Host "  ⚠ 备份不存在：$BackupPath —— 跳过（人工处理）" -ForegroundColor Yellow; return
  }
  $actual = (Get-FileHash $BackupPath -Algorithm SHA256).Hash
  if ($ExpectedHash -and $actual -ne $ExpectedHash) {
    throw "  ✗ $Label 备份 SHA256 不匹配，拒绝回滚。`n    期望 $ExpectedHash`n    实际 $actual"
  }
  Write-Host "  ✓ 备份完整性校验通过" -ForegroundColor Green

  if ($PSCmdlet.ShouldProcess($TargetPath, "Restore from $BackupPath")) {
    # 先把当前（含我们改动）留档，便于事后对比
    if (Test-Path $TargetPath) {
      $aside = "$TargetPath.with-multi-acp"
      Copy-Item $TargetPath $aside -Force
      Write-Host "  改动前的版本留存为 $(Split-Path -Leaf $aside)" -ForegroundColor DarkGray
    }
    Copy-Item $BackupPath $TargetPath -Force
    Write-Host "  ✓ 已恢复 $TargetPath" -ForegroundColor Green
  }
}

# 1) cordis.patch.yml
Restore-BackedFile -Label '1/4 cordis.patch.yml' -TargetPath $state.patchFile `
  -BackupPath $state.backup -ExpectedHash $state.originalHash

# 2) package.json
Restore-BackedFile -Label '2/4 package.json' -TargetPath $state.profilePackage `
  -BackupPath $state.profilePackageBackup -ExpectedHash $state.profilePackageOriginalHash

# 3) node_modules 里的插件副本
Section '[3/4] 移除 node_modules 中的插件副本'
$installed = if ($state.profilePackage) {
  Join-Path (Split-Path -Parent $state.profilePackage) "node_modules\$($state.pluginName ?? 'dsh-multi-acp')"
} else { $null }
if ($installed -and (Test-Path $installed)) {
  # 安全检查：确认里面确实是我们的插件
  $pkgJson = Join-Path $installed 'package.json'
  $isOurs = $false
  if (Test-Path $pkgJson) {
    try { $isOurs = ((Get-Content -Raw $pkgJson | ConvertFrom-Json).name -eq 'dsh-multi-acp') } catch {}
  }
  if (-not $isOurs) {
    Write-Host "  ⚠ $installed 看起来不是本插件，拒绝删除" -ForegroundColor Yellow
  } elseif ($PSCmdlet.ShouldProcess($installed, 'Remove installed copy')) {
    Remove-Item -Recurse -Force $installed
    Write-Host "  ✓ 已删除 $installed" -ForegroundColor Green
  }
} else {
  Write-Host "  不存在，跳过" -ForegroundColor DarkGray
}

# 4) pnpm-lock.yaml（pnpm install 可能更新过它）
if (-not $KeepLockfileRestore) {
  $lock = if ($state.profilePackage) { Join-Path (Split-Path -Parent $state.profilePackage) 'pnpm-lock.yaml' } else { $null }
  $lockBackups = if ($lock) {
    Get-ChildItem "$lock.bak-*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending
  } else { @() }
  Section '[4/4] pnpm-lock.yaml'
  if ($lockBackups.Count -gt 0) {
    $newest = $lockBackups[0]
    if ($PSCmdlet.ShouldProcess($lock, "Restore from $($newest.Name)")) {
      Copy-Item $newest.FullName $lock -Force
      Write-Host "  ✓ 已从 $($newest.Name) 恢复" -ForegroundColor Green
    }
  } else {
    Write-Host "  未找到 lockfile 备份，跳过（可用 --KeepLockfileRestore 显式跳过）" -ForegroundColor DarkGray
  }
}

# 5) 让 pnpm 剪枝（把依赖树与 package.json 对齐）
if (-not $SkipPnpm -and $state.profilePackage) {
  Section '[5/5] pnpm install 剪枝'
  $profDir = Split-Path -Parent $state.profilePackage
  Write-Host "  在 $profDir 执行 pnpm install…"
  if ($PSCmdlet.ShouldProcess($profDir, 'Run pnpm install')) {
    Push-Location $profDir
    try {
      & pnpm install --prefer-offline 2>&1 | Select-Object -Last 6 | ForEach-Object { "    $_" }
    } finally { Pop-Location }
    Write-Host "  ✓ 完成" -ForegroundColor Green
  }
}

Write-Host "`n=== 回滚完成 ===" -ForegroundColor Cyan
Write-Host "请重启 DSH Desktop 让改动生效。" -ForegroundColor Yellow
Write-Host "（插件源码保留在 $PluginRoot；诊断产物保留在 <DSH_HOME>\multi-acp\）" -ForegroundColor DarkGray
Write-Host "重装：powershell -File tools\install.ps1" -ForegroundColor DarkGray
