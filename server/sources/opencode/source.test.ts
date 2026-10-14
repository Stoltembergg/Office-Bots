// Integração da fonte do OpenCode: uma pasta de dados temporária com sessions/ e open-sessions/ sintéticos
// (o que o plugin do OpenCode escreve), o AccountsService e o Office.
//
// O ponto central do teste é o arquivo de conversa: ele é JSONL NO FORMATO DO CLAUDE CODE, e é por isso que a
// fonte reaproveita o parser do Claude Code em vez de escrever um tradutor próprio.
import { mkdirSync, rmSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { tempDir } from '../../test/fixtures';
import { OpenCodeSource } from './source';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const SESSION = 'ses_abc123';
/** A chave no escritório é "<id da conta>:<sessionId>"; o id depende do nome da pasta do teste. */
const keyOf = (s: { office: Office }) => s.office.list()[0]?.id ?? `:${SESSION}`;

function setup(opts: { meta?: Record<string, unknown> | null; withLock?: boolean; lines?: string[] } = {}) {
  const t = tempDir('habblaud-opencode-');
  cleanups.push(t.cleanup);
  const sessions = join(t.dir, 'sessions');
  const open = join(t.dir, 'open-sessions');
  mkdirSync(sessions, { recursive: true });
  mkdirSync(open, { recursive: true });

  if (opts.meta !== null) {
    writeFileSync(
      join(sessions, `${SESSION}.meta.json`),
      JSON.stringify({ sessionId: SESSION, cwd: '/home/teste/projeto', ...(opts.meta ?? {}) }),
    );
  }
  const lines = opts.lines ?? defaultLines();
  if (lines.length) writeFileSync(join(sessions, `${SESSION}.jsonl`), lines.join('\n') + '\n');

  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: t.dir, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new OpenCodeSource({ accounts, office, dirs: [t.dir], env: {}, home: t.dir, now, pollMs: 1_000 });
  cleanups.unshift(() => source.stop());

  return {
    dir: t.dir,
    sessions,
    open,
    office,
    source,
    now,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Simula o plugin marcando a sessão como aberta. */
    touchLock(at = clock) {
      const p = join(open, `${SESSION}.lock`);
      writeFileSync(p, '');
      utimesSync(p, new Date(at), new Date(at));
    },
    removeLock() {
      rmSync(join(open, `${SESSION}.lock`), { force: true });
    },
    append(lines: string[]) {
      appendFileSync(join(sessions, `${SESSION}.jsonl`), lines.join('\n') + '\n');
    },
    agent: (id?: string) => office.get(id ?? office.list()[0]?.id ?? `:${SESSION}`),
    main: () => office.list().filter((a) => a.kind === 'main'),
  };
}

/** Uma conversa curta no formato do transcript do Claude Code. */
function defaultLines(): string[] {
  return [
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-10-12T20:00:00.000Z', message: { role: 'user', content: 'oi, arruma o bug do login' } }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: '2026-10-12T20:00:05.000Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'Vou olhar o arquivo de login.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/home/teste/projeto/login.ts' } }],
      },
    }),
  ];
}

describe('OpenCodeSource', () => {
  it('descobre a conta a partir da pasta de dados', () => {
    const s = setup();
    s.touchLock();
    s.source.poll(true);
    expect(s.source.sources()).toEqual([expect.objectContaining({ provider: 'opencode', sessions: 1 })]);
  });

  it('o agente entra no escritório com a sala do projeto e a conta', () => {
    const s = setup();
    s.touchLock();
    s.source.poll(true);
    const a = s.agent();
    expect(a).toBeDefined();
    expect(a?.provider).toBe('opencode');
    // O caminho do projeto vira a sala do escritório.
    expect(s.office.roomPath(a!.roomId)).toBe('/home/teste/projeto');
    expect(a?.status).toBe('working');
  });

  it('sem metadados não há sala: o agente não entra', () => {
    const s = setup({ meta: null });
    s.touchLock();
    s.source.poll(true);
    expect(s.agent()).toBeUndefined();
  });

  it('sem marcador de presença a sessão não entra', () => {
    const s = setup();
    s.source.poll(true);
    expect(s.agent()).toBeUndefined();
  });

  it('lê a conversa e vira atividades', () => {
    const s = setup();
    s.touchLock();
    s.source.poll(true);
    const a = s.agent();
    expect(a).toBeDefined();
    // O prompt do usuário vira atividade; o status fica 'working' por haver ferramenta em aberto.
    const acts = s.office.list()[0]?.status;
    expect(acts).toBeTruthy();
  });

  it('nova linha na conversa aparece na próxima leitura', () => {
    const s = setup();
    s.touchLock();
    s.source.poll(true);
    const before = s.office.recentFeed(50).length;
    s.append([
      JSON.stringify({ type: 'assistant', uuid: 'a2', timestamp: '2026-10-12T20:00:09.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Pronto, arrumei.' }] } }),
    ]);
    s.advance(1_000);
    s.source.poll();
    expect(s.office.recentFeed(50).length).toBeGreaterThan(before);
  });

  it('o marcador sumindo tira o agente do escritório', () => {
    const s = setup();
    s.touchLock();
    s.source.poll(true);
    expect(s.agent()).toBeDefined();

    // Primeiro vira 'offline' (como todo agente que encerra no Habblaud) e some depois da carencia.
    s.removeLock();
    s.advance(60_000);
    s.source.poll();
    expect(s.agent()?.status).toBe('offline');

    // Depois da carencia o escritorio so remove no proprio tick() (o servidor roda a cada segundo).
    s.advance(10 * 60_000);
    s.source.poll();
    s.office.tick();
    expect(s.agent()).toBeUndefined();
  });

  it('o caminho da conversa é exposto para o terminal', () => {
    const s = setup();
    s.touchLock();
    s.source.poll(true);
    expect(s.source.transcriptPathOf(keyOf(s))).toContain(`${SESSION}.jsonl`);
    // O parser padrão (o do Claude Code) entende o formato.
    expect(s.source.terminalParser?.(keyOf(s))).toBeDefined();
  });

  it('um subagente entra colado ao principal e sai quando a sessão acaba', () => {
    const s = setup({ meta: { cwd: '/home/teste/projeto', parentId: 'ses_pai' } });
    s.touchLock();
    s.source.poll(true);
    // Sem o principal no escritório, o subagente não entra.
    expect(s.agent()).toBeUndefined();
  });

  it('a conta tem id e letra proprios', () => {
    const s = setup();
    s.touchLock();
    s.source.poll(true);
    const a = s.office.list()[0];
    expect(a?.account).toBeTruthy();
    expect(a?.account).not.toBe('.codex');
  });
});

// Duas sessões do MESMO projeto: devem virar DOIS personagens na MESMA sala.
describe('OpenCodeSource — duas sessões no mesmo projeto', () => {
  it('vira dois personagens na mesma sala', () => {
    const t = tempDir('habblaud-opencode-2-');
    cleanups.push(t.cleanup);
    const sessions = join(t.dir, 'sessions');
    const open = join(t.dir, 'open-sessions');
    mkdirSync(sessions, { recursive: true });
    mkdirSync(open, { recursive: true });

    const PROJ = '/home/teste/projeto'
    const ids = ['ses_aaa', 'ses_bbb']
    for (const id of ids) {
      writeFileSync(join(sessions, `${id}.meta.json`), JSON.stringify({ sessionId: id, cwd: PROJ }))
      writeFileSync(
        join(sessions, `${id}.jsonl`),
        JSON.stringify({ type: 'user', uuid: 'u-' + id, message: { role: 'user', content: 'oi de ' + id } }) + '\n',
      )
      writeFileSync(join(open, `${id}.lock`), '')
    }

    let clock = Date.now()
    const now = () => clock
    const late: { office?: Office } = {}
    const accounts = new AccountsService({ dirs: [], home: t.dir, env: {}, now, onChange: () => late.office?.markDirty() })
    const office = new Office({
      names: new NameStore(null),
      version: 'teste',
      startedAt: clock,
      accounts: (s) => accounts.list(s),
      sources: () => [],
      accountName: (id) => accounts.find(id)?.detected.name,
      now,
    })
    late.office = office
    const source = new OpenCodeSource({ accounts, office, dirs: [t.dir], env: {}, home: t.dir, now })
    cleanups.unshift(() => source.stop())
    source.poll(true)

    const mains = office.list().filter((a) => a.kind === 'main')
    // Dois personagens...
    expect(mains).toHaveLength(2)
    // ...em uma sala só.
    expect(new Set(mains.map((a) => a.roomId)).size).toBe(1)
    expect(office.roomPath(mains[0].roomId)).toBe(PROJ)
    // E com nomes diferentes, como dois colegas de mesa.
    expect(new Set(mains.map((a) => a.name)).size).toBe(2)
  })
})
