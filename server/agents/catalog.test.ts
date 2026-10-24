import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CatalogStore } from './catalog';

let root: string;
let cwd: string;
let busy = false;
const fixed = { mode: 'fixed' as const, selection: { providerId: 'openai', accountId: 'account-1', modelId: 'chosen-model' } };
const open = () => new CatalogStore(path.join(root, 'data'), () => busy);
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'office-catalog-')); cwd = path.join(root, 'project'); await mkdir(cwd); busy = false; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function setup() {
  const store = open();
  const project = await store.createProject({ name: 'Projeto', cwd });
  const agent = await store.createAgent({ projectId: project.id, name: 'Agente', appearanceSeed: 'avatar-1', modelPolicy: fixed });
  return { store, project, agent };
}
describe('catálogo persistente', () => {
  it('preserva projeto, personagem e modelo escolhido ao reabrir', async () => {
    const { project, agent } = await setup();
    expect(await open().getProject(project.id)).toEqual(project);
    expect(await open().getAgent(agent.id)).toEqual(agent);
    expect((await open().listAgents(project.id))[0].modelPolicy).toEqual(fixed);
  });
  it('recusa pastas inexistentes e arquivos como projeto', async () => {
    await expect(open().createProject({ name: 'x', cwd: path.join(root, 'missing') })).rejects.toThrow();
    const file = path.join(root, 'file'); await writeFile(file, 'x');
    await expect(open().createProject({ name: 'x', cwd: file })).rejects.toThrow();
    expect(await open().listProjects()).toEqual([]);
  });
  it('mantém modelos independentes por agente e devolve cópias', async () => {
    const { store, project, agent } = await setup();
    const second = await store.createAgent({ projectId: project.id, name: 'Outro', appearanceSeed: 'avatar-2', modelPolicy: { mode: 'choose-on-start' } });
    agent.name = 'modificado';
    expect((await store.getAgent(agent.id)).name).toBe('Agente');
    expect((await store.getAgent(second.id)).modelPolicy).toEqual({ mode: 'choose-on-start' });
    expect((await store.getAgent(agent.id)).modelPolicy).toEqual(fixed);
  });
  it('arquiva sem apagar e bloqueia o uso do agente arquivado', async () => {
    const { store, project, agent } = await setup(); await store.archiveAgent(agent.id);
    expect((await open().getAgent(agent.id)).archivedAt).toBeTruthy();
    expect(await store.listAgents(project.id)).toHaveLength(1);
    await expect(store.requireActiveAgent(agent.id)).rejects.toThrow();
  });
  it('bloqueia edição e arquivamento durante um turno ativo', async () => {
    const { store, agent } = await setup(); busy = true;
    await expect(store.updateAgent(agent.id, { modelPolicy: { mode: 'choose-on-start' } })).rejects.toThrow();
    await expect(store.archiveAgent(agent.id)).rejects.toThrow(); busy = false;
    expect((await store.getAgent(agent.id)).modelPolicy).toEqual(fixed);
    expect((await store.updateAgent(agent.id, { name: 'Novo' })).name).toBe('Novo');
  });
  it('recusa referências, políticas e mudanças de identidade inválidas', async () => {
    const { store, agent } = await setup();
    await expect(store.createAgent({ ...agent, projectId: 'missing' })).rejects.toThrow();
    await expect(store.updateAgent(agent.id, { id: 'changed' } as never)).rejects.toThrow();
    await expect(store.updateAgent(agent.id, { modelPolicy: { mode: 'fixed', selection: { ...fixed.selection, modelId: '' } } })).rejects.toThrow();
    expect((await store.getAgent(agent.id)).modelPolicy).toEqual(fixed);
  });
  it('serializa gravações concorrentes sem perder cadastros', async () => {
    const store = open(); await Promise.all(Array.from({ length: 10 }, (_, i) => store.createProject({ name: `p${i}`, cwd })));
    expect(await open().listProjects()).toHaveLength(10);
  });
  it('não sobrescreve arquivo corrompido nem versões desconhecidas', async () => {
    await setup(); const file = path.join(root, 'data', 'catalog.json');
    for (const text of ['{truncated', JSON.stringify({ schemaVersion: 999, projects: [], agents: [] })]) {
      await writeFile(file, text);
      await expect(open().createProject({ name: 'x', cwd })).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(text);
    }
  });
  it('recusa outro writer enquanto o lock existe', async () => {
    await setup(); await mkdir(path.join(root, 'data', 'catalog.lock'));
    await expect(open().createProject({ name: 'x', cwd })).rejects.toThrow();
    expect(await open().listProjects()).toHaveLength(1);
  });
});
