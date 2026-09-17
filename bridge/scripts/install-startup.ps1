#Requires -Version 5
# 为当前用户安装 Codex Monitor Bridge 登录启动项（无需管理员权限）。
$ErrorActionPreference = "Stop"

$AppName = "Codex Monitor Bridge"
$BridgeDir = Split-Path -Parent $PSScriptRoot
$NodeExe = (Get-Command node -ErrorAction Stop).Source
$StartupDir = [Environment]::GetFolderPath("Startup")
$ShortcutPath = Join-Path $StartupDir "$AppName.lnk"

$Wsh = New-Object -ComObject WScript.Shell
$Shortcut = $Wsh.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $NodeExe
$Shortcut.Arguments = "--import tsx `"$BridgeDir\src\main.ts`" --config `"$BridgeDir\config.json`""
$Shortcut.WorkingDirectory = $BridgeDir
$Shortcut.WindowStyle = 7
$Shortcut.Description = "Codex Monitor Bridge (current user)"
$Shortcut.Save()

Write-Host "Installed: $ShortcutPath"
