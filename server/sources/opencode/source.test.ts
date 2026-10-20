// Fonte do OpenCode contra um servidor simulado (test/opencode-fake.ts): boot, eventos ao vivo, subagentes (por parentID
// e por metadata.ocgo.thread), queda e volta do servidor, senha e varredura. Os tempos são encurtados nos testes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, Notice } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { log, setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { FakeOpenCode } from '../../test/opencode-fake';
import { OpenCodeSource, type OpenCodeTiming } from './source';

setQuiet(true);

const SERVER_DEFAULTS: OpenCodeTiming = { recentMs: 60 * 60_000, graceMs: 150, sweepMs: 60_000, retryMinMs: 20, retryMaxMs: 80, stallMs: 5_000 };
const AGENT = 'opencode:ses_alfa';

let cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const c of cleanups) await c();
  cleanups = [];
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espera uma condição (tempo real), com erro claro se não acontecer. */
async function until(cond: () => boolean, label: string, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`tempo esgotado esperando: ${label}`);
    await sleep(10);
  }
}

function harness(opts: { password?: string; configPassword?: string; timing?: Partial<OpenCodeTiming> } = {}) {
  const fake = new FakeOpenCode({ password: opts.password });
  const home = mkdtempSync(join(tmpdir(), 'habblaud-oc-test-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home, env: {}, onChange: () => late.office?.markDirty() });
  // Relógio do escritório: o teste avança `clock.offset` para passar as graças (o tempo real continua correndo).
  const clock = { offset: 0 };
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: Date.now(),
    now: () => Date.now() + clock.offset,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
  });
  late.office = office;
  const notices: Notice[] = [];
  let source: OpenCodeSource | undefined;
  cleanups.push(async () => {
    source?.stop();
    await fake.stop();
  });
  const agents = (): AgentInfo[] => {
    const snap = office.commit();
    notices.push(...snap.notices);
    return snap.snapshot.agents;
  };
  return {
    fake,
    office,
    clock,
    notices,
    agents,
    agent: (id: string) => agents().find((a) => a.id === id),
    get source(): OpenCodeSource {
      if (!source) throw new Error('fonte ainda não iniciada');
      return source;
    },
    /** Sobe o servidor (na porta dada, ou numa livre), liga a fonte e espera a primeira tentativa (boot ou falha). */
    async start(port?: number): Promise<OpenCodeSource> {
      await fake.start(port);
      source = new OpenCodeSource({
        accounts,
        office,
        config: { url: fake.url, ...((opts.configPassword ?? opts.password) !== undefined ? { password: opts.configPassword ?? opts.password } : {}) },
        timing: { ...SERVER_DEFAULTS, ...opts.timing },
      });
      await source.start();
      return source;
    },
  };
}

describe('boot', () => {
  it('sessão rodando vira principal na sala da pasta, com título; recente parada fica ociosa; antiga fica de fora', async () => {
    const h = harness();
    const now = Date.now();
    h.fake.sessions.set('ses_alfa', { id: 'ses_alfa', directory: '/projetos/alfa', title: 'Refatorar parser', created: now - 300_000, updated: now - 60_000 });
    h.fake.active.add('ses_alfa');
    h.fake.sessions.set('ses_beta', { id: 'ses_beta', directory: '/projetos/beta', created: now - 600_000, updated: now - 120_000 });
    h.fake.sessions.set('ses_velha', { id: 'ses_velha', directory: '/projetos/velha', created: now - 9_000_000, updated: now - 7_200_000 });
    const begin = vi.spyOn(h.office, 'beginBoot');
    const end = vi.spyOn(h.office, 'endBoot');

    await h.start();

    expect(begin).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(h.office.isBooting()).toBe(false);
    expect(h.agent(AGENT)).toMatchObject({ kind: 'main', provider: 'opencode', status: 'working', title: 'Refatorar parser', roomId: '/projetos/alfa' });
    expect(h.agent('opencode:ses_beta')).toMatchObject({ kind: 'main', status: 'idle' });
    expect(h.agent('opencode:ses_velha')).toBeUndefined();
    expect(h.source.sources()).toEqual([expect.objectContaining({ label: 'opencode', provider: 'opencode', ok: true, sessions: 2 })]);
    expect(h.notices).toEqual([]);
    expect(h.fake.nonGetRequests()).toEqual([]);
  });

  it('com a senha certa conecta; a senha vai no basic auth do usuário opencode', async () => {
    const h = harness({ password: 'senha-de-teste' });
    await h.start();
    expect(h.source.sources()[0]?.ok).toBe(true);
    expect(h.fake.requests.every((r) => r.auth === `Basic ${Buffer.from('opencode:senha-de-teste').toString('base64')}`)).toBe(true);
  });

  it('senha errada: fica fora, com o status na fonte, e a senha não aparece no log', async () => {
    const warn = vi.spyOn(log, 'warn');
    const info = vi.spyOn(log, 'info');
    const h = harness({ password: 'senha-certa-teste', configPassword: 'senha-errada-teste' });
    await h.start();
    expect(h.source.sources()[0]).toMatchObject({ ok: false, error: expect.stringContaining('401') });
    const logged = [...warn.mock.calls, ...info.mock.calls].map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('senha-errada-teste');
    expect(logged).not.toContain('senha-certa-teste');
  });
});

describe('ao vivo (SSE)', () => {
  it('a sessão entra, roda (ferramenta e texto viram atividade) e para; apagada, sai', async () => {
    const h = harness();
    await h.start();
    await until(() => h.fake.streamCount > 0 && h.source.sources()[0]?.ok === true, 'conexão de eventos');
    const id = 'ses_gama';
    const key = `opencode:${id}`;

    h.fake.emit('session.created', { sessionID: id, title: 'Nova tarefa' }, { directory: '/projetos/gama' });
    await until(() => h.agent(key) !== undefined, 'agente entrar');
    expect(h.agent(key)).toMatchObject({ kind: 'main', status: 'idle', roomId: '/projetos/gama' });

    h.fake.emit('session.execution.started', { sessionID: id });
    await until(() => h.agent(key)?.status === 'working', 'status working');

    h.fake.emit('session.tool.input.started', { sessionID: id, id: 'call_1', name: 'shell' });
    h.fake.emit('session.tool.called', { sessionID: id, id: 'call_1', input: { command: 'ls -1A' } });
    await until(() => h.agent(key)?.activity?.tool === 'Bash', 'atividade da ferramenta');
    expect(h.agent(key)?.activity?.detail).toBe('ls -1A');

    h.fake.emit('session.text.ended', { sessionID: id, text: 'pronto' });
    await until(() => h.agent(key)?.activity?.kind === 'respond', 'texto da resposta');

    h.fake.emit('session.execution.succeeded', { sessionID: id });
    await until(() => h.agent(key)?.status === 'idle', 'status idle');
    expect(h.notices.some((n) => n.agentId === key && n.text.includes('concluiu'))).toBe(true);

    h.fake.emit('session.deleted', { sessionID: id });
    await until(() => h.agent(key)?.status === 'offline', 'sessão apagada sai');
    expect(h.fake.nonGetRequests()).toEqual([]);
  });

  it('subagente por parentID: entra sob a mãe enquanto roda, entrega (📦) ao terminar e volta se trabalhar de novo', async () => {
    const h = harness();
    const now = Date.now();
    h.fake.sessions.set('ses_pai', { id: 'ses_pai', directory: '/projetos/pai', title: 'Pai', created: now, updated: now });
    h.fake.active.add('ses_pai');
    await h.start();
    const parent = 'opencode:ses_pai';
    const child = 'opencode:ses_filha';

    h.fake.emit('session.created', { sessionID: 'ses_filha', parentID: 'ses_pai', title: 'Pesquisar' }, { directory: '/projetos/pai' });
    h.fake.emit('session.execution.started', { sessionID: 'ses_filha' });
    await until(() => h.agent(child)?.status === 'working', 'subagente trabalhando');
    expect(h.agent(child)).toMatchObject({ kind: 'sub', parentId: parent, provider: 'opencode', status: 'working' });

    h.fake.emit('session.execution.succeeded', { sessionID: 'ses_filha' });
    await until(() => h.agent(child)?.status === 'done', 'subagente entregou');
    expect(h.notices.some((n) => n.text.includes('📦') && n.agentId === child)).toBe(true);

    h.fake.emit('session.execution.started', { sessionID: 'ses_filha' });
    await until(() => h.agent(child)?.status === 'working', 'subagente voltou a trabalhar');
    expect(h.fake.nonGetRequests()).toEqual([]);
  });

  it('metadata.ocgo.thread: subagente da sessão do Claude Code presente; sem ela, vira principal', async () => {
    const h = harness();
    await h.start();
    await until(() => h.source.sources()[0]?.ok === true, 'conexão');
    h.office.addMain({
      id: 'claude-principal-1',
      account: 'conta-claude',
      sessionId: 'claude-thread-teste-1',
      cwd: '/projetos/gama',
      role: 'Agente principal',
      startedAt: Date.now(),
      status: 'working',
    });

    // Como o servidor real: o metadata vai no session.created.
    h.fake.emit('session.created', { sessionID: 'ses_vinculada', title: 'Ajuda', metadata: { ocgo: { thread: 'claude-thread-teste-1' } } }, { directory: '/projetos/gama' });
    h.fake.emit('session.created', { sessionID: 'ses_solta', title: 'Sozinha', metadata: { ocgo: { thread: 'claude-thread-ausente' } } }, { directory: '/projetos/delta' });
    h.fake.emit('session.execution.started', { sessionID: 'ses_vinculada' });
    h.fake.emit('session.execution.started', { sessionID: 'ses_solta' });

    await until(() => h.agent('opencode:ses_vinculada')?.status === 'working', 'subagente vinculado');
    expect(h.agent('opencode:ses_vinculada')).toMatchObject({ kind: 'sub', parentId: 'claude-principal-1', provider: 'opencode' });
    expect(h.agent('opencode:ses_solta')).toMatchObject({ kind: 'main', provider: 'opencode', roomId: '/projetos/delta' });

    h.fake.emit('session.execution.succeeded', { sessionID: 'ses_vinculada' });
    await until(() => h.agent('opencode:ses_vinculada')?.status === 'done', 'subagente vinculado entregou');
    expect(h.notices.some((n) => n.text.includes('📦') && n.agentId === 'opencode:ses_vinculada')).toBe(true);
    expect(h.fake.nonGetRequests()).toEqual([]);
  });

  it('dono sai na graça de entrega do subagente: a sessão não vira principal por cima do registro dele, e volta como principal depois', async () => {
    const h = harness();
    await h.start();
    await until(() => h.source.sources()[0]?.ok === true, 'conexão');
    h.office.addMain({
      id: 'claude-principal-2',
      account: 'conta-claude',
      sessionId: 'claude-thread-dono',
      cwd: '/projetos/gama',
      role: 'Agente principal',
      startedAt: Date.now(),
      status: 'working',
    });
    h.fake.emit('session.created', { sessionID: 'ses_trabalho', title: 'Trabalho', metadata: { ocgo: { thread: 'claude-thread-dono' } } }, { directory: '/projetos/gama' });
    h.fake.emit('session.execution.started', { sessionID: 'ses_trabalho' });
    await until(() => h.agent('opencode:ses_trabalho')?.status === 'working', 'subagente entrou sob o dono');
    h.fake.emit('session.execution.succeeded', { sessionID: 'ses_trabalho' });
    await until(() => h.agent('opencode:ses_trabalho')?.status === 'done', 'subagente entregou');

    // O dono sai dentro da graça de entrega. A sessão segue recente, então a varredura tenta entrar como principal.
    h.office.closeMain('claude-principal-2');
    h.fake.emit('session.text.ended', { sessionID: 'ses_trabalho' });
    await sleep(60);
    // Passam as duas graças: o registro do subagente tem de sair (sem a correção, o addMain tiraria o removeAt e ele ficava).
    h.clock.offset += 30_000;
    h.office.tick();
    expect(h.agent('opencode:ses_trabalho')).toBeUndefined();

    h.fake.emit('session.text.ended', { sessionID: 'ses_trabalho' });
    await until(() => h.agent('opencode:ses_trabalho')?.kind === 'main', 'sessão voltou como principal');
    expect(h.agent('opencode:ses_trabalho')).toMatchObject({ kind: 'main', provider: 'opencode', roomId: '/projetos/gama' });
    expect(h.fake.nonGetRequests()).toEqual([]);
  });

  it('subagente da sessão do Claude Code fica na conta do OpenCode: os tokens não caem na conta do Claude', async () => {
    const h = harness();
    await h.start();
    await until(() => h.source.sources()[0]?.ok === true, 'conexão');
    h.office.addMain({
      id: 'claude-principal-3',
      account: 'conta-claude',
      sessionId: 'claude-thread-conta',
      cwd: '/projetos/gama',
      role: 'Agente principal',
      startedAt: Date.now(),
      status: 'working',
    });
    h.fake.emit('session.created', { sessionID: 'ses_conta', title: 'Conta', metadata: { ocgo: { thread: 'claude-thread-conta' } } }, { directory: '/projetos/gama' });
    h.fake.emit('session.execution.started', { sessionID: 'ses_conta' });
    await until(() => h.agent('opencode:ses_conta')?.status === 'working', 'subagente entrou sob o dono');
    const contaOpenCode = h.source.sources()[0]?.label;
    expect(contaOpenCode).toBeTruthy();
    expect(h.agent('opencode:ses_conta')).toMatchObject({ kind: 'sub', parentId: 'claude-principal-3' });
    expect(h.agent('opencode:ses_conta')?.account).toBe(contaOpenCode);
    expect(h.agent('opencode:ses_conta')?.account).not.toBe('conta-claude');
  });
});

describe('conexão', () => {
  it('servidor fora do ar: um aviso só, os agentes somem após a graça e voltam com o boot quando o servidor volta', async () => {
    const warn = vi.spyOn(log, 'warn');
    const info = vi.spyOn(log, 'info');
    const h = harness({ timing: { graceMs: 150 } });
    const now = Date.now();
    h.fake.sessions.set('ses_rho', { id: 'ses_rho', directory: '/projetos/rho', created: now, updated: now });
    h.fake.active.add('ses_rho');
    await h.start();
    const port = h.fake.port;
    expect(h.agent('opencode:ses_rho')?.status).toBe('working');

    await h.fake.stop();
    await until(() => h.source.sources()[0]?.ok === false, 'fonte marca a queda');
    await sleep(400); // o backoff tenta de novo várias vezes nesse tempo
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('OpenCode')).length).toBe(1);
    await until(() => h.agent('opencode:ses_rho')?.status === 'offline', 'agente sai depois da graça');

    await h.fake.start(port);
    await until(() => h.source.sources()[0]?.ok === true, 'reconecta');
    await until(() => h.agent('opencode:ses_rho')?.status === 'working', 'agente volta com o boot');
    expect(info.mock.calls.filter((c) => String(c[0]).includes('conectado')).length).toBe(2);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('OpenCode')).length).toBe(1);
  });

  it('stream mudo por mais de stallMs é refeito (conexão morta)', async () => {
    const h = harness({ timing: { stallMs: 80 } });
    await h.start();
    await until(() => h.fake.requests.filter((r) => r.path === '/api/event').length >= 3, 'reconexões por stall', 4_000);
    expect(h.fake.nonGetRequests()).toEqual([]);
  });

  it('sessão parada há mais que recentMs sai na varredura', async () => {
    const h = harness({ timing: { recentMs: 300, sweepMs: 50 } });
    const now = Date.now();
    h.fake.sessions.set('ses_alfa', { id: 'ses_alfa', directory: '/projetos/alfa', created: now, updated: now });
    await h.start();
    expect(h.agent(AGENT)?.status).toBe('idle');
    await until(() => h.agent(AGENT)?.status === 'offline', 'sessão ociosa sai', 3_000);
  });
});
