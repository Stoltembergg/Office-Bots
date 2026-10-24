import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { CURRENT_SESSION_VERSION, SessionManager } from '@earendil-works/pi-coding-agent';
import type { RuntimeResumeConfig, RuntimeSessionConfig, RuntimeMessageReceipt } from '../runtime';
import { WorkerFailure } from './protocol';

const customType = 'office-bots';
const safeSessionId = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const digest = /^[a-f0-9]{64}$/;
const outcomes = ['completed', 'cancelled', 'error'] as const;
type Binding = {
  schemaVersion: 1;
  kind: 'session';
  appSessionId: string;
  runtimeSessionId: string;
  projectId: string;
  agentId: string;
  selection: RuntimeSessionConfig['selection'];
  instructions: string | null;
};
type Recovered = { binding: Binding; messages: RuntimeMessageReceipt[]; lastSeq: number };
type OpenedPiSession = { manager: SessionManager; binding: Binding; messages: RuntimeMessageReceipt[]; lastSeq: number; hasHistory: boolean };

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function validSelection(value: unknown): value is RuntimeSessionConfig['selection'] {
  if (!object(value) || !keys(value, ['providerId', 'accountId', 'modelId', 'thinkingLevel'])) return false;
  return nonempty(value.providerId) && nonempty(value.accountId) && nonempty(value.modelId)
    && (value.thinkingLevel === undefined || nonempty(value.thinkingLevel));
}
function sameSelection(a: RuntimeSessionConfig['selection'], b: RuntimeSessionConfig['selection']): boolean {
  return a.providerId === b.providerId && a.accountId === b.accountId && a.modelId === b.modelId
    && (a.thinkingLevel ?? null) === (b.thinkingLevel ?? null);
}
function validBinding(value: unknown): value is Binding {
  if (!object(value) || !keys(value, ['schemaVersion', 'kind', 'appSessionId', 'runtimeSessionId', 'projectId', 'agentId', 'selection', 'instructions'])) return false;
  return value.schemaVersion === 1 && value.kind === 'session' && nonempty(value.appSessionId)
    && nonempty(value.runtimeSessionId) && nonempty(value.projectId) && nonempty(value.agentId)
    && validSelection(value.selection) && (value.instructions === null || typeof value.instructions === 'string');
}
function bindingFor(manager: SessionManager, config: RuntimeSessionConfig): Binding {
  const binding: Binding = {
    schemaVersion: 1, kind: 'session', appSessionId: config.id, runtimeSessionId: manager.getSessionId(),
    projectId: config.projectId, agentId: config.agentId, selection: structuredClone(config.selection),
    instructions: config.instructions ?? null,
  };
  manager.appendCustomEntry(customType, binding);
  return binding;
}
function readRecovered(manager: SessionManager, config: RuntimeResumeConfig): Recovered {
  const starts = new Map<string, { inputHash: string; seqLimit: number }>();
  const results = new Map<string, { inputHash: string; outcome: (typeof outcomes)[number]; seq: number }>();
  let binding: Binding | undefined;
  let lastSeq = 0;
  for (const entry of manager.getEntries()) {
    if (entry.type !== 'custom' || entry.customType !== customType) continue;
    const data: unknown = entry.data;
    if (!object(data) || data.schemaVersion !== 1) throw new WorkerFailure('invalid');
    if (data.kind === 'session') {
      if (binding || !validBinding(data) || starts.size > 0) throw new WorkerFailure('invalid');
      binding = data;
      continue;
    }
    if (data.kind === 'message-start') {
      if (!keys(data, ['schemaVersion', 'kind', 'messageId', 'inputHash', 'seqLimit']) || !nonempty(data.messageId)
        || data.messageId.length > 256 || typeof data.inputHash !== 'string' || !digest.test(data.inputHash)
        || !Number.isSafeInteger(data.seqLimit) || (data.seqLimit as number) < 1
        || !binding || starts.has(data.messageId)) throw new WorkerFailure('invalid');
      starts.set(data.messageId, { inputHash: data.inputHash, seqLimit: data.seqLimit as number });
      continue;
    }
    if (data.kind === 'message-sequence-reserve') {
      if (!keys(data, ['schemaVersion', 'kind', 'messageId', 'seqLimit']) || !nonempty(data.messageId)
        || !Number.isSafeInteger(data.seqLimit) || (data.seqLimit as number) < 1
        || !starts.has(data.messageId) || (data.seqLimit as number) <= starts.get(data.messageId)!.seqLimit) throw new WorkerFailure('invalid');
      starts.get(data.messageId)!.seqLimit = data.seqLimit as number;
      continue;
    }
    if (data.kind === 'message-result') {
      if (!keys(data, ['schemaVersion', 'kind', 'messageId', 'inputHash', 'outcome', 'seq']) || !nonempty(data.messageId)
        || typeof data.inputHash !== 'string' || !digest.test(data.inputHash)
        || !outcomes.includes(data.outcome as (typeof outcomes)[number]) || !Number.isSafeInteger(data.seq)
        || (data.seq as number) < 1 || !binding || results.has(data.messageId)
        || starts.get(data.messageId)?.inputHash !== data.inputHash
        || (data.seq as number) > starts.get(data.messageId)!.seqLimit) throw new WorkerFailure('invalid');
      const result = { inputHash: data.inputHash, outcome: data.outcome as (typeof outcomes)[number], seq: data.seq as number };
      results.set(data.messageId, result);
      lastSeq = Math.max(lastSeq, result.seq);
      continue;
    }
    throw new WorkerFailure('invalid');
  }
  if (!binding || binding.appSessionId !== config.id || binding.runtimeSessionId !== config.runtimeSessionId
    || binding.projectId !== config.projectId || binding.agentId !== config.agentId
    || !sameSelection(binding.selection, config.selection)) throw new WorkerFailure('invalid');
  const messages = [...starts].map(([messageId, start]): RuntimeMessageReceipt => ({
    messageId, inputHash: start.inputHash, outcome: results.get(messageId)?.outcome ?? 'interrupted',
  }));
  for (const [messageId, start] of starts) if (!results.has(messageId)) lastSeq = Math.max(lastSeq, start.seqLimit);
  return { binding, messages, lastSeq };
}
function resumeResult(manager: SessionManager, config: RuntimeResumeConfig, hasHistory: boolean): OpenedPiSession {
  const recovered = readRecovered(manager, config);
  const header = manager.getHeader();
  if (!header || header.id !== config.runtimeSessionId || header.version !== CURRENT_SESSION_VERSION) throw new WorkerFailure('invalid');
  return { manager, ...recovered, hasHistory };
}

async function findSessionFile(directory: string, sessionId: string): Promise<{ file: string; raw: string } | undefined> {
  if (!safeSessionId.test(sessionId)) throw new WorkerFailure('invalid');
  const sessionsDir = path.join(directory, 'sessions');
  let root: string, realDirectory: string;
  try {
    root = await realpath(directory);
    realDirectory = await realpath(sessionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new WorkerFailure('runtime-failed');
  }
  const relative = path.relative(root, realDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new WorkerFailure('invalid');
  try {
    const directoryInfo = await lstat(sessionsDir);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new WorkerFailure('invalid');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error instanceof WorkerFailure ? error : new WorkerFailure('runtime-failed');
  }
  let candidates;
  try { candidates = await readdir(realDirectory, { withFileTypes: true }); }
  catch { throw new WorkerFailure('runtime-failed'); }
  const suffix = `_${sessionId}.jsonl`;
  // Pi 1.4.0 filenames end with the opaque session ID. Never scan or read
  // unrelated transcripts just to resolve one indexed reference.
  const matches = candidates.filter(candidate => candidate.name.endsWith(suffix));
  if (!matches.length) return undefined;
  if (matches.length !== 1 || matches[0].isSymbolicLink() || !matches[0].isFile()) throw new WorkerFailure('invalid');
  const file = path.join(realDirectory, matches[0].name);
  let raw: string;
  try { raw = await readFile(file, 'utf8'); } catch { throw new WorkerFailure('runtime-failed'); }
  let header: unknown;
  try { header = JSON.parse(raw.split(/\r?\n/, 1)[0]); } catch { throw new WorkerFailure('invalid'); }
  if (!object(header) || header.type !== 'session' || header.id !== sessionId) throw new WorkerFailure('invalid');
  return { file, raw };
}

function validateFile(raw: string, config: RuntimeResumeConfig, cwd: string): void {
  if (!raw || !raw.endsWith('\n')) throw new WorkerFailure('invalid');
  const lines = raw.slice(0, -1).split(/\r?\n/);
  const entries: unknown[] = [];
  try { for (const line of lines) { if (!line) throw new Error(); entries.push(JSON.parse(line)); } }
  catch { throw new WorkerFailure('invalid'); }
  const header = entries[0];
  if (!object(header) || header.type !== 'session' || header.version !== CURRENT_SESSION_VERSION
    || header.id !== config.runtimeSessionId || typeof header.cwd !== 'string' || path.resolve(header.cwd) !== cwd
    || entries.slice(1).some(entry => !object(entry) || entry.type === 'session')) throw new WorkerFailure('invalid');
}

export async function createPiSession(directory: string, config: RuntimeSessionConfig): Promise<SessionManager> {
  try {
    const cwd = await realpath(config.cwd);
    const sessionsDir = path.join(directory, 'sessions');
    const manager = SessionManager.create(cwd, sessionsDir);
    bindingFor(manager, config);
    return manager;
  } catch (error) { throw error instanceof WorkerFailure ? error : new WorkerFailure('runtime-failed'); }
}

export async function resumePiSession(directory: string, config: RuntimeResumeConfig): Promise<OpenedPiSession> {
  try {
    const cwd = await realpath(config.cwd);
    const found = await findSessionFile(directory, config.runtimeSessionId);
    if (!found) {
      if (!config.allowEmpty) throw new WorkerFailure('resume-required');
      const manager = SessionManager.create(cwd, path.join(directory, 'sessions'), { id: config.runtimeSessionId });
      const runtimeConfig: RuntimeSessionConfig = { ...config, instructions: config.instructions };
      const binding = bindingFor(manager, runtimeConfig);
      return { manager, binding, messages: [], lastSeq: 0, hasHistory: false };
    }
    validateFile(found.raw, config, cwd);
    const manager = SessionManager.open(found.file, path.join(directory, 'sessions'), cwd);
    if (manager.getEntryCount() !== found.raw.slice(0, -1).split(/\r?\n/).length - 1) throw new WorkerFailure('invalid');
    const opened = resumeResult(manager, config, true);
    if (typeof opened.binding.instructions !== 'string' && opened.binding.instructions !== null) throw new WorkerFailure('invalid');
    return opened;
  } catch (error) { throw error instanceof WorkerFailure ? error : new WorkerFailure('runtime-failed'); }
}

export function appendMessageStart(manager: SessionManager, messageId: string, inputHash: string, seqLimit: number): void {
  manager.appendCustomEntry(customType, { schemaVersion: 1, kind: 'message-start', messageId, inputHash, seqLimit });
}
export function appendSequenceReservation(manager: SessionManager, messageId: string, seqLimit: number): void {
  manager.appendCustomEntry(customType, { schemaVersion: 1, kind: 'message-sequence-reserve', messageId, seqLimit });
}
export function appendMessageResult(manager: SessionManager, receipt: RuntimeMessageReceipt, seq: number): void {
  if (!outcomes.includes(receipt.outcome as (typeof outcomes)[number])) throw new WorkerFailure('invalid');
  manager.appendCustomEntry(customType, { schemaVersion: 1, kind: 'message-result', ...receipt, seq });
}
