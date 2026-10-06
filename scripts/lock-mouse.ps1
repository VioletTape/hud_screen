<#
.SYNOPSIS
    Locks the mouse cursor to the primary screen, preventing it from wandering into the 8.8" HUD.
.DESCRIPTION
    Uses Windows Forms Cursor.Clip to bound the cursor. Run with -Release to unlock.
#>

Param(
    [switch]$Release
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ($Release) {
    [System.Windows.Forms.Cursor]::Clip = [System.Drawing.Rectangle]::Empty
    Write-Host "Mouse cursor released. Unrestricted movement restored across all screens." -ForegroundColor Green
} else {
    $primary = [System.Windows.Forms.Screen]::PrimaryScreen
    $rect = [System.Drawing.Rectangle]::FromLTRB($primary.Bounds.Left, $primary.Bounds.Top, $primary.Bounds.Right, $primary.Bounds.Bottom)
    [System.Windows.Forms.Cursor]::Clip = $rect
    Write-Host "Mouse cursor LOCKED to Primary Display ($($primary.Bounds.Width)x$($primary.Bounds.Height))." -ForegroundColor Yellow
    Write-Host "The cursor will NOT cross into the 8.8`" display." -ForegroundColor Cyan
    Write-Host "To release at any time: run this script with -Release or click Release in Settings." -ForegroundColor Gray
}
