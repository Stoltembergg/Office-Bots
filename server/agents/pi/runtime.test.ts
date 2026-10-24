import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import electronPath from 'electron';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PiRuntime } from './runtime';
import { createPiSession } from './persistence';
import { isAgentEvent } from '../../../shared/agents/validation';
import type { AgentEvent } from '../../../shared/agents/contracts';
import type { RuntimeSessionConfig } from '../runtime';

const compiled = path.resolve('.superpowers/pi-worker-test');
let root: string, runtime: PiRuntime, events: AgentEvent[];
const entry = path.join(compiled, 'fixture.mjs');
beforeAll(async () => {
  await mkdir(compiled, { recursive: true });
  await writeFile(path.join(compiled, 'malformed.mjs'), `
    let mode; process.send({version:1,type:'ready'});
    process.on('message', m => {
      if(m.type === 'create') { mode=m.config.selection.modelId; process.send({version:1,id:m.id,ok:true,result:{runtimeSessionId:'sdk'}}); }
      if(m.type === 'prompt' && mode === 'disconnect') { process.disconnect(); setInterval(() => {},1000); return; }
      if(m.type === 'prompt') process.send({version:1,event:{schemaVersion:999,private:'must not reach listeners'}});
    });
  `);
  await Promise.all([
    build({ entryPoints: ['server/agents/pi/test-worker.fixture.ts'], outfile: entry, bundle: true, platform: 'node', format: 'esm', packages: 'external' }),
    build({ entryPoints: ['server/agents/pi/worker.ts'], outfile: path.join(compiled, 'worker.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external' }),
  ]);
});
afterAll(async () => { await rm(compiled, { recursive: true, force: true }); });
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'office-pi-worker-')); events = [];
  runtime = new PiRuntime({ entry, directory: path.join(root, 'sdk') });
  runtime.subscribe(event => events.push(event));
});
afterEach(async () => { await runtime.stop(); await rm(root, { recursive: true, force: true }); });
function config(id = 'app-session', modelId = 'normal'): RuntimeSessionConfig {
  return { id, projectId: 'project', agentId: 'agent', cwd: root, selection: { providerId: 'test', accountId: 'chosen-account', modelId, thinkingLevel: 'off' } };
}
const input = { messageId: 'message', text: 'Olá' };
const workerOperationTimeoutMs = 30_000;
const workerEventTimeoutMs = 15_000;
type PromptOutcome = { state: 'pending' } | { state: 'resolved' } | { state: 'rejected'; code?: string };
function observePrompt(promise: Promise<void>) {
  let outcome: PromptOutcome = { state: 'pending' };
  const settled = promise.then(
    () => { outcome = { state: 'resolved' }; },
    error => {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code : undefined;
      outcome = code === undefined ? { state: 'rejected' } : { state: 'rejected', code };
    },
  );
  return { settled, outcome: () => outcome };
}

describe('Pi isolado com SDK real e provedor falso', () => {
  it('cria sem inferência; transmite texto e uso com correlação e ordem', async () => {
    const s = await runtime.create(config()); expect(events).toEqual([]);
    await runtime.prompt(s.runtimeSessionId, input);
    expect(events.every(isAgentEvent)).toBe(true);
    expect(events.every(e => e.sessionId === 'app-session' && e.origin === 'managed-pi')).toBe(true);
    expect(new Set(events.map(e => e.runId)).size).toBe(1);
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.filter(e => e.type === 'text-delta').map(e => e.payload.text).join('')).toBe('Resposta do teste.');
    expect(events.filter(e => e.type === 'message-end')).toHaveLength(1);
    expect(events.some(e => e.type === 'usage')).toBe(true);
    await runtime.close(s.runtimeSessionId);
  });
  it('separa execuções e continua a sequência da mesma conversa', async () => {
    const s = await runtime.create(config()); await runtime.prompt(s.runtimeSessionId, input);
    await runtime.prompt(s.runtimeSessionId, { ...input, messageId: 'message-2' });
    expect(new Set(events.map(e => e.runId)).size).toBe(2);
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i + 1));
  });
  it('rejeita retry concluído sem matar o worker compartilhado', async () => {
    const completed = await runtime.create(config('completed-session'));
    const other = await runtime.create(config('other-session'));
    await runtime.prompt(completed.runtimeSessionId, input);
    const beforeRetry = events.length;

    const duplicateResult = await runtime.prompt(completed.runtimeSessionId, input).then(
      () => 'resolved', error => (error as { code?: string }).code ?? 'unknown');
    const duplicateEvents = events.slice(beforeRetry).filter(e => e.sessionId === 'completed-session').map(e => e.type);
    const otherResult = await runtime.prompt(other.runtimeSessionId, { messageId: 'other-message', text: 'Outra conversa' }).then(
      () => 'resolved', error => (error as { code?: string }).code ?? 'unknown');
    const otherOutcomes = events.filter(e => e.sessionId === 'other-session' && e.type === 'message-end')
      .map(e => e.type === 'message-end' ? e.payload.outcome : '');

    expect({ duplicateResult, duplicateEvents, otherResult, otherOutcomes }).toEqual({
      duplicateResult: 'invalid', duplicateEvents: [], otherResult: 'resolved', otherOutcomes: ['completed'],
    });
  });
  it('retoma um transcript em novo worker sem replay e continua a sequência persistida', async () => {
    const directory = path.join(root, 'sdk');
    const created = await runtime.create(config());
    await runtime.prompt(created.runtimeSessionId, input);
    const previousLastSeq = events.at(-1)!.seq;
    await runtime.stop();
    events = [];
    runtime = new PiRuntime({ entry, directory });
    runtime.subscribe(event => events.push(event));

    const resumed = await runtime.resume({ ...config(), runtimeSessionId: created.runtimeSessionId });

    expect(resumed.runtimeSessionId).toBe(created.runtimeSessionId);
    expect(resumed.lastSeq).toBe(previousLastSeq);
    expect(resumed.messages).toEqual([{ messageId: input.messageId,
      inputHash: createHash('sha256').update(input.text).digest('hex'), outcome: 'completed' }]);
    expect(events).toEqual([]);
    await runtime.prompt(created.runtimeSessionId, { messageId: 'next-message', text: 'Continue' });
    expect(events[0].type).toBe('message-start');
    expect(events[0].sessionId).toBe('app-session');
    expect(events[0].seq).toBe(resumed.lastSeq + 1);
    expect(events.filter(e => e.type === 'message-start')).toHaveLength(1);
  }, workerOperationTimeoutMs);
  it('bloqueia retomada quando há mensagem user persistida sem marcador app durável', async () => {
    const directory = path.join(root, 'sdk');
    const manager = await createPiSession(directory, config());
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: input.text }], timestamp: Date.now() });

    await expect(runtime.resume({ ...config(), runtimeSessionId: manager.getSessionId() }))
      .rejects.toMatchObject({ code: 'resume-required' });
    expect(events).toEqual([]);
  });
  it('cancelamento aguarda término real e produz um único terminal', async () => {
    const s = await runtime.create(config('slow-session', 'slow'));
    const observed = observePrompt(runtime.prompt(s.runtimeSessionId, input));
    await expect.poll(() => events.some(e => e.type === 'text-delta') || observed.outcome().state !== 'pending',
      { timeout: workerEventTimeoutMs }).toBe(true);
    expect(observed.outcome()).toEqual({ state: 'pending' });
    await runtime.cancel(s.runtimeSessionId); await observed.settled;
    expect(observed.outcome()).toEqual({ state: 'rejected', code: 'cancelled' });
    expect(events.filter(e => e.type === 'message-end').map(e => e.payload.outcome)).toEqual(['cancelled']);
  }, workerOperationTimeoutMs);
  it('não carrega extensões/contexto do projeto nem executa ferramentas', async () => {
    const dir = path.join(root, '.pi', 'extensions'); await mkdir(dir, { recursive: true });
    const marker = path.join(root, 'extension-ran');
    await writeFile(path.join(dir, 'evil.ts'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export default () => {};`);
    await writeFile(path.join(root, 'AGENTS.md'), 'UNTRUSTED_CONTEXT_MARKER');
    await writeFile(path.join(root, '.pi', 'APPEND_SYSTEM.md'), 'UNTRUSTED_CONTEXT_MARKER');
    const instructionsFile = path.join(root, 'instructions.txt');
    await writeFile(instructionsFile, 'UNTRUSTED_CONTEXT_MARKER');
    const s = await runtime.create({ ...config('tools-session', 'tool'), instructions: instructionsFile }); await runtime.prompt(s.runtimeSessionId, input);
    expect(await readdir(root)).not.toContain('extension-ran');
    expect(await readdir(root)).not.toContain('tool-ran');
    expect(events.some(e => e.type === 'text-delta')).toBe(true);
  });
  it('modelo e raciocínio indisponíveis são recusados sem fallback', async () => {
    await expect(runtime.create(config('missing', 'missing'))).rejects.toMatchObject({ code: 'unavailable' });
    const invalid = config(); invalid.selection.thinkingLevel = 'high';
    await expect(runtime.create(invalid)).rejects.toMatchObject({ code: 'unavailable' });
    expect(events).toEqual([]);
  });
  it('falha do worker rejeita prompt pendente e não reinicia nem repete', async () => {
    const s = await runtime.create(config('crash-session', 'crash'));
    await expect(runtime.prompt(s.runtimeSessionId, input)).rejects.toMatchObject({ code: 'runtime-failed' });
    await expect(runtime.create(config('new-session'))).rejects.toMatchObject({ code: 'runtime-failed' });
    expect(events.filter(e => e.type === 'message-start')).toHaveLength(1);
    expect(events.filter(e => e.type === 'message-end').map(e => e.payload.outcome)).toEqual(['error']);
  });
  it('erro bruto do SDK não atravessa o processo e terminal não informa sucesso', async () => {
    const s = await runtime.create(config('error-session', 'error'));
    await expect(runtime.prompt(s.runtimeSessionId, input)).rejects.toMatchObject({ code: 'runtime-failed' });
    expect(JSON.stringify(events)).not.toContain('PRIVATE_API_KEY');
    expect(events.filter(e => e.type === 'message-end').map(e => e.payload.outcome)).toEqual(['error']);
  });
  it('não aceita turno simultâneo no mesmo handle nem payload malformado', async () => {
    const s = await runtime.create(config('slow-session', 'slow'));
    const observed = observePrompt(runtime.prompt(s.runtimeSessionId, input));
    await expect.poll(() => events.some(e => e.type === 'text-delta') || observed.outcome().state !== 'pending',
      { timeout: workerEventTimeoutMs }).toBe(true);
    expect(observed.outcome()).toEqual({ state: 'pending' });
    await expect(runtime.prompt(s.runtimeSessionId, { ...input, messageId: 'another' })).rejects.toMatchObject({ code: 'busy' });
    await expect(runtime.create({ ...config(), extra: 'bad' } as RuntimeSessionConfig)).rejects.toMatchObject({ code: 'invalid' });
    await runtime.cancel(s.runtimeSessionId); await observed.settled;
    expect(observed.outcome()).toEqual({ state: 'rejected', code: 'cancelled' });
  }, workerOperationTimeoutMs);
  it('mensagem inválida do worker encerra processo e não vaza dados brutos', async () => {
    await runtime.stop();
    runtime = new PiRuntime({ entry: path.join(compiled, 'malformed.mjs'), directory: root });
    runtime.subscribe(e => events.push(e));
    const s = await runtime.create(config());
    await expect(runtime.prompt(s.runtimeSessionId, input)).rejects.toMatchObject({ code: 'runtime-failed' });
    expect(JSON.stringify(events)).not.toContain('must not reach listeners');
    expect(events.filter(e => e.type === 'message-end')).toHaveLength(1);
  });
  it('perda de IPC encerra worker ainda vivo antes de liquidar o turno', async () => {
    await runtime.stop();
    runtime = new PiRuntime({ entry: path.join(compiled, 'malformed.mjs'), directory: root });
    runtime.subscribe(e => events.push(e));
    const s = await runtime.create(config('disconnect-session', 'disconnect'));
    let settled = false;
    const result = runtime.prompt(s.runtimeSessionId, input).then(() => 'unexpected-success', e => e.code);
    void result.then(() => { settled = true; });
    await expect.poll(() => settled, { timeout: 2000 }).toBe(true);
    expect(await result).toBe('runtime-failed');
    expect(events.filter(e => e.type === 'message-end')).toHaveLength(1);
  });
  it('close durante streaming aguarda cancelamento e não apaga o histórico SDK', async () => {
    const s = await runtime.create(config('slow-session', 'slow'));
    const observed = observePrompt(runtime.prompt(s.runtimeSessionId, input));
    await expect.poll(() => events.some(e => e.type === 'text-delta') || observed.outcome().state !== 'pending',
      { timeout: workerEventTimeoutMs }).toBe(true);
    expect(observed.outcome()).toEqual({ state: 'pending' });
    await runtime.close(s.runtimeSessionId); await observed.settled;
    expect(observed.outcome()).toEqual({ state: 'rejected', code: 'cancelled' });
    expect((await readdir(path.join(root, 'sdk', 'sessions'))).some(f => f.endsWith('.jsonl'))).toBe(true);
    await expect(runtime.prompt(s.runtimeSessionId, input)).rejects.toMatchObject({ code: 'invalid' });
  }, workerOperationTimeoutMs);
  it('executa o SDK com Node embutido do Electron sem Node externo no filho', async () => {
    await runtime.stop();
    runtime = new PiRuntime({ entry: path.join(compiled, 'worker.mjs'), directory: path.join(root, 'embedded'), execPath: electronPath as unknown as string });
    await runtime.initialize();
    const c = config(); c.selection = { providerId: 'openai', accountId: 'not-authorized', modelId: 'gpt-4.1', thinkingLevel: 'off' };
    const s = await runtime.create(c); await runtime.close(s.runtimeSessionId);
    expect(events).toEqual([]);
  });
  it('worker padrão não usa credencial ambiente nem libera contas antes de M3', async () => {
    await runtime.stop();
    runtime = new PiRuntime({ entry: path.join(compiled, 'worker.mjs'), directory: path.join(root, 'sdk-default') });
    const c = config(); c.selection = { providerId: 'openai', accountId: 'not-authorized', modelId: 'gpt-4.1', thinkingLevel: 'off' };
    const s = await runtime.create(c);
    await expect(runtime.prompt(s.runtimeSessionId, input)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await readdir(root)).not.toContain('auth.json');
  });
});

describe('observação de prompts nos testes', () => {
  it('captura rejeições nullish sem rejeitar a própria Promise observadora', async () => {
    for (const reason of [undefined, null]) {
      const observed = observePrompt(Promise.reject(reason));
      await expect(observed.settled).resolves.toBeUndefined();
      expect(observed.outcome()).toEqual({ state: 'rejected' });
    }
  });
});

describe('contrato público de eventos', () => {
  it('recusa payload, versão e dados extras de SDK/segredo', () => {
    const base = { schemaVersion: 1, origin: 'managed-pi', sessionId: 's', runId: 'r', seq: 1, at: new Date().toISOString(), type: 'text-delta', payload: { text: 'hello' } };
    expect(isAgentEvent(base)).toBe(true);
    for (const change of [{ schemaVersion: 2 }, { seq: 0 }, { at: 'bad' }, { type: 'private-sdk' }, { token: 'secret' }, { payload: { text: 'x', secret: 'bad' } }]) expect(isAgentEvent({ ...base, ...change })).toBe(false);
  });
});
