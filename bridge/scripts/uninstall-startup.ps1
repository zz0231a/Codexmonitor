#Requires -Version 5
# 移除当前用户的 Codex Monitor Bridge 登录启动项；只删除本应用创建的快捷方式。
$ErrorActionPreference = "Stop"

$AppName = "Codex Monitor Bridge"
$ShortcutPath = Join-Path ([Environment]::GetFolderPath("Startup")) "$AppName.lnk"

if (Test-Path $ShortcutPath) {
  Remove-Item $ShortcutPath -Force
  Write-Host "Removed: $ShortcutPath"
} else {
  Write-Host "Not installed: $ShortcutPath"
}
