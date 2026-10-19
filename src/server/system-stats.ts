import { execFile } from 'node:child_process';
import { cpus, freemem, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { ProviderResult } from '../shared/types.js';

const execFileAsync = promisify(execFile);
let previousCpus = cpus();

// Node os.cpus() reports cumulative ticks since boot; diff against the previous snapshot
// to calculate average active vs. idle CPU across all cores over the full interval
// (falling back to a 500ms sample only on initial boot when elapsed ticks are zero).
async function getCpuUsage(): Promise<number | null> {
  let before = previousCpus;
  let after = cpus();
  if (before.length !== after.length) {
    previousCpus = after;
    return null;
  }

  const measure = () => {
    let total = 0;
    let idle = 0;
    for (let i = 0; i < before.length; i++) {
      const previous = before[i].times;
      const current = after[i].times;
      total += Object.values(current).reduce((sum, time) => sum + time, 0) -
        Object.values(previous).reduce((sum, time) => sum + time, 0);
      idle += current.idle - previous.idle;
    }
    return { total, idle };
  };

  let { total, idle } = measure();
  if (total <= 0) {
    before = after;
    await new Promise(resolve => setTimeout(resolve, 500));
    after = cpus();
    if (before.length !== after.length) return null;
    ({ total, idle } = measure());
  }

  previousCpus = after;
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : null;
}

// Use the Windows 3D engine counter to distinguish graphics use from GPU compute.
async function getGpuUsage(): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      const command =
        "$samples = (Get-Counter -Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop).CounterSamples | Where-Object { $_.InstanceName -match 'engtype_3D' }; " +
        "$loads = $samples | Group-Object { $_.InstanceName -replace '^pid_\\d+_', '' } | ForEach-Object { ($_.Group | Measure-Object -Property CookedValue -Sum).Sum }; " +
        "$usage = ($loads | Measure-Object -Maximum).Maximum; if ($null -ne $usage) { $usage.ToString([Globalization.CultureInfo]::InvariantCulture) }";
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        { timeout: 30000, windowsHide: true },
      );
      const output = stdout.trim();
      const usage = Number(output);
      return output && Number.isFinite(usage) ? Math.max(0, Math.min(100, usage)) : null;
    }

    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true },
    );
    const output = stdout.trim();
    if (!output) return null;
    const values = output.split(/\r?\n/).map(Number).filter(Number.isFinite);
    return values.length ? Math.max(0, Math.min(100, Math.max(...values))) : null;
  } catch {
    return null;
  }
}

export async function getSystemStats(): Promise<ProviderResult> {
  const cpu = await getCpuUsage();
  const gpu = await getGpuUsage();
  const memory = totalmem() ? (1 - freemem() / totalmem()) * 100 : null;
  const format = (value: number | null) => value == null ? 'N/A' : `${Math.round(value)}%`;
  const metrics = [
    { key: 'cpu', label: 'CPU', value: format(cpu) },
    { key: 'memory', label: 'MEM', value: format(memory) },
    { key: 'gpu', label: process.platform === 'win32' ? '3D GPU' : 'GPU', value: format(gpu) },
  ];

  return {
    source: 'system',
    displayName: 'System Stats',
    status: 'healthy',
    statusMessage: 'Host resource usage',
    lastUpdated: new Date().toISOString(),
    metrics,
    notifications: [],
  };
}
