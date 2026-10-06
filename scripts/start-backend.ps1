$executable = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist\windows\ControlPanel.exe'))
Start-Process -FilePath $executable -WorkingDirectory (Split-Path -Parent $executable) -WindowStyle Minimized
