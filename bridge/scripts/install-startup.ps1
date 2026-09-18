#Requires -Version 5
# 为当前用户安装 Codex Monitor Bridge 登录启动项（无需管理员权限）。
$ErrorActionPreference = "Stop"

$AppName = "Codex Monitor Bridge"
$BridgeDir = Split-Path -Parent $PSScriptRoot
$NodeExe = (Get-Command node -ErrorAction Stop).Source
$MainTs = Join-Path $BridgeDir "src\main.ts"
$ConfigPath = Join-Path $BridgeDir "config.json"
$TsxPkg = Join-Path $BridgeDir "node_modules\tsx\package.json"
if (-not (Test-Path $MainTs)) { throw "Bridge entry not found: $MainTs" }
if (-not (Test-Path $TsxPkg)) { throw "tsx is not installed in $BridgeDir" }

$StartupDir = [Environment]::GetFolderPath("Startup")
$ShortcutPath = Join-Path $StartupDir "$AppName.lnk"

$Wsh = New-Object -ComObject WScript.Shell
$Shortcut = $Wsh.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $NodeExe
$Shortcut.Arguments = "--import tsx `"$MainTs`" --config `"$ConfigPath`""
$Shortcut.WorkingDirectory = $BridgeDir
$Shortcut.WindowStyle = 0
$Shortcut.Description = "Codex Monitor Bridge (current user)"
$Shortcut.Save()

Write-Host "Installed: $ShortcutPath"
