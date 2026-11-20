Option Explicit
Dim shell, fs, scriptDir, launcher, powershell, command, logFile
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
scriptDir = fs.GetParentFolderName(WScript.ScriptFullName)
launcher = fs.BuildPath(scriptDir, "start-bridge.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = Chr(34) & powershell & Chr(34) & " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Chr(34) & launcher & Chr(34) & " -NoPrompt"

' 留痕：启动失败时可在 bridge\logs\startup-launcher.log 看到原因。
' 只写 ASCII，避免 TextStream 默认编码无法写中文路径。
On Error Resume Next
Set logFile = fs.OpenTextFile(fs.BuildPath(fs.GetParentFolderName(scriptDir), "logs\startup-launcher.log"), 8, True)
If Err.Number = 0 Then
  logFile.WriteLine(Now & " launch pid-wait begin")
End If
Err.Clear

shell.Run command, 0, True

If Not logFile Is Nothing Then
  If Err.Number <> 0 Then
    logFile.WriteLine(Now & " run failed err=" & Err.Number)
  Else
    logFile.WriteLine(Now & " run ok")
  End If
  logFile.Close
End If
