import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CatalogStore } from './catalog';
import { SessionManager } from './manager';
import { SessionStore } from './sessions';
import type { ManagedRuntime, RuntimeSessionConfig } from './runtime';

class Runtime implements ManagedRuntime {
  created: RuntimeSessionConfig[] = [];
  resumed: (RuntimeSessionConfig & { runtimeSessionId: string })[] = [];
  calls: { id: string; resolve: () => void }[] = [];
  closed: string[] = [];
  cancelled: string[] = [];
  cancelWait?: Promise<void>;
  async create(config: RuntimeSessionConfig) { this.created.push(config); return { runtimeSessionId: config.id }; }
  async resume(config: RuntimeSessionConfig & { runtimeSessionId: string }) {
    this.resumed.push(structuredClone(config));
    return { runtimeSessionId: config.runtimeSessionId, lastSeq: 11, messages: [{
      messageId: 'old-message', inputHash: createHash('sha256').update('texto anterior').digest('hex'), outcome: 'completed' as const,
    }] };
  }
  prompt(id: string) { return new Promise<void>(resolve => this.calls.push({ id, resolve })); }
  async cancel(id: string) { this.cancelled.push(id); await this.cancelWait; }
  async close(id: string) { this.closed.push(id); }
}
let root: string, catalog: CatalogStore, store: SessionStore, runtime: Runtime, manager: SessionManager;
const chosen = { providerId: 'provider', accountId: 'account', modelId: 'chosen' };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'office-durable-manager-'));
  catalog = new CatalogStore(root, id => manager.isAgentBusy(id));
  store = new SessionStore(root, catalog); runtime = new Runtime();
  manager = new SessionManager(catalog, runtime, async () => true, store);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function setup() {
  const cwd = path.join(root, 'project'); await mkdir(cwd, { recursive: true });
  const project = await catalog.createProject({ name: 'Projeto', cwd });
  const agent = await catalog.createAgent({ projectId: project.id, name: 'Agente', appearanceSeed: 'avatar', modelPolicy: { mode: 'fixed', selection: chosen } });
  return manager.create({ agentId: agent.id });
}
const prompt = { messageId: 'message-1', text: 'Faça a tarefa' };
const calls = async (n: number) => expect.poll(() => runtime.calls.length).toBe(n);

describe('persistência coordenada do manager', () => {
  it('só publica criação depois de gravar o índice', async () => {
    const s = await setup(); expect(await store.get(s.id)).toEqual(s);
    expect(runtime.calls).toHaveLength(0);
  });
  it('não publica criação com falha de escrita e fecha o recurso recém-criado', async () => {
    await mkdir(path.join(root, 'sessions.lock'));
    await expect(setup()).rejects.toMatchObject({ code: 'storage' });
    expect(manager.list()).toEqual([]); expect(runtime.calls).toEqual([]);
    // Startup itself is blocked, before any resource is allocated.
    expect(runtime.created).toEqual([]);
  });
  it('falha ao persistir nova conversa limpa runtime sem inferência', async () => {
    await manager.initialize(); await mkdir(path.join(root, 'sessions.lock'));
    await expect(setup()).rejects.toMatchObject({ code: 'storage' });
    expect(manager.list()).toEqual([]); expect(runtime.created).toHaveLength(1);
    expect(runtime.closed).toEqual([runtime.created[0].id]);
  });
  it('grava running antes do prompt e idle antes de concluir a Promise', async () => {
    const s = await setup(); const p = manager.prompt(s.id, prompt); await calls(1);
    expect((await store.get(s.id)).state).toBe('running');
    runtime.calls[0].resolve(); await p;
    expect((await store.get(s.id)).state).toBe('idle');
    expect(await readFile(path.join(root, 'sessions.json'), 'utf8')).not.toContain(prompt.text);
  });
  it('reabre metadados com a seleção original sem criar runtime nem repetir turno', async () => {
    const s = await setup(); await catalog.updateAgent(s.agentId, { modelPolicy: { mode: 'fixed', selection: { ...chosen, modelId: 'new' } } });
    const nextRuntime = new Runtime(); const next = new SessionManager(catalog, nextRuntime, async () => false, new SessionStore(root, catalog));
    await next.initialize();
    expect(next.get(s.id)).toEqual(s); expect(nextRuntime.created).toEqual([]); expect(nextRuntime.calls).toEqual([]);
    await expect(next.prompt(s.id, prompt)).rejects.toMatchObject({ code: 'resume-required' });
  });
  it('retoma apenas por chamada explícita com seleção histórica e impede replay de mensagem confirmada', async () => {
    const s = await setup();
    await catalog.updateAgent(s.agentId, { modelPolicy: { mode: 'fixed', selection: { ...chosen, modelId: 'new' } } });
    const nextRuntime = new Runtime();
    const next = new SessionManager(catalog, nextRuntime, async () => true, new SessionStore(root, catalog));
    await next.initialize();
    expect(nextRuntime.resumed).toEqual([]);
    await expect(next.prompt(s.id, prompt)).rejects.toMatchObject({ code: 'resume-required' });

    await next.resume(s.id);

    expect(nextRuntime.resumed).toHaveLength(1);
    expect(nextRuntime.resumed[0]).toMatchObject({ id: s.id, runtimeSessionId: s.runtimeSessionId,
      projectId: s.projectId, agentId: s.agentId, cwd: path.join(root, 'project'), selection: chosen });
    await expect(next.prompt(s.id, { messageId: 'old-message', text: 'texto anterior' })).resolves.toBeUndefined();
    await expect(next.prompt(s.id, { messageId: 'old-message', text: 'outro texto' })).rejects.toMatchObject({ code: 'invalid' });
    expect(nextRuntime.created).toEqual([]); expect(nextRuntime.calls).toEqual([]);
  });
  it('compartilha uma única retomada quando duas chamadas chegam concorrentes', async () => {
    const s = await setup(); const nextRuntime = new Runtime();
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { reached = resolve; });
    nextRuntime.resume = async config => {
      nextRuntime.resumed.push(structuredClone(config)); reached(); await gate;
      return { runtimeSessionId: config.runtimeSessionId, lastSeq: 11, messages: [] };
    };
    const next = new SessionManager(catalog, nextRuntime, async () => true, new SessionStore(root, catalog));
    await next.initialize();
    const first = next.resume(s.id); await entered;
    const second = next.resume(s.id);
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(nextRuntime.resumed).toHaveLength(1);
    } finally { release(); }
    await expect(Promise.all([first, second])).resolves.toEqual([s, s]);
  });
  it('crash com turno running restaura interrupted sem liberar reenvio', async () => {
    const s = await setup(); await store.setState(s.id, 'running');
    const nextRuntime = new Runtime(); const next = new SessionManager(catalog, nextRuntime, async () => true, new SessionStore(root, catalog));
    await Promise.all([next.initialize(), next.initialize()]);
    expect(next.get(s.id).state).toBe('interrupted');
    await expect(next.prompt(s.id, prompt)).rejects.toMatchObject({ code: 'resume-required' });
    expect(nextRuntime.created).toEqual([]); expect(nextRuntime.calls).toEqual([]);
    expect((await store.get(s.id)).state).toBe('interrupted');
  });
  it('initialize repetido em instância viva não recupera turno ativo', async () => {
    const s = await setup(); const p = manager.prompt(s.id, prompt); await calls(1);
    await manager.initialize(); expect(manager.get(s.id).state).toBe('running');
    runtime.calls[0].resolve(); await p;
  });
  it('falha de persistência antes do turno bloqueia execução e novos envios', async () => {
    const s = await setup(); await mkdir(path.join(root, 'sessions.lock'));
    await expect(manager.prompt(s.id, prompt)).rejects.toMatchObject({ code: 'storage' });
    expect(runtime.calls).toEqual([]);
    await rm(path.join(root, 'sessions.lock'), { recursive: true });
    await expect(manager.prompt(s.id, { ...prompt, messageId: 'new' })).rejects.toMatchObject({ code: 'storage' });
    expect(runtime.calls).toEqual([]);
  });
  it('falha na conclusão não informa sucesso nem repete o turno', async () => {
    const s = await setup(); const p = manager.prompt(s.id, prompt); const rejection = expect(p).rejects.toMatchObject({ code: 'storage' });
    await calls(1); await mkdir(path.join(root, 'sessions.lock')); runtime.calls[0].resolve(); await rejection;
    expect(manager.get(s.id).state).toBe('interrupted');
    expect(manager.isAgentBusy(s.agentId)).toBe(false);
    await rm(path.join(root, 'sessions.lock'), { recursive: true });
    await expect(manager.prompt(s.id, prompt)).rejects.toMatchObject({ code: 'storage' });
    expect(runtime.calls).toHaveLength(1);
  });
  it('fecha conversa restaurada sem tentar fechar handle inexistente no runtime', async () => {
    const s = await setup(); const nextRuntime = new Runtime();
    const next = new SessionManager(catalog, nextRuntime, async () => true, new SessionStore(root, catalog));
    await next.initialize(); await next.close(s.id);
    expect((await store.get(s.id)).state).toBe('closed'); expect(nextRuntime.closed).toEqual([]);
  });
  it('persiste cancelamento de fila e fechamento sem ressuscitar trabalho', async () => {
    const s = await setup(); const other = await manager.create({ agentId: s.agentId });
    const first = manager.prompt(s.id, prompt); await calls(1);
    const second = manager.prompt(other.id, prompt); const rejected = expect(second).rejects.toMatchObject({ code: 'cancelled' });
    await expect.poll(async () => (await store.get(other.id)).state).toBe('queued');
    await manager.close(other.id); await rejected;
    expect((await store.get(other.id)).state).toBe('closed'); expect(runtime.calls).toHaveLength(1);
    runtime.calls[0].resolve(); await first;
  });
  it('aguarda running durável antes de enviar ao runtime', async () => {
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const entered = new Promise<void>(r => { reached = r; });
    manager = new SessionManager(catalog, runtime, async () => true, {
      recover: () => store.recover(), add: info => store.add(info),
      setState: async (id, state) => { if (state === 'running') { reached(); await gate; } await store.setState(id, state); },
    });
    const s = await setup(); const p = manager.prompt(s.id, prompt);
    try {
      await entered; expect(runtime.calls).toEqual([]); expect((await store.get(s.id)).state).toBe('queued');
    } finally { release(); await calls(1); runtime.calls[0].resolve(); await p; }
  });
  it('mantém reserva e barreira de cancelamento enquanto persiste a conclusão', async () => {
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const entered = new Promise<void>(r => { reached = r; });
    let hold = true;
    manager = new SessionManager(catalog, runtime, async () => true, {
      recover: () => store.recover(), add: info => store.add(info),
      setState: async (id, state) => { if (state === 'idle' && hold) { hold = false; reached(); await gate; } await store.setState(id, state); },
    });
    const s = await setup(); const other = await manager.create({ agentId: s.agentId });
    const p = manager.prompt(s.id, prompt); await calls(1); runtime.calls[0].resolve(); await entered;
    const next = manager.prompt(other.id, prompt);
    try {
      expect(manager.isAgentBusy(s.agentId)).toBe(true);
      await expect(manager.prompt(s.id, { ...prompt, messageId: 'new' })).rejects.toMatchObject({ code: 'busy' });
      const cancel = manager.cancel(s.id);
      expect(runtime.cancelled).toEqual([]); expect(runtime.calls).toHaveLength(1);
      release(); await p; await cancel; await calls(2); runtime.calls[1].resolve(); await next;
      expect(runtime.cancelled).toEqual([]);
    } finally { release(); runtime.calls.forEach(c => c.resolve()); await p; await next; }
  });
  it('falha de disco no cancel não libera slot com cancel ainda pendente', async () => {
    const s = await setup(); const other = await manager.create({ agentId: s.agentId });
    const p = manager.prompt(s.id, prompt); const rejected = expect(p).rejects.toMatchObject({ code: 'storage' }); await calls(1);
    const next = manager.prompt(other.id, prompt);
    await expect.poll(async () => (await store.get(other.id)).state).toBe('queued');
    let release!: () => void; runtime.cancelWait = new Promise<void>(r => { release = r; });
    await mkdir(path.join(root, 'sessions.lock'));
    const cancel = manager.cancel(s.id); const failedCancel = expect(cancel).rejects.toMatchObject({ code: 'storage' });
    runtime.calls[0].resolve();
    try {
      await expect.poll(() => runtime.cancelled.length).toBe(1);
      // Barrier completion is driven by the cancel acknowledgment, not disk failure.
      expect(manager.isAgentBusy(s.agentId)).toBe(true); expect(runtime.calls).toHaveLength(1);
    } finally {
      release(); await failedCancel; await rejected;
      await next.catch(() => undefined);
      await rm(path.join(root, 'sessions.lock'), { recursive: true });
    }
    expect(runtime.calls).toHaveLength(1);
  });
  it('não despacha turno cancelado enquanto finalização aguarda confirmação de disco', async () => {
    let release!: () => void, reached!: () => void, heldId = '';
    const gate = new Promise<void>(r => { release = r; }); const entered = new Promise<void>(r => { reached = r; });
    manager = new SessionManager(catalog, runtime, async () => true, {
      recover: () => store.recover(), add: info => store.add(info),
      setState: async (id, state) => {
        await store.setState(id, state);
        if (id === heldId && state === 'idle') { reached(); await gate; }
      },
    });
    const s = await setup(); const other = await manager.create({ agentId: s.agentId }); heldId = other.id;
    const first = manager.prompt(s.id, prompt); await calls(1);
    const second = manager.prompt(other.id, prompt); const rejection = expect(second).rejects.toMatchObject({ code: 'cancelled' });
    await expect.poll(async () => (await store.get(other.id)).state).toBe('queued');
    const cancel = manager.cancel(other.id); await entered;
    try {
      runtime.calls[0].resolve(); await first;
      expect(manager.get(other.id).state).toBe('queued');
      expect((await store.get(other.id)).state).toBe('idle');
    } finally { release(); await cancel; await rejection; }
    expect(runtime.calls).toHaveLength(1);
    expect((await store.get(other.id)).state).toBe('idle');
  });
  it('retry de close após falha de disco não fecha handle já descartado', async () => {
    runtime.close = async id => {
      if (runtime.closed.includes(id)) throw new Error('handle no longer exists');
      runtime.closed.push(id);
    };
    const s = await setup(); await mkdir(path.join(root, 'sessions.lock'));
    await expect(manager.close(s.id)).rejects.toMatchObject({ code: 'storage' });
    expect(runtime.closed).toEqual([s.runtimeSessionId]);
    await rm(path.join(root, 'sessions.lock'), { recursive: true });
    await manager.close(s.id);
    expect(runtime.closed).toEqual([s.runtimeSessionId]);
    expect(manager.get(s.id).state).toBe('closed');
    expect((await store.get(s.id)).state).toBe('closed');
  });
  it('corrupção no startup não é substituída por histórico vazio', async () => {
    await setup(); await writeFile(path.join(root, 'sessions.json'), '{truncated');
    const nextRuntime = new Runtime(); const next = new SessionManager(catalog, nextRuntime, async () => true, new SessionStore(root, catalog));
    await expect(next.initialize()).rejects.toMatchObject({ code: 'storage' });
    expect(next.list()).toEqual([]); expect(nextRuntime.created).toEqual([]);
    expect(await readFile(path.join(root, 'sessions.json'), 'utf8')).toBe('{truncated');
  });
});
