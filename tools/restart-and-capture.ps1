<#
.SYNOPSIS
  重启 DSH Desktop，并把它的 stdout/stderr 捕获到文件，用于观察插件加载日志。

.DESCRIPTION
  DSH Desktop 没有专门的日志文件（插件加载信息走进程 stdout）。
  要验证插件是否加载，必须重启并捕获输出。

  安全性：DSH 的会话是持续落盘的（<DSH_HOME>\sessions\**.jsonl.zstd），
  重启不会丢会话历史。

.PARAMETER WaitSeconds
  重启后等待多久再读日志（默认 20 秒）。
#>
[CmdletBinding()]
param(
  [string]$ExePath = 'D:\Programs\Deepseek\DeepSeek Harness.exe',
  [string]$LogFile = 'D:\Ecode\.dsh\dsh-desktop-boot.log',
  [int]$WaitSeconds = 20,
  [string]$DshHome = ''
)

$ErrorActionPreference = 'Stop'

# ⚠️ **必须**显式确定 DSH_HOME（2026-10-10 实测事故）。
# Desktop 用它决定加载哪个 profile。若从"环境里没有 DSH_HOME"的进程启动
#（例如从 AI 会话 / 计划任务 / 另一个 shell），它会退回默认 `%USERPROFILE%\.dsh` →
# 你启动的是**另一个实例**（那里没有本插件），而观测点（trace / load-report）
# 还停在原来的 `DSH_HOME` → 现象是"插件突然不加载了"，极难排查。
if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) {
  if ([string]::IsNullOrWhiteSpace($DshHome)) {
    throw "DSH_HOME 未设置，且未传 -DshHome。拒绝启动：Desktop 会退回 %USERPROFILE%\.dsh 起一个**没有本插件**的实例。请先 `$env:DSH_HOME='D:\Ecode\.dsh'` 或传 -DshHome。"
  }
  $env:DSH_HOME = $DshHome
  Write-Host "  DSH_HOME 未设置 → 显式使用 $DshHome" -ForegroundColor Yellow
} else {
  Write-Host "  DSH_HOME = $env:DSH_HOME" -ForegroundColor DarkGray
}

Write-Host "=== 重启 DSH Desktop 并捕获启动日志 ===" -ForegroundColor Cyan

if (-not (Test-Path $ExePath)) { throw "找不到 $ExePath" }

# 备份旧日志
if (Test-Path $LogFile) {
  $prev = "$LogFile.prev"
  Copy-Item $LogFile $prev -Force
  Write-Host "  旧日志已留档 → $prev" -ForegroundColor DarkGray
}

# ── 0) 先捕获现有实例的完整命令行（用于原样重启）────────────
Write-Host "`n[0/3] 捕获现有实例的启动参数…" -ForegroundColor Cyan
$mainProc = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*dsh-desktop-host*' } |
  Select-Object -First 1

$launchArgs = @()
if ($mainProc) {
  # 从命令行里剥掉 exe 本身，得到参数数组
  $cmd = $mainProc.CommandLine
  $exeQuoted = '"' + $ExePath + '"'
  if ($cmd.StartsWith($exeQuoted)) {
    $rest = $cmd.Substring($exeQuoted.Length).Trim()
    # 按 " 分段，保留带引号的路径
    $launchArgs = [regex]::Matches($rest, '"[^"]*"|\S+') | ForEach-Object { $_.Value.Trim('"') }
    Write-Host "      捕获到 $($launchArgs.Count) 个参数：" -ForegroundColor Green
    for ($i = 0; $i -lt $launchArgs.Count; $i++) { Write-Host "        [$i] $($launchArgs[$i])" }
  } else {
    Write-Host "      ⚠ 命令行格式不符预期，将不带参数重启" -ForegroundColor Yellow
    Write-Host "        原始: $cmd" -ForegroundColor DarkGray
  }
} else {
  Write-Host "      未找到主进程，将不带参数重启" -ForegroundColor Yellow
}

# ── 1) 停掉现有实例 ─────────────────────────────────────
$procs = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
if ($procs) {
  Write-Host "`n[1/3] 停止现有实例（$($procs.Count) 个进程）…" -ForegroundColor Cyan
  $procs | ForEach-Object { "      PID $($_.Id)" }
  $procs | Stop-Process -Force
  Start-Sleep -Seconds 4
  $left = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($left) {
    Write-Host "      ⚠ 仍有 $($left.Count) 个进程存活，再等 4 秒" -ForegroundColor Yellow
    Start-Sleep -Seconds 4
    $left | Stop-Process -Force
  }
  Write-Host "      已停止" -ForegroundColor Green
} else {
  Write-Host "`n[1/3] 当前没有运行中的实例" -ForegroundColor DarkGray
}

# ── 2) 用原参数重启，并重定向输出 ─────────────────────────
Write-Host "`n[2/3] 启动并将 stdout/stderr 写入：$LogFile" -ForegroundColor Cyan
$spArgs = @{
  FilePath               = $ExePath
  RedirectStandardOutput = $LogFile
  RedirectStandardError  = "$LogFile.err"
  PassThru               = $true
}
if ($launchArgs.Count -gt 0) { $spArgs.ArgumentList = $launchArgs }
$proc = Start-Process @spArgs
Write-Host "      已启动 PID $($proc.Id)" -ForegroundColor Green

# ── 3) 等待并抓关键日志 ─────────────────────────────────
Write-Host "`n[3/3] 等待 $WaitSeconds 秒后抓取日志…" -ForegroundColor Cyan
Start-Sleep -Seconds $WaitSeconds

foreach ($f in @($LogFile, "$LogFile.err")) {
  if (-not (Test-Path $f)) { continue }
  $size = (Get-Item $f).Length
  Write-Host "`n──── $f  ($size 字节) ────" -ForegroundColor DarkCyan
  if ($size -eq 0) { Write-Host "  (空)" -ForegroundColor DarkGray; continue }

  # 先看有没有我们插件的痕迹
  $hits = Select-String -Path $f -Pattern 'multi-acp' -SimpleMatch
  if ($hits) {
    Write-Host "  ✓ 发现 $($hits.Count) 条 dsh-multi-acp 相关日志：" -ForegroundColor Green
    $hits | Select-Object -First 30 | ForEach-Object { "    L$($_.LineNumber): $($_.Line)" }
  } else {
    Write-Host "  ✗ 未发现 dsh-multi-acp 相关日志" -ForegroundColor Yellow
  }

  # 再看有没有加载错误
  $errs = Select-String -Path $f -Pattern 'error|failed|cannot|throw' -ErrorAction SilentlyContinue
  if ($errs) {
    Write-Host "  ⚠ 含错误关键词的行（前 15 条）：" -ForegroundColor Yellow
    $errs | Select-Object -First 15 | ForEach-Object { "    L$($_.LineNumber): $($_.Line)" }
  }

  # 打印尾部
  Write-Host "  ── 尾部 25 行 ──" -ForegroundColor DarkGray
  Get-Content $f -Tail 25 | ForEach-Object { "    $_" }
}

Write-Host "`n=== 完成 ===" -ForegroundColor Cyan
Write-Host "如需回滚：powershell -File tools\rollback.ps1" -ForegroundColor DarkGray
