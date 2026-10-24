#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getUserSecretsPath, loadUserSecrets, SECRET_FIELDS } from '../dist/server/config.js';

const cmd = process.argv[2] || 'path';
const secretsPath = getUserSecretsPath();

switch (cmd) {
  case 'path': {
    console.log(secretsPath);
    break;
  }
  case 'list': {
    console.log(`User Secrets Path: ${secretsPath}\n`);
    const secrets = loadUserSecrets();
    if (Object.keys(secrets).length === 0) {
      console.log('No secrets stored yet.');
    } else {
      for (const [section, fields] of Object.entries(SECRET_FIELDS)) {
        console.log(`[${section}]`);
        for (const field of fields) {
          const val = secrets[section]?.[field];
          console.log(`  ${field}: ${val ? '••••••••' : '(not set)'}`);
        }
      }
    }
    break;
  }
  case 'open': {
    console.log(`Opening ${secretsPath}...`);
    const dir = path.dirname(secretsPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(secretsPath, '{}\n', { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    } catch (err) {
      if (err && err.code !== 'EEXIST') throw err;
    }
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'notepad', secretsPath], { detached: true });
    } else {
      spawn('xdg-open', [secretsPath], { detached: true });
    }
    break;
  }
  default: {
    console.log(`Usage: node scripts/user-secrets.js [path|list|open]`);
    break;
  }
}
