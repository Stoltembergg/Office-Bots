import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const outputDir = join('out', `Office Bots-${process.platform}-${process.arch}`);
const executable = process.platform === 'darwin'
  ? join(outputDir, 'Office Bots.app', 'Contents', 'MacOS', 'office-bots')
  : join(outputDir, process.platform === 'win32' ? 'office-bots.exe' : 'office-bots');

if (!existsSync(executable)) throw new Error(`Packaged app executable not found: ${executable}`);

const temporaryHome = await mkdtemp(join(tmpdir(), 'office-bots-desktop-smoke-'));
const args = [
  `--user-data-dir=${join(temporaryHome, 'user-data')}`,
  '--office-bots-smoke-test',
];
if (process.platform === 'linux') args.unshift('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage');

const child = spawn(resolve(executable), args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
    HABBLAUD_IN_DOCKER: '0',
    HABBLAUD_WORLD: '0',
    HABBLAUD_UPDATE_CHECK: '0',
    HABBLAUD_CODEX: '0',
    HABBLAUD_PTY: '0',
    HABBLAUD_MENSAGENS: '0',
    HABBLAUD_TIMELINE: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let timedOut = false;
child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill('SIGTERM');
}, 60_000);

const result = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolveExit({ code, signal }));
}).finally(async () => {
  clearTimeout(timeout);
  await rm(temporaryHome, { recursive: true, force: true });
});

if (timedOut || result.code !== 0 || (!output.includes('OFFICE_BOTS_DESKTOP_SMOKE_OK') || !output.includes('OFFICE_BOTS_PI_WORKER_SMOKE_OK'))) {
  throw new Error(`Packaged desktop smoke failed (${JSON.stringify(result)}${timedOut ? ', timed out' : ''}):\n${output}`);
}

console.log('Packaged app opened, served the client, loaded the Pi SDK in its owned worker, and exited without external Node.');
