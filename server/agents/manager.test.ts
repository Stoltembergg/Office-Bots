import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CatalogStore } from './catalog';
import { SessionManager } from './manager';
import type { ManagedRuntime, RuntimeSessionConfig } from './runtime';
import type { ModelSelection } from '../../shared/agents/contracts';

const selected: ModelSelection = { providerId: 'openai', accountId: 'user', modelId: 'user-selected' };
class FakeRuntime implements ManagedRuntime {
  created: RuntimeSessionConfig[] = [];
  calls: { id: string; messageId: string; text: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  cancelled: string[] = [];
  cancelWait?: Promise<void>;
  cancelFailures = 0;
  closeFailures = 0;
  closed: string[] = [];
  async create(config: RuntimeSessionConfig) { this.created.push(config); return { runtimeSessionId: config.id }; }
  prompt(id: string, input: { messageId: string; text: string }): Promise<void> {
    return new Promise((resolve, reject) => this.calls.push({ id, ...input, resolve, reject }));
  }
  async cancel(id: string) { this.cancelled.push(id); if (this.cancelFailures-- > 0) throw new Error('cancel unavailable'); await this.cancelWait; }
  async close(id: string) { this.closed.push(id); if (this.closeFailures-- > 0) throw new Error('close unavailable'); }
}
let root: string, catalog: CatalogStore, manager: SessionManager, runtime: FakeRuntime;
let available = true;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'office-manager-'));
  catalog = new CatalogStore(path.join(root, 'data'), id => manager.isAgentBusy(id));
  runtime = new FakeRuntime(); available = true;
  manager = new SessionManager(catalog, runtime, async () => available);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function agent(mode: 'fixed' | 'choose-on-start' = 'fixed') {
  const cwd = path.join(root, 'project'); await mkdir(cwd, { recursive: true });
  const project = await catalog.createProject({ name: 'Projeto', cwd });
  return catalog.createAgent({ projectId: project.id, name: 'Agente', appearanceSeed: 'avatar', modelPolicy: mode === 'fixed' ? { mode, selection: selected } : { mode } });
}
async function session() { const a = await agent(); return manager.create({ agentId: a.id }); }
async function waitForCalls(n: number) { await expect.poll(() => runtime.calls.length).toBe(n); }
const input = (id: string) => ({ messageId: id, text: 'Faça a tarefa' });

describe('conversas gerenciadas', () => {
  it('usa o modelo fixo, cwd e identidade do cadastro sem inferência ao criar', async () => {
    const a = await agent(); const s = await manager.create({ agentId: a.id });
    expect(s.selection).toEqual(selected); expect(s.agentId).toBe(a.id); expect(s.state).toBe('idle');
    expect(runtime.created[0].cwd).toBe(path.join(root, 'project'));
    expect(runtime.calls).toHaveLength(0);
    s.selection.modelId = 'externally-mutated';
    expect(manager.get(s.id).selection).toEqual(selected);
  });
  it('rejeita override de modelo fixo e exige escolha em choose-on-start', async () => {
    const a = await agent();
    await expect(manager.create({ agentId: a.id, selection: { ...selected, modelId: 'different' } })).rejects.toThrow();
    const b = await agent('choose-on-start');
    await expect(manager.create({ agentId: b.id })).rejects.toThrow();
    expect((await manager.create({ agentId: b.id, selection: selected })).selection).toEqual(selected);
  });
  it('não troca provedor, conta ou modelo indisponíveis por fallback', async () => {
    const a = await agent(); available = false;
    await expect(manager.create({ agentId: a.id })).rejects.toThrow();
    expect(runtime.created).toHaveLength(0);
  });
  it('preserva a seleção das conversas anteriores após editar o agente', async () => {
    const a = await agent(); const s = await manager.create({ agentId: a.id });
    const next = { ...selected, modelId: 'new-choice' };
    await catalog.updateAgent(a.id, { modelPolicy: { mode: 'fixed', selection: next } });
    expect(manager.get(s.id).selection).toEqual(selected);
    expect((await manager.create({ agentId: a.id })).selection).toEqual(next);
  });
  it('deduplica envios concorrentes e retries após conclusão', async () => {
    const s = await session(); const one = manager.prompt(s.id, input('same')); const two = manager.prompt(s.id, input('same'));
    await waitForCalls(1); expect(runtime.calls).toHaveLength(1);
    runtime.calls[0].resolve(); await Promise.all([one, two]);
    await manager.prompt(s.id, input('same')); expect(runtime.calls).toHaveLength(1);
    await expect(manager.prompt(s.id, { ...input('same'), text: 'changed' })).rejects.toThrow();
  });
  it('limita a dois turnos globais e mantém fila observável', async () => {
    const sessions = await Promise.all([session(), session(), session()]);
    const promises = sessions.map((s, i) => manager.prompt(s.id, input(String(i))));
    await waitForCalls(2); await expect.poll(() => manager.list().filter(s => s.state === 'queued').length).toBe(1);
    runtime.calls[0].resolve(); await waitForCalls(3);
    runtime.calls[1].resolve(); runtime.calls[2].resolve(); await Promise.all(promises);
    expect(manager.list().every(s => s.state === 'idle')).toBe(true);
  });
  it('duas conversas do mesmo agente não executam juntas; outro agente pode avançar', async () => {
    const a = await agent(); const first = await manager.create({ agentId: a.id });
    const second = await manager.create({ agentId: a.id }); const other = await session();
    const p1 = manager.prompt(first.id, input('1')); await waitForCalls(1);
    const p2 = manager.prompt(second.id, input('2')); const p3 = manager.prompt(other.id, input('3'));
    await waitForCalls(2); expect(runtime.calls[1].id).toBe(other.runtimeSessionId);
    runtime.calls[0].resolve(); await waitForCalls(3); expect(runtime.calls[2].id).toBe(second.runtimeSessionId);
    runtime.calls[1].resolve(); runtime.calls[2].resolve(); await Promise.all([p1, p2, p3]);
  });
  it('cancelar fila não chama prompt nem cancel no runtime', async () => {
    const a = await agent(); const first = await manager.create({ agentId: a.id }); const next = await manager.create({ agentId: a.id });
    const p1 = manager.prompt(first.id, input('1')); await waitForCalls(1);
    const p2 = manager.prompt(next.id, input('2')); const rejected = expect(p2).rejects.toThrow();
    await expect.poll(() => manager.get(next.id).state).toBe('queued');
    await manager.cancel(next.id); await rejected;
    expect(runtime.calls).toHaveLength(1); expect(runtime.cancelled).toEqual([]);
    runtime.calls[0].resolve(); await p1; expect(manager.isAgentBusy(a.id)).toBe(false);
  });
  it('cancelamento ativo mantém slot ocupado até o runtime realmente terminar', async () => {
    const a = await agent(); const first = await manager.create({ agentId: a.id }); const next = await manager.create({ agentId: a.id });
    const p1 = manager.prompt(first.id, input('1')); const rejected = expect(p1).rejects.toThrow(); await waitForCalls(1);
    await manager.cancel(first.id); expect(manager.get(first.id).state).toBe('cancelling');
    const p2 = manager.prompt(next.id, input('2')); await expect.poll(() => manager.get(next.id).state).toBe('queued');
    expect(runtime.calls).toHaveLength(1); runtime.calls[0].resolve(); await rejected; await waitForCalls(2);
    runtime.calls[1].resolve(); await p2;
  });
  it('aguarda cancel pendente antes de reutilizar ou fechar a sessão', async () => {
    const s = await session(); let acknowledge!: () => void;
    runtime.cancelWait = new Promise<void>(resolve => { acknowledge = resolve; });
    const p = manager.prompt(s.id, input('1')); const rejection = expect(p).rejects.toThrow();
    await waitForCalls(1); const cancel = manager.cancel(s.id);
    runtime.calls[0].resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      expect(manager.get(s.id).state).toBe('cancelling');
      await expect(manager.prompt(s.id, input('2'))).rejects.toThrow();
      const close = manager.close(s.id);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(runtime.closed).toEqual([]);
      acknowledge(); await cancel; await rejection; await close;
      expect(runtime.closed).toEqual([s.runtimeSessionId]);
    } finally { acknowledge(); await cancel; await rejection; }
  });
  it('arquivamento iniciado antes da admissão impede o turno', async () => {
    const a = await agent(); const s = await manager.create({ agentId: a.id });
    const archive = catalog.archiveAgent(a.id); const prompt = manager.prompt(s.id, input('1'));
    await archive; await expect(prompt).rejects.toThrow(); expect(runtime.calls).toHaveLength(0);
  });
  it('admissão iniciada antes da edição bloqueia a alteração até concluir', async () => {
    const a = await agent(); const s = await manager.create({ agentId: a.id });
    const prompt = manager.prompt(s.id, input('1'));
    await expect(catalog.archiveAgent(a.id)).rejects.toThrow(); await waitForCalls(1);
    await expect(catalog.updateAgent(a.id, { name: 'Novo' })).rejects.toThrow();
    runtime.calls[0].resolve(); await prompt; await catalog.archiveAgent(a.id);
  });
  it('falha do runtime libera slot sem repetir a mensagem', async () => {
    const s = await session(); const p = manager.prompt(s.id, input('1')); const rejection = expect(p).rejects.toThrow();
    await waitForCalls(1); runtime.calls[0].reject(new Error('runtime failure')); await rejection;
    expect(manager.get(s.id).state).toBe('error'); expect(manager.isAgentBusy(s.agentId)).toBe(false);
    await expect(manager.prompt(s.id, input('1'))).rejects.toThrow(); expect(runtime.calls).toHaveLength(1);
  });
  it('revalida disponibilidade ao sair da fila', async () => {
    const a = await agent(); const s1 = await manager.create({ agentId: a.id }); const s2 = await manager.create({ agentId: a.id });
    const p1 = manager.prompt(s1.id, input('1')); await waitForCalls(1);
    const p2 = manager.prompt(s2.id, input('2')); const rejection = expect(p2).rejects.toThrow();
    await expect.poll(() => manager.get(s2.id).state).toBe('queued'); available = false;
    runtime.calls[0].resolve(); await p1; await rejection; expect(runtime.calls).toHaveLength(1);
  });
  it('permite repetir fechamento falho sem reabrir admissão de prompts', async () => {
    const s = await session(); runtime.closeFailures = 1;
    await expect(manager.close(s.id)).rejects.toThrow();
    await expect(manager.prompt(s.id, input('1'))).rejects.toThrow();
    await manager.close(s.id);
    expect(manager.get(s.id).state).toBe('closed');
  });
  it('permite repetir cancelamento falho ao tentar fechar novamente', async () => {
    const s = await session(); runtime.cancelFailures = 1;
    const p = manager.prompt(s.id, input('1')); const rejection = expect(p).rejects.toThrow();
    await waitForCalls(1); await expect(manager.close(s.id)).rejects.toThrow();
    let acknowledge!: () => void;
    runtime.cancelWait = new Promise<void>(resolve => { acknowledge = resolve; });
    const close = manager.close(s.id); void close.catch(() => undefined);
    try {
      await expect.poll(() => runtime.cancelled.length).toBe(2);
      runtime.calls[0].resolve(); await new Promise<void>(resolve => setImmediate(resolve));
      expect(runtime.closed).toEqual([]);
      acknowledge(); await close; await rejection;
      expect(manager.get(s.id).state).toBe('closed');
    } finally { acknowledge(); runtime.calls[0].resolve(); await rejection; }
  });
  it('fechar conversa cancela fila e impede novos turnos', async () => {
    const a = await agent(); const s1 = await manager.create({ agentId: a.id }); const s2 = await manager.create({ agentId: a.id });
    const p1 = manager.prompt(s1.id, input('1')); await waitForCalls(1);
    const p2 = manager.prompt(s2.id, input('2')); const rejection = expect(p2).rejects.toThrow();
    await expect.poll(() => manager.get(s2.id).state).toBe('queued'); await manager.close(s2.id); await rejection;
    await expect(manager.prompt(s2.id, input('3'))).rejects.toThrow(); expect(manager.get(s2.id).state).toBe('closed');
    runtime.calls[0].resolve(); await p1;
  });
});
