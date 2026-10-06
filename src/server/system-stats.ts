import { execFile } from 'node:child_process';
import { cpus, freemem, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { ProviderResult } from '../shared/types.js';

const execFileAsync = promisify(execFile);

async function getCpuUsage(): Promise<number | null> {
  const before = cpus();
  await new Promise(resolve => setTimeout(resolve, 500));
  const after = cpus();
  if (before.length !== after.length) return null;

  let total = 0;
  let idle = 0;
  for (let i = 0; i < before.length; i++) {
    const previous = before[i].times;
    const current = after[i].times;
    total += Object.values(current).reduce((sum, time) => sum + time, 0) -
      Object.values(previous).reduce((sum, time) => sum + time, 0);
    idle += current.idle - previous.idle;
  }
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : null;
}

async function getGpuUsage(): Promise<number | null> {
  try {
    const { stdout } = process.platform === 'win32'
      ? await execFileAsync('powershell.exe', ['-NoProfile', '-Command',
        '(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | Where-Object { $_.Name -match "engtype_3D" } | Measure-Object -Property UtilizationPercentage -Maximum).Maximum'], { timeout: 5000 })
      : await execFileAsync('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 5000 });
    const output = stdout.trim();
    if (!output) return null;
    const values = output.split(/\r?\n/).map(Number).filter(Number.isFinite);
    return values.length ? Math.max(0, Math.min(100, Math.max(...values))) : null;
  } catch {
    return null;
  }
}

export async function getSystemStats(): Promise<ProviderResult> {
  const [cpu, gpu] = await Promise.all([getCpuUsage(), getGpuUsage()]);
  const memory = totalmem() ? (1 - freemem() / totalmem()) * 100 : null;
  const format = (value: number | null) => value == null ? 'N/A' : `${Math.round(value)}%`;
  const metrics = [
    { key: 'cpu', label: 'CPU', value: format(cpu) },
    { key: 'memory', label: 'MEM', value: format(memory) },
    { key: 'gpu', label: process.platform === 'win32' ? 'GPU 3D' : 'GPU', value: format(gpu) },
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
