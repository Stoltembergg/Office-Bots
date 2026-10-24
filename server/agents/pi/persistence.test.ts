import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_SESSION_VERSION } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RuntimeSessionConfig } from '../runtime';
import {
  appendMessageResult,
  appendMessageStart,
  appendSequenceReservation,
  createPiSession,
  resumePiSession,
} from './persistence';

let root: string;
let directory: string;
let cwd: string;
const selection = { providerId: 'synthetic-provider', accountId: 'synthetic-account', modelId: 'synthetic-model', thinkingLevel: 'off' };
const inputHash = 'a'.repeat(64);

type ResumeConfig = {
  id: string;
  runtimeSessionId: string;
  projectId: string;
  agentId: string;
  cwd: string;
  selection: RuntimeSessionConfig['selection'];
  instructions?: string;
  allowEmpty: boolean;
};

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'office-pi-persistence-'));
  directory = path.join(root, 'app-data');
  cwd = path.join(root, 'project');
  await Promise.all([mkdir(directory, { recursive: true }), mkdir(cwd, { recursive: true })]);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function createConfig(overrides: Partial<RuntimeSessionConfig> = {}): RuntimeSessionConfig {
  return {
    id: 'app-session',
    projectId: 'project-1',
    agentId: 'agent-1',
    cwd,
    selection: { ...selection },
    instructions: 'Use only the synthetic fixture.',
    ...overrides,
  };
}
function resumeConfig(runtimeSessionId: string, overrides: Partial<ResumeConfig> = {}): ResumeConfig {
  return {
    ...createConfig(),
    runtimeSessionId,
    allowEmpty: false,
    ...overrides,
  };
}
function bindingFor(config: ResumeConfig) {
  return {
    schemaVersion: 1,
    kind: 'session',
    appSessionId: config.id,
    runtimeSessionId: config.runtimeSessionId,
    projectId: config.projectId,
    agentId: config.agentId,
    selection: config.selection,
    instructions: config.instructions ?? null,
  };
}
function customEntry(data: unknown, id: string, parentId: string | null = null) {
  return { type: 'custom', customType: 'office-bots', data, id, parentId, timestamp: '2026-01-01T00:00:00.000Z' };
}
async function writeTranscript(
  config: ResumeConfig,
  data: unknown[] = [bindingFor(config)],
  options: { raw?: string; header?: Record<string, unknown>; filePrefix?: string } = {},
): Promise<string> {
  const sessionsDir = path.join(directory, 'sessions');
  await mkdir(sessionsDir, { recursive: true });
  const header = {
    type: 'session',
    version: CURRENT_SESSION_VERSION,
    id: config.runtimeSessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: await realpath(config.cwd),
    ...options.header,
  };
  const entries = data.map((item, index) => customEntry(item, `entry-${index + 1}`, index ? `entry-${index}` : null));
  const raw = options.raw ?? `${[header, ...entries].map(entry => JSON.stringify(entry)).join('\n')}\n`;
  const file = path.join(sessionsDir, `${options.filePrefix ?? '2026-01-01T00-00-00-000Z'}_${config.runtimeSessionId}.jsonl`);
  await writeFile(file, raw, 'utf8');
  return file;
}
async function readJsonl(file: string): Promise<unknown[]> {
  return (await readFile(file, 'utf8')).trimEnd().split(/\r?\n/).map(line => JSON.parse(line));
}
type SyntheticPrompt = {
  messageId: string;
  seqLimit: number;
  reservation?: number;
  result?: { outcome: 'completed' | 'cancelled' | 'error'; seq: number };
};
async function addSyntheticPrompt(manager: Awaited<ReturnType<typeof createPiSession>>, options: SyntheticPrompt): Promise<string> {
  const content = `Synthetic prompt ${options.messageId}, never sent to a provider.`;
  const hash = createHash('sha256').update(content).digest('hex');
  manager.appendMessage({ role: 'user', content, timestamp: Date.now() });
  appendMessageStart(manager, options.messageId, hash, options.seqLimit);
  if (options.reservation !== undefined) appendSequenceReservation(manager, options.messageId, options.reservation);
  if (options.result) appendMessageResult(manager, { messageId: options.messageId, inputHash: hash, outcome: options.result.outcome }, options.result.seq);
  return hash;
}

describe('persistência Pi com SessionManager real', () => {
  it('cria a sessão e reabre o transcript SDK preservando o vínculo e a seleção', async () => {
    const config = createConfig();
    const manager = await createPiSession(directory, config);
    expect(manager.getEntryCount()).toBe(1);
    expect(manager.getEntries()[0]).toMatchObject({
      type: 'custom',
      customType: 'office-bots',
      data: {
        schemaVersion: 1,
        kind: 'session',
        appSessionId: config.id,
        runtimeSessionId: manager.getSessionId(),
        projectId: config.projectId,
        agentId: config.agentId,
        selection: config.selection,
        instructions: config.instructions,
      },
    });

    const promptHash = await addSyntheticPrompt(manager, {
      messageId: 'history-message', seqLimit: 1, result: { outcome: 'completed', seq: 1 },
    });
    const file = manager.getSessionFile();
    expect(file).toBeTruthy();
    const lines = await readJsonl(file!);
    expect(lines[0]).toMatchObject({ type: 'session', id: manager.getSessionId(), cwd: await realpath(cwd) });
    expect(lines.slice(1)).toHaveLength(4);

    const opened = await resumePiSession(directory, resumeConfig(manager.getSessionId()));
    expect(opened.hasHistory).toBe(true);
    expect(opened.manager.getSessionId()).toBe(manager.getSessionId());
    expect(opened.binding).toMatchObject({ appSessionId: config.id, selection: config.selection, instructions: config.instructions });
    expect(opened.messages).toEqual([{ messageId: 'history-message', inputHash: promptHash, outcome: 'completed' }]);
    expect(opened.lastSeq).toBe(1);
  });

  it('retoma sem confundir entradas padrão de modelo e raciocínio do SDK com o ledger', async () => {
    const manager = await createPiSession(directory, createConfig());
    manager.appendModelChange('synthetic-provider', 'synthetic-model');
    manager.appendThinkingLevelChange('off');
    const promptHash = await addSyntheticPrompt(manager, {
      messageId: 'model-history', seqLimit: 1, result: { outcome: 'completed', seq: 1 },
    });
    expect(manager.getEntries().map(entry => entry.type)).toContain('model_change');
    expect(manager.getEntries().map(entry => entry.type)).toContain('thinking_level_change');

    const opened = await resumePiSession(directory, resumeConfig(manager.getSessionId()));
    expect(opened.hasHistory).toBe(true);
    expect(opened.messages).toEqual([{ messageId: 'model-history', inputHash: promptHash, outcome: 'completed' }]);
    expect(opened.lastSeq).toBe(1);
  });

  it('exige transcript por padrão e cria sessão vazia somente quando allowEmpty é explícito', async () => {
    await expect(resumePiSession(directory, resumeConfig('resume-required-id')))
      .rejects.toMatchObject({ code: 'resume-required' });

    const opened = await resumePiSession(directory, resumeConfig('new-empty-id', { allowEmpty: true }));
    expect(opened.hasHistory).toBe(false);
    expect(opened.manager.getSessionId()).toBe('new-empty-id');
    expect(opened.messages).toEqual([]);
    expect(opened.lastSeq).toBe(0);
    expect(opened.binding).toMatchObject({ appSessionId: 'app-session', runtimeSessionId: 'new-empty-id' });
  });

  it('bloqueia retomada se o transcript contém mensagem Pi sem marcador durável do app', async () => {
    const config = createConfig();
    const manager = await createPiSession(directory, config);
    manager.appendMessage({ role: 'user', content: 'Untracked Pi input, never sent to a provider.', timestamp: Date.now() });

    await expect(resumePiSession(directory, resumeConfig(manager.getSessionId())))
      .rejects.toMatchObject({ code: 'resume-required' });
  });

  it('persiste recibos, reservas crescentes e ignora custom entries de outras extensões ao reabrir', async () => {
    const manager = await createPiSession(directory, createConfig());
    const doneHash = await addSyntheticPrompt(manager, {
      messageId: 'done', seqLimit: 2, reservation: 4, result: { outcome: 'completed', seq: 3 },
    });
    const cancelledHash = await addSyntheticPrompt(manager, {
      messageId: 'cancelled', seqLimit: 7, result: { outcome: 'cancelled', seq: 6 },
    });
    const errorHash = await addSyntheticPrompt(manager, {
      messageId: 'errored', seqLimit: 9, result: { outcome: 'error', seq: 9 },
    });
    manager.appendCustomEntry('unrelated-extension', { schemaVersion: 999, arbitrary: true });

    const file = manager.getSessionFile()!;
    const lines = await readJsonl(file);
    expect(lines.some(entry => typeof entry === 'object' && entry !== null && 'data' in entry
      && (entry as { data?: { kind?: string } }).data?.kind === 'message-sequence-reserve')).toBe(true);

    const opened = await resumePiSession(directory, resumeConfig(manager.getSessionId()));
    expect(opened.messages).toEqual([
      { messageId: 'done', inputHash: doneHash, outcome: 'completed' },
      { messageId: 'cancelled', inputHash: cancelledHash, outcome: 'cancelled' },
      { messageId: 'errored', inputHash: errorHash, outcome: 'error' },
    ]);
    expect(opened.lastSeq).toBe(9);
  });

  it('recupera início sem resultado como interrupted e conserva a maior sequência reservada', async () => {
    const manager = await createPiSession(directory, createConfig());
    const firstHash = await addSyntheticPrompt(manager, { messageId: 'interrupted-1', seqLimit: 1, reservation: 5 });
    const secondHash = await addSyntheticPrompt(manager, { messageId: 'interrupted-2', seqLimit: 8 });

    const opened = await resumePiSession(directory, resumeConfig(manager.getSessionId()));
    expect(opened.messages).toEqual([
      { messageId: 'interrupted-1', inputHash: firstHash, outcome: 'interrupted' },
      { messageId: 'interrupted-2', inputHash: secondHash, outcome: 'interrupted' },
    ]);
    expect(opened.lastSeq).toBe(8);
  });

  it.each([
    ['application session id', { id: 'different-app-session' }],
    ['project id', { projectId: 'different-project' }],
    ['agent id', { agentId: 'different-agent' }],
    ['model selection', { selection: { ...selection, modelId: 'different-model' } }],
  ])('recusa retomar transcript vinculado a outro %s', async (_field, override) => {
    const config = resumeConfig('bound-runtime-id');
    await writeTranscript(config);
    await expect(resumePiSession(directory, resumeConfig('bound-runtime-id', override)))
      .rejects.toMatchObject({ code: 'invalid' });
  });

  it.each([
    ['file sem newline final', (header: Record<string, unknown>) => JSON.stringify(header)],
    ['JSON truncado', (header: Record<string, unknown>) => `${JSON.stringify(header)}\n{"type":"custom"\n`],
    ['header malformado', () => '{not-json}\n'],
  ])('recusa %s sem alterar o arquivo', async (_label, rawFor) => {
    const config = resumeConfig('malformed-runtime-id');
    const header = {
      type: 'session', version: CURRENT_SESSION_VERSION, id: config.runtimeSessionId,
      timestamp: '2026-01-01T00:00:00.000Z', cwd: path.resolve(cwd),
    };
    const raw = rawFor(header);
    const file = await writeTranscript(config, [], { raw });
    await expect(resumePiSession(directory, config)).rejects.toMatchObject({ code: 'invalid' });
    expect(await readFile(file, 'utf8')).toBe(raw);
  });

  it.each([
    ['SDK session version', { version: CURRENT_SESSION_VERSION - 1 }],
    ['working directory', { cwd: '/deliberately-different-cwd' }],
  ])('recusa transcript com %s divergente', async (_label, header) => {
    const config = resumeConfig('header-mismatch-id');
    await writeTranscript(config, [bindingFor(config)], { header });
    await expect(resumePiSession(directory, config)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('recusa binding ausente, extra e resultado sem início correspondente', async () => {
    const config = resumeConfig('invalid-ledger-id');
    const invalidData = [
      [],
      [{ ...bindingFor(config), unexpected: true }],
      [bindingFor(config), {
        schemaVersion: 1, kind: 'message-result', messageId: 'orphan', inputHash,
        outcome: 'completed', seq: 1,
      }],
    ];
    for (const entries of invalidData) {
      await rm(path.join(directory, 'sessions'), { recursive: true, force: true });
      await writeTranscript(config, entries);
      await expect(resumePiSession(directory, config)).rejects.toMatchObject({ code: 'invalid' });
    }
  });

  it.each([
    ['hash de início inválido', 'bad-start-hash'],
    ['início duplicado', 'duplicate-start'],
    ['reserva sem início', 'orphan-reservation'],
    ['reserva não crescente', 'non-increasing-reservation'],
    ['hash de resultado divergente', 'mismatched-result-hash'],
    ['resultado além da reserva', 'result-over-limit'],
    ['resultado duplicado', 'duplicate-result'],
    ['outcome não terminal', 'invalid-result-outcome'],
    ['sequência não inteira', 'non-integer-result-sequence'],
    ['kind desconhecido', 'unknown-kind'],
    ['binding depois do início', 'late-binding'],
    ['binding duplicado', 'duplicate-binding'],
  ])('recusa ledger com %s', async (_label, caseName) => {
    const config = resumeConfig('invalid-ledger-case-id');
    const binding = bindingFor(config);
    const start = { schemaVersion: 1, kind: 'message-start', messageId: 'm', inputHash, seqLimit: 2 };
    const result = { schemaVersion: 1, kind: 'message-result', messageId: 'm', inputHash, outcome: 'completed', seq: 2 };
    const entriesByCase: Record<string, unknown[]> = {
      'bad-start-hash': [binding, { ...start, inputHash: 'not-a-sha256' }],
      'duplicate-start': [binding, start, start],
      'orphan-reservation': [binding, { schemaVersion: 1, kind: 'message-sequence-reserve', messageId: 'm', seqLimit: 3 }],
      'non-increasing-reservation': [binding, start, { schemaVersion: 1, kind: 'message-sequence-reserve', messageId: 'm', seqLimit: 2 }],
      'mismatched-result-hash': [binding, start, { ...result, inputHash: 'b'.repeat(64) }],
      'result-over-limit': [binding, start, { ...result, seq: 3 }],
      'duplicate-result': [binding, start, result, result],
      'invalid-result-outcome': [binding, start, { ...result, outcome: 'interrupted' }],
      'non-integer-result-sequence': [binding, start, { ...result, seq: 1.5 }],
      'unknown-kind': [binding, { schemaVersion: 1, kind: 'unknown-ledger-kind' }],
      'late-binding': [start, binding],
      'duplicate-binding': [binding, binding],
    };
    await writeTranscript(config, entriesByCase[caseName]);
    await expect(resumePiSession(directory, config)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('recusa ids de runtime inseguros e diretórios de sessões que escapam do diretório raiz', async () => {
    await expect(resumePiSession(directory, resumeConfig('../outside')))
      .rejects.toMatchObject({ code: 'invalid' });

    const sessionsDir = path.join(directory, 'sessions');
    const outside = path.join(root, 'outside-sessions');
    await mkdir(outside, { recursive: true });
    await symlink(outside, sessionsDir, 'dir');
    await expect(resumePiSession(directory, resumeConfig('safe-runtime-id')))
      .rejects.toMatchObject({ code: 'invalid' });
  });

  it('recusa symlink de transcript e múltiplos arquivos para o mesmo id', async () => {
    const config = resumeConfig('ambiguous-runtime-id');
    const file = await writeTranscript(config);
    await writeFile(path.join(root, 'outside.jsonl'), await readFile(file, 'utf8'));
    await rm(file);
    await symlink(path.join(root, 'outside.jsonl'), file);
    await expect(resumePiSession(directory, config)).rejects.toMatchObject({ code: 'invalid' });

    await rm(file);
    await writeTranscript(config);
    await writeTranscript(config, [bindingFor(config)], { filePrefix: '2026-01-02T00-00-00-000Z' });
    expect((await readdir(path.join(directory, 'sessions'))).filter(name => name.endsWith(`_${config.runtimeSessionId}.jsonl`))).toHaveLength(2);
    await expect(resumePiSession(directory, config)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejeita outcome não terminal antes de anexar recibo ao SessionManager', async () => {
    const manager = await createPiSession(directory, createConfig());
    expect(() => appendMessageResult(manager, { messageId: 'pending', inputHash, outcome: 'interrupted' }, 1))
      .toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(manager.getEntries().map(entry => entry.type === 'custom' ? entry.data : undefined))
      .not.toContainEqual(expect.objectContaining({ kind: 'message-result', messageId: 'pending' }));
  });
});
