import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from '../test/fixtures';
import {
  CONSULTAS,
  criarLeitorUso,
  descobrirBancos,
  hermesUsoReader,
  lerUsoBancos,
  parseCotaAgy,
  rotuloProvedor,
} from './hermes-uso';

setQuiet(true);

// Colunas/tabelas que o escritório NUNCA pode ler (spec time-de-agentes, PROIBIDO). Montadas por partes para
// este próprio teste não se confundir com código que as lê.
const PROIBIDAS = ['mess' + 'ages', 'system' + '_prompt', 'ti' + 'tle', 'chat' + '_id', 'user' + '_id'];
const SEGREDO = 'SEGREDO-NAO-PODE-SAIR';

const AGORA = Date.parse('2026-10-11T23:00:00Z');
const seg = (ms: number) => ms / 1000;

/** Banco no formato do Hermes, com as colunas proibidas preenchidas com um segredo. */
function criaBanco(arquivo: string, opts: { semUso?: boolean } = {}): DatabaseSync {
  mkdirSync(join(arquivo, '..'), { recursive: true });
  const db = new DatabaseSync(arquivo);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, chat_id TEXT, model TEXT,
      system_prompt TEXT, started_at REAL NOT NULL, ended_at REAL, input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0, billing_provider TEXT, estimated_cost_usd REAL, title TEXT,
      last_activity_at REAL, profile_name TEXT);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, content TEXT);
  `);
  if (!opts.semUso) {
    db.exec(`CREATE TABLE session_model_usage (session_id TEXT NOT NULL, model TEXT NOT NULL,
      billing_provider TEXT NOT NULL DEFAULT '', input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0, first_seen REAL, last_seen REAL)`);
  }
  return db;
}

function sessao(db: DatabaseSync, id: string, source: string, ultima: number, extra: { provider?: string; ent?: number; sai?: number; ended?: number } = {}) {
  db.prepare(
    `INSERT INTO sessions (id, source, user_id, chat_id, model, system_prompt, started_at, ended_at, input_tokens, output_tokens,
       billing_provider, estimated_cost_usd, title, last_activity_at) VALUES (?, ?, ?, ?, 'modelo-x', ?, ?, ?, ?, ?, ?, 0.5, ?, ?)`,
  ).run(id, source, SEGREDO, SEGREDO, SEGREDO, seg(ultima) - 60, extra.ended ?? null, extra.ent ?? 0, extra.sai ?? 0, extra.provider ?? 'anthropic', SEGREDO, seg(ultima));
  db.prepare('INSERT INTO messages (session_id, content) VALUES (?, ?)').run(id, SEGREDO);
}

function uso(db: DatabaseSync, id: string, provider: string, ent: number, sai: number, visto: number, custo = 0.1) {
  db.prepare(
    'INSERT INTO session_model_usage (session_id, model, billing_provider, input_tokens, output_tokens, estimated_cost_usd, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 'modelo-x', provider, ent, sai, custo, seg(visto) - 10, seg(visto));
}

/** Monta um HERMES_ROOT de teste: default + dev + vini (sem session_model_usage) + perfil quebrado. */
function montaRaiz(raiz: string) {
  const def = criaBanco(join(raiz, 'state.db'));
  sessao(def, 'd1', 'cli', AGORA - 3600_000);
  uso(def, 'd1', 'anthropic', 1000, 200, AGORA - 3600_000); // 5 h e 7 d
  uso(def, 'd1', 'openai-codex', 50, 5, AGORA - 2 * 24 * 3600_000); // só 7 d
  uso(def, 'd1', 'anthropic', 9999, 9999, AGORA - 8 * 24 * 3600_000); // fora das duas
  def.close();

  const dev = criaBanco(join(raiz, 'profiles', 'dev', 'state.db'));
  sessao(dev, 'k1', 'kanban', AGORA - 10 * 60_000);
  uso(dev, 'k1', 'anthropic', 300, 30, AGORA - 10 * 60_000);
  uso(dev, 'k1', 'xai-oauth', 7, 3, AGORA - 20 * 60_000);
  uso(dev, 'k1', '', 1, 1, AGORA - 20 * 60_000);
  dev.close();

  const vini = criaBanco(join(raiz, 'profiles', 'vini', 'state.db'), { semUso: true });
  sessao(vini, 't1', 'telegram', AGORA - 30_000, { provider: 'google', ent: 40, sai: 4 });
  vini.close();

  const alexa = criaBanco(join(raiz, 'profiles', 'alexa', 'state.db'));
  sessao(alexa, 't2', 'telegram', AGORA - 10 * 60_000); // falou há 10 min: à toa
  alexa.close();

  mkdirSync(join(raiz, 'profiles', 'quebrado'), { recursive: true });
  writeFileSync(join(raiz, 'profiles', 'quebrado', 'state.db'), 'isto não é sqlite');
  mkdirSync(join(raiz, 'profiles', 'sem-banco'), { recursive: true });
}

describe('fonte de sessões do Hermes: privacidade', () => {
  it('o código não toca colunas/tabelas proibidas (fora de comentário)', () => {
    const fonte = readFileSync(new URL('./hermes-uso.ts', import.meta.url), 'utf8');
    const semComentario = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const p of PROIBIDAS) expect(semComentario, `"${p}" apareceu no código`).not.toMatch(new RegExp(`\\b${p}\\b`, 'i'));
  });

  it('nenhuma consulta usa coluna proibida nem SELECT *', () => {
    for (const sql of CONSULTAS) {
      expect(sql).not.toMatch(/select\s+\*/i);
      for (const p of PROIBIDAS) expect(sql, sql).not.toMatch(new RegExp(`\\b${p}\\b`, 'i'));
    }
  });

  describe('com bancos de teste', () => {
    let raiz: string;
    let cleanup: () => void;
    beforeEach(() => {
      const t = tempDir('hermes-uso-');
      raiz = t.dir;
      cleanup = t.cleanup;
      montaRaiz(raiz);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      cleanup();
    });

    it('o SQL realmente executado não toca colunas proibidas e o segredo não sai', () => {
      const executadas: string[] = [];
      const original = DatabaseSync.prototype.prepare;
      vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
        executadas.push(sql);
        return original.call(this, sql);
      });
      const out = lerUsoBancos(descobrirBancos(raiz), AGORA);
      expect(executadas.length).toBeGreaterThan(0);
      for (const sql of executadas) {
        expect(sql).not.toMatch(/select\s+\*/i);
        for (const p of PROIBIDAS) expect(sql, sql).not.toMatch(new RegExp(`\\b${p}\\b`, 'i'));
      }
      expect(JSON.stringify(out)).not.toContain(SEGREDO);
    });

    it('abre os bancos só para leitura', () => {
      const out = lerUsoBancos(descobrirBancos(raiz), AGORA);
      expect(out.falhas.map((f) => f.perfil)).toEqual(['quebrado']);
      // escrever pelo mesmo modo de abertura falha
      const db = new DatabaseSync(join(raiz, 'state.db'), { readOnly: true });
      expect(() => db.exec("INSERT INTO sessions (id, source, started_at) VALUES ('x', 'cli', 1)")).toThrow(/readonly/i);
      db.close();
    });
  });
});

describe('uso por assinatura (5 h / 7 dias por billing_provider)', () => {
  let raiz: string;
  let cleanup: () => void;
  beforeEach(() => {
    const t = tempDir('hermes-uso-');
    raiz = t.dir;
    cleanup = t.cleanup;
    montaRaiz(raiz);
  });
  afterEach(() => cleanup());

  it('descobre default + perfis com state.db', () => {
    expect(descobrirBancos(raiz).map((b) => b.perfil)).toEqual(['default', 'alexa', 'dev', 'quebrado', 'vini']);
  });

  it('agrega por billing_provider nas duas janelas, com perfis e custo', () => {
    const out = lerUsoBancos(descobrirBancos(raiz), AGORA);
    const cinco = Object.fromEntries(out.cincoHoras.map((u) => [u.provedor, u]));
    const sete = Object.fromEntries(out.seteDias.map((u) => [u.provedor, u]));

    expect(cinco.anthropic).toMatchObject({ rotulo: 'Claude', tokensEntrada: 1300, tokensSaida: 230, total: 1530, registros: 2, perfis: { default: 1200, dev: 330 } });
    expect(cinco.anthropic.custoEstimadoUsd).toBeCloseTo(0.2);
    expect(cinco['openai-codex']).toBeUndefined();
    expect(cinco['xai-oauth']).toMatchObject({ rotulo: 'Grok', total: 10 });
    expect(cinco.desconhecido).toMatchObject({ rotulo: 'Desconhecido', total: 2 });
    // banco sem session_model_usage cai para os totais da sessão
    expect(cinco.google).toMatchObject({ rotulo: 'Gemini', total: 44, perfis: { vini: 44 } });

    expect(sete['openai-codex']).toMatchObject({ rotulo: 'ChatGPT', total: 55 });
    expect(sete.anthropic.total).toBe(1530); // a linha de 8 dias atrás fica fora
    expect(out.seteDias[0].provedor).toBe('anthropic'); // maior gasto primeiro
  });

  it('personas: conversando só com Telegram há menos de 2 min', () => {
    const out = lerUsoBancos(descobrirBancos(raiz), AGORA);
    const p = Object.fromEntries(out.personas.map((x) => [x.perfil, x]));
    expect(p.vini).toMatchObject({ conversando: true, ultimaFonte: 'telegram', ultimaAtividade: AGORA - 30_000 });
    expect(p.alexa.conversando).toBe(false);
    expect(p.dev).toMatchObject({ conversando: false, ultimaFonte: 'kanban' });
  });

  it('rótulos das assinaturas', () => {
    expect(['anthropic', 'openai-codex', 'openai-api', 'google', 'gemini', 'xai-oauth', 'antigravity-agy', 'sakana', ''].map(rotuloProvedor)).toEqual([
      'Claude', 'ChatGPT', 'ChatGPT', 'Gemini', 'Gemini', 'Grok', 'Antigravity', 'sakana', 'Desconhecido',
    ]);
  });

  it('cache curto no leitor', () => {
    let t = AGORA;
    const ler = criarLeitorUso({ raiz, agora: () => t, cacheMs: 15_000 });
    const a = ler();
    t += 5_000;
    expect(ler()).toBe(a);
    t += 20_000;
    expect(ler()).not.toBe(a);
  });

  it('sem HERMES_ROOT a fonte fica desligada', () => {
    expect(hermesUsoReader({}, '/home/x')).toBeUndefined();
    expect(hermesUsoReader({ HERMES_ROOT: raiz }, '/home/x')).toBeTypeOf('function');
  });
});

describe('cota do Antigravity (agy-cota.tsv)', () => {
  const TSV = [
    '2026-10-11 19:53\tGemini Models\tWeekly Limit Remaining\t100%\t2026-10-18T22:53:31Z',
    '2026-10-11 19:53\tGemini Models\tFive Hour Limit Remaining\t100%\t2026-10-12T03:53:31Z',
    '2026-10-11 20:00\tClaude and GPT models\tFive Hour Limit Remaining\t100%\t2026-10-12T04:00:27Z',
    'linha quebrada',
    '2026-10-11 20:06\tGemini Models\tWeekly Limit Remaining\t98%\t2026-10-18T22:54:20Z',
    '2026-10-11 20:06\tGemini Models\tFive Hour Limit Remaining\t87%\t2026-10-12T03:54:20Z',
    '',
  ].join('\n');

  it('última linha por família/janela', () => {
    expect(parseCotaAgy(TSV)).toEqual([
      { familia: 'Claude and GPT models', janela: 'cincoHoras', restantePct: 100, usadoPct: 0, reiniciaEm: Date.parse('2026-10-12T04:00:27Z'), coletadoEm: '2026-10-11 20:00' },
      { familia: 'Gemini Models', janela: 'cincoHoras', restantePct: 87, usadoPct: 13, reiniciaEm: Date.parse('2026-10-12T03:54:20Z'), coletadoEm: '2026-10-11 20:06' },
      { familia: 'Gemini Models', janela: 'seteDias', restantePct: 98, usadoPct: 2, reiniciaEm: Date.parse('2026-10-18T22:54:20Z'), coletadoEm: '2026-10-11 20:06' },
    ]);
  });

  it('arquivo ausente não derruba a leitura', () => {
    const t = tempDir('hermes-uso-');
    try {
      const ler = criarLeitorUso({ raiz: t.dir, cotaAgy: join(t.dir, 'nao-existe.tsv') });
      expect(ler()).toMatchObject({ antigravity: [], cincoHoras: [], personas: [] });
    } finally {
      t.cleanup();
    }
  });
});

describe('GET /api/hermes/uso', () => {
  let base: string;
  let close: () => Promise<void>;
  let cleanup: () => void;

  async function sobe(hermesUso?: () => unknown) {
    const t = tempDir();
    cleanup = t.cleanup;
    const accounts = new AccountsService({ dirs: [], home: t.dir, env: {}, onChange: () => {} });
    const office = new Office({ names: new NameStore(null), version: '9.9.9', startedAt: Date.now(), accounts: (s) => accounts.list(s), sources: () => [], accountName: () => undefined });
    const hub = new Hub(office, { throttleMs: 10 });
    const api = createApiHandler({ office, hub, accounts, sources: () => [], version: '9.9.9', inDocker: false, hermesUso });
    const server = http.createServer((req, res) => {
      if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise<void>((ok) => server.close(() => ok()));
  }
  afterEach(async () => {
    await close();
    cleanup();
  });

  it('responde o uso quando ligada; POST é 405', async () => {
    await sobe(() => ({ cincoHoras: [{ provedor: 'anthropic' }] }));
    const r = await fetch(`${base}/api/hermes/uso`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ cincoHoras: [{ provedor: 'anthropic' }] });
    expect((await fetch(`${base}/api/hermes/uso`, { method: 'POST' })).status).toBe(405);
  });

  it('404 quando desligada', async () => {
    await sobe(undefined);
    expect((await fetch(`${base}/api/hermes/uso`)).status).toBe(404);
  });
});
