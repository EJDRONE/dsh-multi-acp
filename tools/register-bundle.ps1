<#
.SYNOPSIS
  把 dsh-multi-acp 注册进 profile 的 package.json（dependencies + dsh.profile.bundles）。

.DESCRIPTION
  ⚠️ 这是 install.ps1 漏掉的一步，也是插件不被加载的**根因**：

    DSH 的插件树由 profile 的 `package.json → dsh.profile.bundles` 组合而成，
    `cordis.patch.yml` 只是对**已加载行**的覆盖/配置。
    仅往 cordis.patch.yml 加行，指向一个从未被加载的包 → 什么都不会发生。

  本脚本：
    1. 备份 profile 的 package.json
    2. dependencies["dsh-multi-acp"] = "file:<插件绝对路径>"
    3. dsh.profile.bundles += "dsh-multi-acp"（幂等，已存在则跳过）
    4. 校验：既有键值逐项未变，只多出我们这两处

  package.json 不含凭据，但仍遵守"只增不改 + 备份 + 可回滚"。

  回滚：rollback.ps1（会一并恢复 package.json）
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { 'D:\Ecode\.dsh' }),
  [string]$Profile = 'desktop',
  [string]$PluginName = 'dsh-multi-acp'
)

$ErrorActionPreference = 'Stop'
$pluginRoot = Split-Path -Parent $PSScriptRoot
$profileDir = Join-Path $DshHome "profiles\$Profile"
$pkgFile = Join-Path $profileDir 'package.json'

Write-Host "=== 注册 bundle ===" -ForegroundColor Cyan
Write-Host "  package.json : $pkgFile"

if (-not (Test-Path $pkgFile)) { throw "找不到 $pkgFile" }

# ── 备份 ─────────────────────────────────────────────────
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$pkgFile.bak-$stamp"
$origHash = (Get-FileHash $pkgFile -Algorithm SHA256).Hash
Copy-Item $pkgFile $backup -Force
Write-Host "[1/4] 已备份 → $backup" -ForegroundColor Green
Write-Host "      SHA256 = $origHash"

# ── 解析并修改 ────────────────────────────────────────────
$raw = [System.IO.File]::ReadAllText($pkgFile)
$pkg = $raw | ConvertFrom-Json

Write-Host "`n[2/4] 修改 dependencies 与 dsh.profile.bundles" -ForegroundColor Cyan

$depSpec = "file:$($pluginRoot -replace '\\','/')"
$changed = @()

if (-not $pkg.dependencies) { throw "profile package.json 没有 dependencies，拒绝继续" }
if (-not $pkg.dsh -or -not $pkg.dsh.profile -or -not $pkg.dsh.profile.bundles) {
  throw "profile package.json 没有 dsh.profile.bundles，拒绝继续"
}

# ⚠️ 必须在任何修改之前采集原始快照，供后面校验
$origDepKeys = @($pkg.dependencies.PSObject.Properties.Name)
$origBundles = @($pkg.dsh.profile.bundles)

$existingDep = $pkg.dependencies.PSObject.Properties[$PluginName]
if ($existingDep) {
  Write-Host "      dependencies 已有 $PluginName = $($existingDep.Value)，保留不动" -ForegroundColor Yellow
} else {
  $pkg.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue $depSpec -Force
  $changed += "dependencies += $PluginName = $depSpec"
  Write-Host "      ✓ dependencies += $PluginName" -ForegroundColor Green
}

$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -contains $PluginName) {
  Write-Host "      bundles 已含 $PluginName，跳过" -ForegroundColor Yellow
} else {
  $newBundles = @($bundles + $PluginName)
  $pkg.dsh.profile.bundles = $newBundles
  $changed += "dsh.profile.bundles += $PluginName"
  Write-Host "      ✓ dsh.profile.bundles += $PluginName（共 $($newBundles.Count) 项）" -ForegroundColor Green
}

if ($changed.Count -eq 0) {
  Write-Host "`n无需修改，退出。" -ForegroundColor Yellow
  exit 0
}

# ── 写出（2 空格缩进，LF，保持无 BOM）────────────────────
Write-Host "`n[3/4] 写回 package.json" -ForegroundColor Cyan
$json = $pkg | ConvertTo-Json -Depth 10
# ConvertTo-Json 会把 depth 内的一切展开；用 LF 统一
$json = $json -replace "`r`n", "`n"
if ($PSCmdlet.ShouldProcess($pkgFile, 'Write profile package.json')) {
  [System.IO.File]::WriteAllText($pkgFile, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

# ── 校验：关键字段逐项未变 ────────────────────────────────
Write-Host "`n[4/4] 校验" -ForegroundColor Cyan
$after = ([System.IO.File]::ReadAllText($pkgFile) | ConvertFrom-Json)

# bundles：原数组必须是新数组的前缀（只允许末尾追加）
$afterBundles = @($after.dsh.profile.bundles)
$prefixOk = $true
for ($i = 0; $i -lt $origBundles.Count; $i++) {
  if ($afterBundles[$i] -ne $origBundles[$i]) { $prefixOk = $false; break }
}
if (-not $prefixOk -or $afterBundles.Count -lt $origBundles.Count) {
  Copy-Item $backup $pkgFile -Force
  throw "校验失败：bundles 前缀被改动，已从备份恢复。"
}
Write-Host "      ✓ bundles 原 $($origBundles.Count) 项逐项未变（现 $($afterBundles.Count) 项）" -ForegroundColor Green

# dependencies：原键集合必须是新键集合的子集，且最多只多出 PluginName
$afterKeys = @($after.dependencies.PSObject.Properties.Name)
$missing = @($origDepKeys | Where-Object { $afterKeys -notcontains $_ })
$added = @($afterKeys | Where-Object { $origDepKeys -notcontains $_ })
if ($missing.Count -gt 0) {
  Copy-Item $backup $pkgFile -Force
  throw "校验失败：丢失了依赖键 [$($missing -join ', ')]，已从备份恢复。"
}
if ($added.Count -gt 1 -or ($added.Count -eq 1 -and $added[0] -ne $PluginName)) {
  Copy-Item $backup $pkgFile -Force
  throw "校验失败：新增了非预期依赖键 [$($added -join ', ')]，已从备份恢复。"
}
Write-Host "      ✓ dependencies 无丢失，仅新增 [$($added -join ', ')]" -ForegroundColor Green
Write-Host "      ✓ 新 SHA256 = $((Get-FileHash $pkgFile -Algorithm SHA256).Hash)"

# 记录到安装状态
$stateFile = Join-Path $pluginRoot 'tools\.install-state.json'
$state = if (Test-Path $stateFile) { Get-Content -Raw $stateFile | ConvertFrom-Json } else { [pscustomobject]@{} }
$state | Add-Member -NotePropertyName 'profilePackage' -NotePropertyValue $pkgFile -Force
$state | Add-Member -NotePropertyName 'profilePackageBackup' -NotePropertyValue $backup -Force
$state | Add-Member -NotePropertyName 'profilePackageOriginalHash' -NotePropertyValue $origHash -Force
$state | ConvertTo-Json -Depth 6 | Set-Content -Path $stateFile -Encoding utf8

Write-Host "`n=== 完成 ===" -ForegroundColor Cyan
Write-Host "下一步：重启 DSH Desktop" -ForegroundColor Yellow
