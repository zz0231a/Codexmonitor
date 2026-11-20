#Requires -Version 5
# 双击启动副屏桥接。已经在监听时不重复启动。
param([switch]$NoPrompt)

$ErrorActionPreference = 'Stop'
$BridgeDir = Split-Path -Parent $PSScriptRoot
$NodeExe = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $NodeExe)) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodeExe = $cmd.Source }
}
$MainTs = Join-Path $BridgeDir 'src\main.ts'
$ConfigPath = Join-Path $BridgeDir 'config.json'
$TsxPkg = Join-Path $BridgeDir 'node_modules\tsx\package.json'

function Show-Result([string]$text) {
  if ($NoPrompt) {
    Write-Output $text
    return
  }
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show($text, '副屏桥接')
}

function Test-BridgeUp {
  try {
    $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:8973/api/v1/health' -UseBasicParsing -TimeoutSec 2
    return $resp.StatusCode -ge 200 -and $resp.StatusCode -lt 500
  } catch {
    $code = 0
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    return $code -ge 400 -and $code -lt 600
  }
}

if (-not (Test-Path -LiteralPath $NodeExe)) {
  Show-Result "没有找到 Node.js，桥接无法启动。预期位置：C:\Program Files\nodejs\node.exe"
  exit 1
}
if (-not (Test-Path -LiteralPath $MainTs) -or -not (Test-Path -LiteralPath $TsxPkg)) {
  Show-Result "桥接程序文件不完整，无法启动。目录：$BridgeDir"
  exit 1
}

if (Test-BridgeUp) {
  Show-Result "副屏桥接已经在运行。屏幕大约一两秒后会连上。"
  exit 0
}

$LogDir = Join-Path $BridgeDir 'logs'
[void](New-Item -ItemType Directory -Path $LogDir -Force)
# 每次启动保留独立日志，避免覆盖历史故障记录。
$LogStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
Start-Process -FilePath $NodeExe `
  -ArgumentList "--import tsx `"$MainTs`" --config `"$ConfigPath`"" `
  -WorkingDirectory $BridgeDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $LogDir "bridge-$LogStamp.out.log") `
  -RedirectStandardError (Join-Path $LogDir "bridge-$LogStamp.err.log")

$up = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 400
  if (Test-BridgeUp) { $up = $true; break }
}

if ($up) {
  Show-Result "副屏桥接已启动。屏幕大约一两秒后会恢复。"
  exit 0
}

Show-Result "副屏桥接没有在 8 秒内启动成功。可以再双击一次。"
exit 1
