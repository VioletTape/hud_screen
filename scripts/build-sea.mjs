import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('Run this build with Windows Node.js.');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 12)) throw new Error('Node.js 20.12 or newer is required.');

const outputDir = path.join(projectRoot, 'dist', 'windows');
const temporaryDir = mkdtempSync(path.join(os.tmpdir(), 'control-panel-sea-'));
const clientDir = path.join(projectRoot, 'src', 'client');
const configSource = path.join(projectRoot, 'config', 'config.json');
const configTarget = path.join(outputDir, 'config.json');

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with exit code ${result.status}`);
}

try {
  mkdirSync(outputDir, { recursive: true });
  const bundlePath = path.join(temporaryDir, 'server.cjs');
  const blobPath = path.join(temporaryDir, 'sea.blob');
  const seaConfigPath = path.join(temporaryDir, 'sea-config.json');
  const assets = Object.fromEntries(listFiles(clientDir).map(file => [
    `client/${path.relative(clientDir, file).split(path.sep).join('/')}`,
    file,
  ]));

  await build({
    entryPoints: [path.join(projectRoot, 'src', 'server', 'index.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
  });

  writeFileSync(seaConfigPath, JSON.stringify({
    main: bundlePath,
    output: blobPath,
    assets,
    useSnapshot: false,
    useCodeCache: false,
  }));

  run(process.execPath, ['--experimental-sea-config', seaConfigPath]);

  const executablePath = path.join(outputDir, 'ControlPanel.exe');
  const postjectCli = path.join(projectRoot, 'node_modules', 'postject', 'dist', 'cli.js');
  if (!existsSync(postjectCli)) throw new Error('postject is missing. Run npm install first.');
  copyFileSync(process.execPath, executablePath);
  run(process.execPath, [
    postjectCli,
    executablePath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ]);

  if (existsSync(configSource) && !existsSync(configTarget)) copyFileSync(configSource, configTarget);
  console.log(`Built ${path.relative(projectRoot, executablePath)}`);
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
