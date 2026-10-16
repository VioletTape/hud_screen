import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { isSea } from 'node:sea';

export interface HudLaunchResult {
  success: boolean;
  message: string;
}

export function launchNativeHUD(hudUrl: string, monitorIndex = 2): Promise<HudLaunchResult> {
  const executable = isSea()
    ? path.join(path.dirname(process.execPath), 'hud', 'ControlPanel.Hud.exe')
    : path.resolve(process.cwd(), 'dist/windows/hud/ControlPanel.Hud.exe');

  if (!existsSync(executable)) {
    return Promise.resolve({
      success: false,
      message: 'Native HUD is missing. Run npm run build:hud first.',
    });
  }

  return new Promise(resolve => {
    const child = spawn(executable, ['--url', hudUrl, '--monitor-index', String(monitorIndex)], {
      cwd: path.dirname(executable),
      detached: process.platform === 'win32',
      stdio: 'ignore',
      windowsHide: false,
    });
    child.once('error', err => resolve({ success: false, message: `Failed to launch native HUD: ${err.message}` }));
    child.once('spawn', () => {
      child.unref();
      resolve({ success: true, message: `Opened native HUD on display ${monitorIndex + 1} (primary display if unavailable).` });
    });
  });
}
