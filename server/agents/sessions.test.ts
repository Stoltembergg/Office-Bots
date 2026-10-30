import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CatalogStore } from './catalog';
import { SessionStore } from './sessions';
import type { SessionInfo, SessionState } from '../../shared/agents/contracts';

let root: string, directory: string, file: string, catalog: CatalogStore, info: SessionInfo;
const open = () => new SessionStore(directory, catalog);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'office-sessions-'));
  directory = path.join(root, 'data'); file = path.join(directory, 'sessions.json');
  const cwd = path.join(root, 'project'); await mkdir(cwd);
  catalog = new CatalogStore(directory, () => false);
  const project = await catalog.createProject({ name: 'Projeto', cwd });
  const agent = await catalog.createAgent({ projectId: project.id, name: 'Agente', appearanceSeed: 'avatar', modelPolicy: { mode: 'choose-on-start' } });
  info = { id: 'conversation-1', origin: 'managed-pi', runtimeSessionId: 'sdk-session-1', projectId: project.id,
    agentId: agent.id, selection: { providerId: 'provider', accountId: 'account', modelId: 'chosen' }, state: 'idle' };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('índice persistente de conversas', () => {
  it('reabre identidade, referência SDK e seleção sem guardar um segundo contexto', async () => {
    const store = open(); await store.add(info);
    info.selection.modelId = 'changed';
    const saved = await open().get(info.id);
    expect(saved.selection.modelId).toBe('chosen');
    expect(saved.runtimeSessionId).toBe('sdk-session-1');
    saved.selection.accountId = 'changed';
    expect((await store.get(info.id)).selection.accountId).toBe('account');
    const data = JSON.parse(await readFile(file, 'utf8'));
    expect(data).toEqual({ schemaVersion: 1, sessions: [{ ...info, selection: { providerId: 'provider', accountId: 'account', modelId: 'chosen' } }] });
  });
  it('preserva conversas de agentes arquivados e seleções antigas após edição', async () => {
    await open().add(info);
    await catalog.updateAgent(info.agentId, { modelPolicy: { mode: 'fixed', selection: { ...info.selection, modelId: 'new' } } });
    await catalog.archiveAgent(info.agentId);
    expect((await open().get(info.id)).selection).toEqual(info.selection);
  });
  it('recupera estados não concluídos como interrompidos sem retomar execução', async () => {
    const store = open();
    const states: SessionState[] = ['idle', 'queued', 'running', 'cancelling', 'error', 'closed', 'interrupted'];
    for (const state of states) {
      await store.add({ ...info, id: state, runtimeSessionId: `sdk-${state}` });
      await store.setState(state, state);
    }
    const recovered = await open().recover();
    expect(recovered.map(s => s.state)).toEqual(['idle', 'interrupted', 'interrupted', 'interrupted', 'error', 'closed', 'interrupted']);
    expect(await open().recover()).toEqual(recovered);
    expect((await open().get('running')).selection).toEqual(info.selection);
  });
  it('serializa gravações concorrentes sem perder conversas ou estados', async () => {
    const store = open();
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.add({ ...info, id: `s${i}`, runtimeSessionId: `sdk${i}` })));
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.setState(`s${i}`, 'running')));
    expect(await open().list(info.projectId)).toHaveLength(12);
    expect((await open().list()).every(s => s.state === 'running')).toBe(true);
    expect(await store.list('other-project')).toEqual([]);
    expect((await readdir(directory)).filter(x => x.endsWith('.tmp') || x === 'sessions.lock')).toEqual([]);
  });
  it('recusa duplicação de id e referência SDK sem sobrescrever a conversa', async () => {
    const store = open(); await store.add(info);
    await expect(store.add({ ...info, runtimeSessionId: 'different' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.add({ ...info, id: 'different' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await store.list()).toEqual([info]);
  });
  it('recusa referências de agente/projeto ausentes ou cruzadas', async () => {
    const store = open();
    const second = await catalog.createProject({ name: 'Other', cwd: root });
    for (const change of [{ agentId: 'missing' }, { projectId: 'missing' }, { projectId: second.id }]) {
      await expect(store.add({ ...info, ...change })).rejects.toMatchObject({ code: 'reference' });
    }
    expect(await store.list()).toEqual([]);
  });
  it('não modifica índice que perde uma referência de catálogo', async () => {
    await open().add(info); const original = await readFile(file, 'utf8');
    const catalogFile = path.join(directory, 'catalog.json');
    const data = JSON.parse(await readFile(catalogFile, 'utf8')); data.agents = [];
    await writeFile(catalogFile, JSON.stringify(data));
    await expect(open().recover()).rejects.toMatchObject({ code: 'reference' });
    expect(await readFile(file, 'utf8')).toBe(original);
  });
  it('copia arquivo truncado para quarentena e mantém bloqueio em próximas tentativas', async () => {
    const raw = '{truncated'; await writeFile(file, raw);
    await expect(open().recover()).rejects.toMatchObject({ code: 'corrupt' });
    await expect(open().add(info)).rejects.toMatchObject({ code: 'corrupt' });
    expect(await readFile(file, 'utf8')).toBe(raw);
    const quarantine = (await readdir(directory)).filter(x => x.endsWith('.corrupt'));
    expect(quarantine.length).toBeGreaterThan(0);
    for (const entry of quarantine) expect(await readFile(path.join(directory, entry), 'utf8')).toBe(raw);
  });
  it('preserva versão desconhecida sem substituir nem tentar migrar', async () => {
    const raw = JSON.stringify({ schemaVersion: 999, sessions: [info] }); await writeFile(file, raw);
    await expect(open().recover()).rejects.toMatchObject({ code: 'unsupported-version' });
    await expect(open().add(info)).rejects.toMatchObject({ code: 'unsupported-version' });
    expect(await readFile(file, 'utf8')).toBe(raw);
  });
  it('recusa registros malformados e campos de contexto ou credenciais', async () => {
    for (const change of [{ origin: 'observed-cli' }, { selection: { modelId: 'x' } }, { state: 'unknown' }, { transcript: ['secret'] }, { token: 'secret' }]) {
      await expect(open().add({ ...info, ...change } as SessionInfo)).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(await open().list()).toEqual([]);
  });
  it('colisão de lock falha sem removê-lo nem sobrescrever dados', async () => {
    await open().add(info); const original = await readFile(file, 'utf8');
    const lock = path.join(directory, 'sessions.lock'); await mkdir(lock); await writeFile(path.join(lock, 'owner'), 'other');
    await expect(open().setState(info.id, 'running')).rejects.toMatchObject({ code: 'locked' });
    expect(await readFile(path.join(lock, 'owner'), 'utf8')).toBe('other');
    expect(await readFile(file, 'utf8')).toBe(original);
  });
  it('recusa estado e id inválidos sem perder dados e aceita próxima gravação', async () => {
    const store = open(); await store.add(info); const original = await readFile(file, 'utf8');
    await expect(store.setState('missing', 'running')).rejects.toMatchObject({ code: 'invalid' });
    await expect(store.setState(info.id, 'bad' as SessionState)).rejects.toMatchObject({ code: 'invalid' });
    expect(await readFile(file, 'utf8')).toBe(original);
    await store.setState(info.id, 'closed'); expect((await open().get(info.id)).state).toBe('closed');
  });
});
