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

// Query GPU utilization via nvidia-smi without spawning PowerShell/WMI.
async function getGpuUsage(): Promise<number | null> {
  try {
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
    { key: 'gpu', label: 'GPU', value: format(gpu) },
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
