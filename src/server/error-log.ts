import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

const LOG_DIR = path.join(CONFIG_DIR, 'logs');

export function logError(source: string, error: unknown): void {
  const now = new Date();
  const hour = now.toISOString().slice(0, 13).replace('T', '-');
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 13).replace('T', '-');
  const message = error instanceof Error ? error.stack || error.message : String(error);

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `errors-${hour}.log`), `${now.toISOString()} [${source}] ${message}\n`);
    for (const file of fs.readdirSync(LOG_DIR)) {
      if (/^errors-\d{4}-\d{2}-\d{2}-\d{2}\.log$/.test(file) && file.slice(7, 20) < cutoff) {
        fs.unlinkSync(path.join(LOG_DIR, file));
      }
    }
  } catch (logFailure) {
    console.error('[Error log] Could not write or rotate error log:', logFailure);
    console.error(`[${source}]`, error);
  }
}

export function logSlackPoll(stats: Record<string, unknown>): void {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, `slack-polls-${date}.jsonl`),
      `${JSON.stringify({ ...stats, timestamp: now.toISOString() })}\n`,
    );
    for (const file of fs.readdirSync(LOG_DIR)) {
      const match = /^slack-polls-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(file);
      if (match && Date.parse(`${match[1]}T00:00:00Z`) < cutoff) fs.unlinkSync(path.join(LOG_DIR, file));
    }
  } catch (logFailure) {
    console.error('[Slack log] Could not write or rotate polling log:', logFailure);
  }
}
