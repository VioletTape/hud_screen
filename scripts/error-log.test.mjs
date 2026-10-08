import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-error-log-'));

try {
  process.chdir(tempDir);
  const { logError } = await import('../src/server/error-log.ts');
  const logDir = path.join(tempDir, 'config', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'errors-2000-01-01-00.log'), 'old\n');

  logError('GitLab user', 'HTTP 429; Retry-After: 30');

  const files = fs.readdirSync(logDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^errors-\d{4}-\d{2}-\d{2}-\d{2}\.log$/);
  assert.match(fs.readFileSync(path.join(logDir, files[0]), 'utf8'), /\[GitLab user\] HTTP 429; Retry-After: 30/);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('', { status: 429, headers: { 'Retry-After': '30' } });
    const { GitLabProvider } = await import('../src/server/providers/gitlab.ts');
    const result = await new GitLabProvider().testConnection({ baseUrl: 'https://gitlab.invalid', token: 'test-secret' });
    assert.equal(result.success, false);
    assert.match(result.message, /HTTP error: 429/);
    const log = fs.readFileSync(path.join(logDir, files[0]), 'utf8');
    assert.match(log, /\[GitLab connection test \/user\] HTTP 429; Retry-After: 30/);
    assert.doesNotMatch(log, /test-secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  process.chdir(originalCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
}
