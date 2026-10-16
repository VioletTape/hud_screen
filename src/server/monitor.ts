import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchNativeHUD } from './native-hud.js';

const execFileAsync = promisify(execFile);

export interface DetectedMonitor {
  index: number;
  device: string;
  isPrimary: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
  aspectRatio: string;
  isLikely88Inch: boolean;
  label: string;
}

// Query System.Windows.Forms.Screen rather than WMI to obtain accurate multi-monitor
// virtual desktop coordinates (X, Y) and orientations across Windows display settings.
export async function detectWindowsMonitors(): Promise<DetectedMonitor[]> {
  try {
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms;
      [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
        [PSCustomObject]@{
          Device = $_.DeviceName;
          Primary = $_.Primary;
          W = $_.Bounds.Width;
          H = $_.Bounds.Height;
          X = $_.Bounds.X;
          Y = $_.Bounds.Y;
        }
      } | ConvertTo-Json -Compress
    `.replace(/\n/g, ' ');

    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', psScript], {
      timeout: 8000,
    });

    const parsed = JSON.parse(stdout.trim());
    const rawList = Array.isArray(parsed) ? parsed : [parsed];

    return rawList.map((m: any, idx: number) => {
      const w = Number(m.W);
      const h = Number(m.H);
      // Match characteristic ultrawide resolutions and rotated dimensions used by 8.8" and
      // related auxiliary bar displays (e.g., 1920x480, 1280x320, 2560x720 in landscape or portrait).
      const is88 = (w === 1920 && h === 480) || (w === 480 && h === 1920) ||
                   (w === 1280 && h === 320) || (w === 320 && h === 1280) ||
                   (w === 2560 && h === 720) || (w === 720 && h === 2560);
      const ratio = (w / h).toFixed(2);

      let label = `Display ${idx + 1}: ${w}×${h} at (${m.X},${m.Y})`;
      if (m.Primary) label += ' [Primary]';
      if (is88) label += ' [Detected 8.8" Bar Screen!]';

      return {
        index: idx,
        device: m.Device,
        isPrimary: Boolean(m.Primary),
        width: w,
        height: h,
        x: Number(m.X),
        y: Number(m.Y),
        aspectRatio: `${ratio}:1`,
        isLikely88Inch: is88,
        label,
      };
    });
  } catch (err: any) {
    console.warn('[Monitor] Failed to detect monitors via PowerShell:', err.message);
    // Fallback: mock primary monitor
    return [
      {
        index: 0,
        device: '\\\\.\\DISPLAY1',
        isPrimary: true,
        width: 1920,
        height: 1080,
        x: 0,
        y: 0,
        aspectRatio: '1.78:1',
        isLikely88Inch: false,
        label: 'Display 1: 1920×1080 [Default]',
      },
    ];
  }
}

export async function launchHUDOnMonitor(monitor: DetectedMonitor, hudUrl: string): Promise<{ success: boolean; message: string }> {
  return launchNativeHUD(hudUrl, monitor.index);
}

// Confine the cursor to the primary display rectangle via Win32 ClipCursor, preventing
// unintentional mouse drift onto the auxiliary dashboard display during normal desktop use.
export async function clipMouseToMonitors(excludeMonitorIndex?: number): Promise<{ success: boolean; message: string }> {
  try {
    // If we want to clip cursor to exclude the 8.8" monitor, we find the bounding rectangle of the remaining monitors
    const monitors = await detectWindowsMonitors();
    const primary = monitors.find(m => m.isPrimary) || monitors[0];

    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms;
      [System.Windows.Forms.Cursor]::Clip = [System.Drawing.Rectangle]::FromLTRB(${primary.x}, ${primary.y}, ${primary.x + primary.width}, ${primary.y + primary.height})
    `.replace(/\n/g, ' ');

    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', psScript], { timeout: 5000 });
    return {
      success: true,
      message: `Cursor locked to Primary Display (${primary.width}×${primary.height}). Mouse will not wander onto secondary display!`,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to lock cursor: ${err.message || String(err)}`,
    };
  }
}

export async function releaseMouseClip(): Promise<{ success: boolean; message: string }> {
  try {
    const psScript = `
      Add-Type -AssemblyName System.Windows.Forms;
      [System.Windows.Forms.Cursor]::Clip = [System.Drawing.Rectangle]::Empty
    `.replace(/\n/g, ' ');

    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', psScript], { timeout: 5000 });
    return {
      success: true,
      message: 'Mouse cursor restriction released (normal unrestricted movement).',
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to release cursor: ${err.message || String(err)}`,
    };
  }
}
