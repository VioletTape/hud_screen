<#
.SYNOPSIS
    Opens the native WebView2 HUD on the third display (zero-based index 2).
#>
Param(
    [string]$Url = "http://localhost:3888/",
    [int]$MonitorIndex = 2
)

$ErrorActionPreference = 'Stop'
$executable = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist\windows\hud\ControlPanel.Hud.exe'))
if (-not (Test-Path $executable)) {
    throw 'Native HUD is missing. Run npm run build:hud first.'
}

$hudUri = $null
if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$hudUri) -or $hudUri.Scheme -notin @('http', 'https')) {
    throw 'Url must be an absolute HTTP or HTTPS URL.'
}

Start-Process -FilePath $executable -WorkingDirectory (Split-Path -Parent $executable) -ArgumentList @('--url', "`"$($hudUri.AbsoluteUri)`"", '--monitor-index', $MonitorIndex)
