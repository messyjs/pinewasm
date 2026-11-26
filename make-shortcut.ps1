$WshShell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = $WshShell.CreateShortcut("$desktop\PineWASM.lnk")
$lnk.TargetPath = "D:\AI Drive\pinewasm\node_modules\electron\dist\electron.exe"
$lnk.Arguments = "."
$lnk.WorkingDirectory = "D:\AI Drive\pinewasm"
$lnk.Save()
Write-Host "Shortcut created: $desktop\PineWASM.lnk"
