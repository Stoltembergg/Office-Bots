import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startManagedAgents } from './agents';
import type { ManagedRuntime } from '../server/agents/runtime';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const selection = { providerId: 'p', accountId: 'a', modelId: 'm' };
class Runtime implements ManagedRuntime {
  created: string[] = []; stopped = 0; calls: { resolve: () => void; reject: (e: Error) => void }[] = [];
  failReady = false;
  async initialize() { if (this.failReady) throw new Error('PRIVATE_RUNTIME_ERROR'); }
  async create(config: { id: string }) { this.created.push(config.id); return { runtimeSessionId: config.id }; }
  async resume(config: { runtimeSessionId: string }) { return { runtimeSessionId: config.runtimeSessionId, lastSeq: 0, messages: [] }; }
  async prompt() { return new Promise<void>((resolve, reject) => this.calls.push({ resolve, reject })); }
  async cancel() {}
  async close() {}
  async stop() { this.stopped++; this.calls.forEach(c => c.reject(new Error('stopped'))); }
}
async function setup(runtime = new Runtime()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'office-agents-service-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const service = await startManagedAgents({ directory, workerEntry: path.join(directory, 'app-worker.mjs'), createRuntime: () => runtime, isAvailable: async () => true });
  cleanups.push(() => service.stop());
  return { service, runtime, directory };
}
async function session(service: Awaited<ReturnType<typeof startManagedAgents>>, directory: string) {
  const cwd = path.join(directory, 'project'); await mkdir(cwd, { recursive: true });
  const project = await service.catalog.createProject({ name: 'p', cwd });
  const agent = await service.catalog.createAgent({ projectId: project.id, name: 'a', appearanceSeed: 'avatar', modelPolicy: { mode: 'fixed', selection } });
  return service.manager.create({ agentId: agent.id });
}
describe('serviço de agentes do desktop', () => {
  it('inicia e recupera metadados sem criar sessão ou inferência', async () => {
    const { service, runtime } = await setup(); expect(service.manager.list()).toEqual([]);
    expect(runtime.created).toEqual([]); expect(runtime.calls).toEqual([]);
    await service.stop(); await service.stop(); expect(runtime.stopped).toBe(1);
  });
  it('encerra o processo quando inicialização falha, com erro sanitizado', async () => {
    const runtime = new Runtime(); runtime.failReady = true;
    await expect(startManagedAgents({ directory: os.tmpdir(), workerEntry: '/owned/worker', createRuntime: () => runtime })).rejects.toMatchObject({ code: 'runtime-failed' });
    expect(runtime.stopped).toBe(1);
  });
  it('encerra turnos e persiste conclusão antes de confirmar stop', async () => {
    const { service, runtime, directory } = await setup();
    const s = await session(service, directory); const p = service.manager.prompt(s.id, { messageId: '1', text: 'x' }); const failure = expect(p).rejects.toThrow();
    await expect.poll(() => runtime.calls.length).toBe(1);
    const stop = service.stop();
    await expect(service.manager.prompt(s.id, { messageId: '2', text: 'x' })).rejects.toMatchObject({ code: 'closed' });
    await failure; await stop;
    expect(service.manager.isAgentBusy(s.agentId)).toBe(false);
    const index = JSON.parse(await readFile(path.join(directory, 'sessions.json'), 'utf8'));
    expect(index.sessions[0].state).toBe('error');
    await expect(service.manager.create({ agentId: s.agentId })).rejects.toMatchObject({ code: 'closed' });
  });
  it('cancela fila ao sair sem enviar próximo turno ao runtime', async () => {
    const { service, runtime, directory } = await setup();
    const s = await session(service, directory), other = await service.manager.create({ agentId: s.agentId });
    const p = service.manager.prompt(s.id, { messageId: '1', text: 'x' }); const failed = expect(p).rejects.toThrow();
    await expect.poll(() => runtime.calls.length).toBe(1);
    const q = service.manager.prompt(other.id, { messageId: '2', text: 'x' }); const cancelled = expect(q).rejects.toMatchObject({ code: 'cancelled' });
    await expect.poll(() => service.manager.get(other.id).state).toBe('queued');
    await service.stop(); await failed; await cancelled;
    expect(runtime.calls).toHaveLength(1);
  });
  it('aguarda fechamento já iniciado antes de confirmar saída', async () => {
    const { service, runtime, directory } = await setup();
    const s = await session(service, directory); let release!: () => void, reached!: () => void;
    const entered = new Promise<void>(r => { reached = r; }); const gate = new Promise<void>(r => { release = r; });
    runtime.close = async () => { reached(); await gate; };
    const closing = service.manager.close(s.id); await entered;
    let done = false; const stopping = service.stop().then(() => { done = true; });
    try {
      await new Promise<void>(r => setImmediate(r)); expect(done).toBe(false);
    } finally { release(); await closing; await stopping; }
    expect(JSON.parse(await readFile(path.join(directory, 'sessions.json'), 'utf8')).sessions[0].state).toBe('closed');
  });
  it('reporta falha de persistência na saída somente depois do processo encerrar', async () => {
    const { service, runtime, directory } = await setup();
    // This test asserts its expected stop failure explicitly; don't repeat it in cleanup.
    cleanups.pop();
    const s = await session(service, directory);
    const prompt = service.manager.prompt(s.id, { messageId: '1', text: 'x' });
    const failedPrompt = expect(prompt).rejects.toMatchObject({ code: 'storage' });
    await expect.poll(() => runtime.calls.length).toBe(1);
    let release!: () => void; const exited = new Promise<void>(r => { release = r; });
    runtime.stop = async () => { runtime.stopped++; runtime.calls.forEach(c => c.reject(new Error('stopped'))); await exited; };
    await mkdir(path.join(directory, 'sessions.lock'));
    let settled = false;
    const stopping = service.stop(); void stopping.then(() => { settled = true; }, () => { settled = true; });
    const failedStop = expect(stopping).rejects.toMatchObject({ code: 'storage' });
    try {
      await failedPrompt; expect(settled).toBe(false);
    } finally { release(); await failedStop; }
    expect(runtime.stopped).toBe(1);
    expect(JSON.parse(await readFile(path.join(directory, 'sessions.json'), 'utf8')).sessions[0].state).toBe('running');
    expect(service.manager.get(s.id).state).toBe('interrupted');
  });
  it('não publica criação que ainda aguardava disponibilidade quando stop começou', async () => {
    let release!: () => void, reached!: () => void;
    const entered = new Promise<void>(r => { reached = r; });
    const available = new Promise<boolean>(r => { release = () => r(true); });
    const { runtime, directory } = await setup();
    const service = await startManagedAgents({ directory: path.join(directory, 'second'), workerEntry: '/owned/worker', createRuntime: () => runtime, isAvailable: () => { reached(); return available; } });
    cleanups.push(() => service.stop());
    const creating = session(service, directory); const rejected = expect(creating).rejects.toMatchObject({ code: 'closed' });
    await entered;
    const stop = service.stop(); release(); await rejected; await stop;
    expect(service.manager.list()).toEqual([]);
  });
});
