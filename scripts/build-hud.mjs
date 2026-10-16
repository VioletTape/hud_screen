import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('dotnet', [
  'publish', path.join(projectRoot, 'src/native/ControlPanel.Hud/ControlPanel.Hud.csproj'),
  '--configuration', 'Release',
  '--runtime', 'win-x64',
  '--self-contained', 'true',
  '-p:EnableWindowsTargeting=true',
  '--output', path.join(projectRoot, 'dist/windows/hud'),
], { cwd: projectRoot, stdio: 'inherit' });

if (result.error) throw new Error(`Could not build the native HUD. Install the .NET 10 SDK. ${result.error.message}`);
process.exitCode = result.status ?? 1;
