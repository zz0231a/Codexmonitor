$BridgeDir = Split-Path -Parent $PSScriptRoot
$MainTs = Join-Path $BridgeDir 'src\main.ts'
$ConfigPath = Join-Path $BridgeDir 'config.json'
Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentList @('--import', 'tsx', "`"$MainTs`"", '--config', "`"$ConfigPath`"") `
  -WorkingDirectory $BridgeDir -WindowStyle Hidden
Start-Sleep 4
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'main\.ts' } |
  Select-Object ProcessId, CommandLine | Format-List
