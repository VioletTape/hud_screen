<#
.SYNOPSIS
    Launches the Control Panel HUD in borderless app mode on the 8.8" secondary screen.
.DESCRIPTION
    Detects attached screens, finds the secondary display (or 8.8" 1920x480 / 480x1920 bar screen),
    and opens Microsoft Edge or Google Chrome targeted directly to its exact coordinates.
#>

Param(
    [string]$Url = "http://localhost:3888/",
    [int]$MonitorIndex = -1,
    [switch]$Kiosk
)

Add-Type -AssemblyName System.Windows.Forms

$screens = [System.Windows.Forms.Screen]::AllScreens
Write-Host "Detected $($screens.Count) display monitor(s):" -ForegroundColor Cyan

$targetScreen = $null

for ($i = 0; $i -lt $screens.Count; $i++) {
    $s = $screens[$i]
    $w = $s.Bounds.Width
    $h = $s.Bounds.Height
    $is88 = ($w -eq 1920 -and $h -eq 480) -or ($w -eq 480 -and $h -eq 1920) -or ($w -eq 1280 -and $h -eq 320)
    
    $tag = ""
    if ($s.Primary) { $tag += " [Primary]" }
    if ($is88) { $tag += " [8.8`" Bar Screen MATCH]" }

    Write-Host "  [$i] $($s.DeviceName): ${w}x${h} at ($($s.Bounds.X), $($s.Bounds.Y))$tag"

    if ($MonitorIndex -ge 0 -and $i -eq $MonitorIndex) {
        $targetScreen = $s
    } elseif ($targetScreen -eq $null -and $is88) {
        $targetScreen = $s
    } elseif ($targetScreen -eq $null -and -not $s.Primary) {
        $targetScreen = $s
    }
}

if ($targetScreen -eq $null) {
    Write-Host "Defaulting to primary screen." -ForegroundColor Yellow
    $targetScreen = [System.Windows.Forms.Screen]::PrimaryScreen
}

Write-Host "`nTargeting Screen: $($targetScreen.DeviceName) ($($targetScreen.Bounds.Width)x$($targetScreen.Bounds.Height) at X=$($targetScreen.Bounds.X), Y=$($targetScreen.Bounds.Y))" -ForegroundColor Green

$x = $targetScreen.Bounds.X
$y = $targetScreen.Bounds.Y
$width = $targetScreen.Bounds.Width
$height = $targetScreen.Bounds.Height

# Browser arguments
$appArgs = "--new-window --app=`"$Url`" --window-position=$x,$y --window-size=$width,$height"
if ($Kiosk) {
    $appArgs += " --kiosk"
}

Write-Host "Launching Microsoft Edge..." -ForegroundColor Cyan
Start-Process "msedge.exe" -ArgumentList $appArgs
Write-Host "HUD window created successfully on $($targetScreen.DeviceName)!" -ForegroundColor Green
