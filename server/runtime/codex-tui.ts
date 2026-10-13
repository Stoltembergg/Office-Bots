// "Assumir daqui" no Codex: o TUI dono de um thread é o processo `codex` que mantém aberto o lock
// <CODEX_HOME>/thread-writer-locks/<thread>.lock (o arquivo é vazio; quem o segura aparece no `lsof`). Antes de
// encerrar, confere que o pid ainda é o mesmo processo (nome e horário de início), como o PtyManager faz no Claude.
import { execFile } from 'node:child_process';
import { join } from 'node:path';

export interface TuiProcess {
  pid: number;
  startMs: number;
}
export type HoldersOf = (file: string) => Promise<number[]>;
export type ProcName = (pid: number) => Promise<{ name: string; startMs: number } | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERM_WAIT_MS = 5_000;

const run = (bin: string, args: string[]) =>
  new Promise<string>((ok) => execFile(bin, args, { timeout: 5_000, encoding: 'utf8' }, (_err, out) => ok(String(out ?? ''))));

export const lsofHolders: HoldersOf = async (file) =>
  (await run('lsof', ['-t', file]))
    .split('\n')
    .map((l) => Number.parseInt(l, 10))
    .filter((n) => Number.isInteger(n) && n > 0);

export const psProc: ProcName = async (pid) => {
  const out = (await run('ps', ['-o', 'lstart=,comm=', '-p', String(pid)])).trim();
  const m = /^(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.+)$/.exec(out);
  if (!m) return undefined;
  const startMs = Date.parse(m[1]);
  return Number.isFinite(startMs) ? { name: m[2].split('/').pop() ?? m[2], startMs } : undefined;
};

export async function findCodexTui(codexHome: string, threadId: string, deps: { holders?: HoldersOf; proc?: ProcName } = {}): Promise<TuiProcess | undefined> {
  if (!UUID.test(threadId)) return undefined;
  const pids = await (deps.holders ?? lsofHolders)(join(codexHome, 'thread-writer-locks', `${threadId}.lock`));
  for (const pid of pids) {
    const p = await (deps.proc ?? psProc)(pid);
    if (p?.name === 'codex') return { pid, startMs: p.startMs };
  }
  return undefined;
}

export async function stopCodexTui(
  tui: TuiProcess,
  deps: { proc?: ProcName; kill?: (pid: number) => void; isAlive?: (pid: number) => boolean; sleep?: (ms: number) => Promise<void> } = {},
): Promise<'stopped' | 'gone' | 'changed' | 'stuck'> {
  const now = await (deps.proc ?? psProc)(tui.pid);
  if (!now) return 'gone';
  if (now.name !== 'codex' || Math.abs(now.startMs - tui.startMs) > 1_000) return 'changed';
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, 'SIGTERM'));
  const isAlive = deps.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  kill(tui.pid);
  for (let waited = 0; waited < TERM_WAIT_MS; waited += 100) {
    if (!isAlive(tui.pid)) return 'stopped';
    await sleep(100);
  }
  return isAlive(tui.pid) ? 'stuck' : 'stopped';
}
