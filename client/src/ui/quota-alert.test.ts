import { describe, expect, it } from 'vitest';
import type { AccountUsage, UsageWindow } from '../../../shared/types';
import { formatResetAt } from './format';
import { CYCLE_TOLERANCE_MS, decideQuota, evaluateQuota, QUOTA_KEY, QUOTA_THRESHOLDS, quotaNoticeText, sanitizeQuotaState, type QuotaAccount, type QuotaCycle, type QuotaInput, type QuotaLast, type QuotaState } from './quota-alert';

const MIN = 60_000;
const HOUR = 60 * MIN;
const R = 1_000 * HOUR; // um resetsAt qualquer
const cyc = (done: (80 | 95)[] = [], resetsAt = R): QuotaCycle => ({ resetsAt, done });

describe('decideQuota', () => {
  it('QUOTA-02: leitura anterior já no limiar (80) não é cruzamento; só vindo de baixo avisa', () => {
    expect(decideQuota({ pct: 81, resetsAt: R, prevPct: 80, cycle: cyc() }).notify).toBeNull();
    expect(decideQuota({ pct: 81, resetsAt: R, prevPct: 79, cycle: cyc() }).notify).toBe(80);
  });

  it('QUOTA-09: sem ciclo gravado e sem leitura anterior, 85% é só linha de base (null) e registra o 80', () => {
    const d = decideQuota({ pct: 85, resetsAt: R, prevPct: undefined, cycle: undefined });
    expect(d.notify).toBeNull();
    expect(d.skip).toBe(false);
    expect(d.cycle).toEqual({ resetsAt: R, done: [80] });
  });

  it('QUOTA-01: 79 para 81 avisa 80; 72 para 90 (aba que volta de segundo plano) também avisa 80', () => {
    expect(decideQuota({ pct: 81, resetsAt: R, prevPct: 79, cycle: cyc() })).toEqual({ notify: 80, cycle: cyc([80]), skip: false });
    expect(decideQuota({ pct: 90, resetsAt: R, prevPct: 72, cycle: cyc() })).toEqual({ notify: 80, cycle: cyc([80]), skip: false });
  });

  it('QUOTA-02: 83 para 96 com 80 já tratado avisa 95', () => {
    expect(decideQuota({ pct: 96, resetsAt: R, prevPct: 83, cycle: cyc([80]) })).toEqual({ notify: 95, cycle: cyc([80, 95]), skip: false });
  });

  it('QUOTA-03: 70 para 97 avisa só o 95 e registra o 80 como tratado', () => {
    const d = decideQuota({ pct: 97, resetsAt: R, prevPct: 70, cycle: cyc() });
    expect(d.notify).toBe(95);
    expect(d.cycle?.done).toEqual([80, 95]);
  });

  it('QUOTA-04: oscilação 79, 81, 79, 82 no mesmo ciclo avisa uma única vez', () => {
    let cycle: QuotaCycle | undefined = cyc();
    let prev: number | undefined;
    const notified: (number | null)[] = [];
    for (const pct of [79, 81, 79, 82]) {
      const d = decideQuota({ pct, resetsAt: R, prevPct: prev, cycle });
      notified.push(d.notify);
      cycle = d.cycle;
      prev = pct;
    }
    expect(notified).toEqual([null, 80, null, null]);
  });

  it('QUOTA-01 e QUOTA-02: os limites são inclusivos (79 não avisa, 80 avisa; 94 não, 95 sim)', () => {
    expect(decideQuota({ pct: 79, resetsAt: R, prevPct: 70, cycle: cyc() }).notify).toBeNull();
    expect(decideQuota({ pct: 80, resetsAt: R, prevPct: 79, cycle: cyc() }).notify).toBe(80);
    expect(decideQuota({ pct: 94, resetsAt: R, prevPct: 90, cycle: cyc([80]) }).notify).toBeNull();
    expect(decideQuota({ pct: 95, resetsAt: R, prevPct: 94, cycle: cyc([80]) }).notify).toBe(95);
    expect(QUOTA_THRESHOLDS).toEqual([80, 95]);
  });

  it('QUOTA-05: resetsAt 5 h adiante é ciclo novo (sem aviso, done zerado)', () => {
    const d = decideQuota({ pct: 10, resetsAt: R + 5 * HOUR, prevPct: 97, cycle: cyc([80]) });
    expect(d.notify).toBeNull();
    expect(d.skip).toBe(false);
    expect(d.cycle).toEqual({ resetsAt: R + 5 * HOUR, done: [] });
  });

  it('QUOTA-05: +9 min é o mesmo ciclo (sem repetir) e +11 min é ciclo novo', () => {
    const same = decideQuota({ pct: 85, resetsAt: R + 9 * MIN, prevPct: 83, cycle: cyc([80]) });
    expect(same.notify).toBeNull();
    expect(same.cycle).toEqual(cyc([80]));
    const next = decideQuota({ pct: 85, resetsAt: R + 11 * MIN, prevPct: 83, cycle: cyc([80]) });
    expect(next.notify).toBeNull(); // primeira leitura do ciclo novo é linha de base
    expect(next.cycle).toEqual({ resetsAt: R + 11 * MIN, done: [80] });
    expect(CYCLE_TOLERANCE_MS).toBe(10 * MIN);
  });

  it('QUOTA-05: leitura de ciclo mais antigo (-20 min) vira skip e deixa o ciclo gravado intacto', () => {
    const c = cyc([80]);
    const d = decideQuota({ pct: 99, resetsAt: R - 20 * MIN, prevPct: 50, cycle: c });
    expect(d).toEqual({ notify: null, cycle: c, skip: true });
  });

  it('QUOTA-13: resetsAt ausente ou NaN nunca avisa e mantém o ciclo', () => {
    const c = cyc([80]);
    expect(decideQuota({ pct: 90, resetsAt: undefined, prevPct: 70, cycle: c })).toEqual({ notify: null, cycle: c, skip: false });
    expect(decideQuota({ pct: 90, resetsAt: Number.NaN, prevPct: 70, cycle: c })).toEqual({ notify: null, cycle: c, skip: false });
    expect(decideQuota({ pct: 90, resetsAt: undefined, prevPct: 70, cycle: undefined })).toEqual({ notify: null, cycle: undefined, skip: false });
  });

  it('QUOTA-02: 100% avisa o 95 ("perto do limite")', () => {
    expect(decideQuota({ pct: 100, resetsAt: R, prevPct: 90, cycle: cyc([80]) }).notify).toBe(95);
  });

  it('QUOTA-05 e QUOTA-09: a primeira leitura de um ciclo novo (prev 97, pct 85) é linha de base, não aviso', () => {
    const d = decideQuota({ pct: 85, resetsAt: R + 5 * HOUR, prevPct: 97, cycle: cyc([80, 95]) });
    expect(d.notify).toBeNull();
    expect(d.cycle).toEqual({ resetsAt: R + 5 * HOUR, done: [80] });
  });

  it('QUOTA-22: é pura (não muta a entrada congelada, mesmo resultado em chamadas repetidas) e a chave de armazenamento é fixa', () => {
    const cycle = Object.freeze({ resetsAt: R, done: Object.freeze([80]) }) as unknown as QuotaCycle;
    const s = Object.freeze({ pct: 97, resetsAt: R, prevPct: 83, cycle });
    const a = decideQuota(s);
    const b = decideQuota(s);
    expect(a).toEqual(b);
    expect(a.notify).toBe(95);
    expect(cycle.done).toEqual([80]);
    expect(QUOTA_KEY).toBe('habblaud:quota-alerts');
  });
});

describe('quotaNoticeText', () => {
  it('QUOTA-06: 80% da sessão de 5 h', () => {
    expect(quotaNoticeText('Conta C', 'fiveHour', 80, 82, 'às 14:30')).toBe('⚠️ Conta C: 82% da sessão de 5 h usados (reinicia às 14:30)');
  });

  it('QUOTA-06: 80% da semana', () => {
    expect(quotaNoticeText('Conta C', 'sevenDay', 80, 81, 'qui., 20:00')).toBe('⚠️ Conta C: 81% da semana usados (reinicia qui., 20:00)');
  });

  it('QUOTA-06: 95% da sessão de 5 h', () => {
    expect(quotaNoticeText('Conta C', 'fiveHour', 95, 96, 'às 14:30')).toBe('🚨 Conta C: perto do limite, 96% da sessão de 5 h usados (reinicia às 14:30)');
  });

  it('QUOTA-06: 95% da semana', () => {
    expect(quotaNoticeText('Conta C', 'sevenDay', 95, 95, 'amanhã às 01:30')).toBe('🚨 Conta C: perto do limite, 95% da semana usados (reinicia amanhã às 01:30)');
  });

  it('QUOTA-06: o texto de 95 mostra o percentual real lido (97), não o limiar', () => {
    const t = quotaNoticeText('Conta C', 'fiveHour', 95, 97, 'às 14:30');
    expect(t).toContain('97%');
    expect(t).not.toContain('95%');
  });
});

describe('evaluateQuota', () => {
  const NOW = 2_000 * HOUR;
  const FIVE = NOW + 3 * HOUR;
  const WEEK = NOW + 3 * 24 * HOUR;
  const win = (utilization: number, resetsAt: number | undefined = FIVE): UsageWindow => ({ utilization, resetsAt });
  const acc = (over: Partial<QuotaAccount> & { five?: UsageWindow; week?: UsageWindow } = {}): QuotaAccount => {
    const { five, week, ...rest } = over;
    const usage: AccountUsage = { source: 'statusline', fetchedAt: NOW - MIN, ...(five ? { fiveHour: five } : {}), ...(week ? { sevenDay: week } : {}) };
    return { id: '.claude-c', name: 'Conta C', usage, usageStatus: 'ok', ...rest };
  };
  const input = (accounts: QuotaAccount[], over: Partial<QuotaInput> = {}): QuotaInput => ({ accounts, now: NOW, hidden: [], state: {}, last: {}, ...over });
  /** Roda os quadros em sequência, passando adiante o estado e as leituras anteriores. */
  const run = (frames: QuotaAccount[][], over: Partial<QuotaInput> = {}) => {
    let state: QuotaState = {};
    let last: QuotaLast = {};
    const out: ReturnType<typeof evaluateQuota>[] = [];
    for (const accounts of frames) {
      const r = evaluateQuota(input(accounts, { state, last, ...over }));
      state = r.state;
      last = r.last;
      out.push(r);
    }
    return out;
  };

  it('QUOTA-01 e QUOTA-07: linha de base e depois cruzamento dão 1 aviso, de nível warn, sem agentId nem roomId', () => {
    const [a, b, c] = run([[acc({ five: win(70) })], [acc({ five: win(82) })], [acc({ five: win(83) })]]);
    expect(a.notices).toEqual([]);
    expect(b.notices).toHaveLength(1);
    const n = b.notices[0];
    expect(n.level).toBe('warn');
    expect(n.id).toBe(`quota:.claude-c:fiveHour:80:${FIVE}`);
    expect(n.at).toBe(NOW);
    expect(n.text).toContain('Conta C: 82% da sessão de 5 h usados (reinicia ');
    expect(n.text).toBe(quotaNoticeText('Conta C', 'fiveHour', 80, 82, formatResetAt(FIVE, NOW)));
    expect('agentId' in n).toBe(false);
    expect('roomId' in n).toBe(false);
    expect(c.notices).toEqual([]);
  });

  it('QUOTA-08 e QUOTA-06: conta do Codex segue a mesma regra; "Codex" no nome não repete o sufixo e "Conta X" vira "Conta X · Codex"', () => {
    const codex = (name: string, u: number) => acc({ id: '.codex', name, provider: 'codex', five: win(u) });
    const x = run([[codex('Conta X', 70)], [codex('Conta X', 85)]])[1].notices;
    expect(x).toHaveLength(1);
    expect(x[0].text).toContain('Conta X · Codex: 85%');
    const c = run([[codex('Codex', 70)], [codex('Codex', 85)]])[1].notices;
    expect(c).toHaveLength(1);
    expect(c[0].text).toContain('⚠️ Codex: 85%');
    expect(c[0].text).not.toContain('Codex · Codex');
    expect(c[0].text).not.toContain('· Codex:');
  });

  it('QUOTA-10: usageStatus stale não avisa nem atualiza a leitura anterior', () => {
    const [a, b] = run([[acc({ five: win(70) })], [acc({ five: win(90), usageStatus: 'stale' })]]);
    expect(b.notices).toEqual([]);
    expect(b.last).toEqual(a.last);
    expect(b.state).toEqual(a.state);
    // a leitura anterior continua 70: quando os números voltam a valer, o cruzamento é avisado
    const d = evaluateQuota(input([acc({ five: win(85) })], { state: b.state, last: b.last }));
    expect(d.notices).toHaveLength(1);
  });

  it('QUOTA-11: janela que renovou depois da leitura (resetsAt no passado) não avisa', () => {
    const [a, b] = run([[acc({ five: win(70) })], [acc({ five: win(95, NOW - 1) })]]);
    expect(b.notices).toEqual([]);
    expect(b.last).toEqual(a.last); // a leitura de uma janela renovada não vira "leitura anterior"
    expect(b.state).toEqual(a.state);
  });

  it('QUOTA-12: conta sem cota (noQuota) e leitura sem janelas não avisam nem viram 0% ou 100%', () => {
    const noQuota = acc({ usage: { source: 'codex', noQuota: true, fetchedAt: NOW }, provider: 'codex', name: 'Codex' });
    const empty = acc({ id: '.claude-d', usage: { source: 'cache', fetchedAt: NOW } });
    const none = acc({ id: '.claude-e', usage: undefined, usageStatus: 'disabled' });
    const r = run([[noQuota, empty, none], [noQuota, empty, none]]);
    for (const x of r) {
      expect(x.notices).toEqual([]);
      expect(x.last).toEqual({});
      expect(x.state).toEqual({});
    }
  });

  it('QUOTA-16: conta com id demo: não avisa', () => {
    const d = (u: number) => acc({ id: 'demo:conta', five: win(u) });
    const r = run([[d(70)], [d(97)]]);
    expect(r[1].notices).toEqual([]);
    expect(r[1].state).toEqual({});
  });

  it('QUOTA-17 e QUOTA-09: conta oculta não avisa e, reexibida já em 90%, também não (linha de base)', () => {
    const a = (u: number) => [acc({ five: win(u) })];
    let state: QuotaState = {};
    let last: QuotaLast = {};
    const step = (accounts: QuotaAccount[], hidden: string[]) => {
      const r = evaluateQuota(input(accounts, { state, last, hidden }));
      state = r.state;
      last = r.last;
      return r.notices;
    };
    expect(step(a(70), [])).toEqual([]);
    expect(step(a(85), ['.claude-c'])).toEqual([]); // oculta, cruzou
    expect(step(a(90), [])).toEqual([]); // reexibida acima do limiar: linha de base
    expect(step(a(96), [])).toHaveLength(1); // e o 95 ainda avisa
  });

  it('QUOTA-01: sessão de 5 h e semana cruzando 80% no mesmo quadro dão 2 avisos, um por janela', () => {
    const f = (five: number, week: number) => [acc({ five: win(five), week: win(week, WEEK) })];
    const r = run([f(70, 70), f(82, 81)])[1].notices;
    expect(r).toHaveLength(2);
    expect(r[0].id).toBe(`quota:.claude-c:fiveHour:80:${FIVE}`);
    expect(r[1].id).toBe(`quota:.claude-c:sevenDay:80:${WEEK}`);
    expect(r[0].text).toContain('da sessão de 5 h');
    expect(r[1].text).toContain('da semana');
  });

  it('QUOTA-01: várias contas cruzando juntas avisam todas, na ordem do snapshot', () => {
    const f = (u: number) => [acc({ id: '.claude-b', name: 'Conta B', five: win(u) }), acc({ id: '.claude-a', name: 'Conta A', five: win(u) })];
    const r = run([f(70), f(88)])[1].notices;
    expect(r.map((n) => n.id.split(':')[1])).toEqual(['.claude-b', '.claude-a']);
  });

  it('QUOTA-13: janela sem resetsAt não avisa', () => {
    const f = (u: number) => [acc({ five: { utilization: u } })];
    const r = run([f(70), f(97)]);
    expect(r[1].notices).toEqual([]);
    expect(r[1].state).toEqual({});
  });

  it('QUOTA-05: poda do estado os ciclos que já acabaram e mantém os em curso', () => {
    const state: QuotaState = {
      'velha|fiveHour': { resetsAt: NOW - CYCLE_TOLERANCE_MS, done: [80] },
      'viva|fiveHour': { resetsAt: NOW + HOUR, done: [80] },
    };
    const r = evaluateQuota(input([], { state }));
    expect(Object.keys(r.state)).toEqual(['viva|fiveHour']);
    expect(r.changed).toBe(true);
    expect(evaluateQuota(input([], { state: r.state })).changed).toBe(false);
  });

  it('QUOTA-22: não muta as entradas (congeladas em profundidade)', () => {
    const deepFreeze = <T,>(o: T): T => {
      if (o && typeof o === 'object') for (const v of Object.values(o)) deepFreeze(v);
      return Object.freeze(o);
    };
    const accounts = deepFreeze([acc({ five: win(85), week: win(90, WEEK) })]);
    const state = deepFreeze<QuotaState>({ '.claude-c|fiveHour': { resetsAt: FIVE, done: [] }, 'velha|fiveHour': { resetsAt: NOW - HOUR, done: [80] } });
    const last = deepFreeze<QuotaLast>({ '.claude-c|fiveHour': 70 });
    const hidden = deepFreeze(['x']);
    const r = evaluateQuota({ accounts, now: NOW, hidden, state, last });
    expect(r.notices).toHaveLength(1);
    expect(r.state).not.toBe(state);
    expect(state['.claude-c|fiveHour'].done).toEqual([]);
  });

  it('QUOTA-01: utilization que não é número finito não avisa', () => {
    const f = (u: number) => [acc({ five: win(u) })];
    expect(run([f(70), f(Number.NaN)])[1].notices).toEqual([]);
    expect(run([f(70), f(Number.POSITIVE_INFINITY)])[1].notices).toEqual([]);
  });

  it('QUOTA-01: 79,5% conta como 80% (o mesmo arredondamento do cartão)', () => {
    const r = evaluateQuota(input([acc({ five: win(79.5) })], { last: { '.claude-c|fiveHour': 70 }, state: { '.claude-c|fiveHour': { resetsAt: FIVE, done: [] } } }));
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0].text).toContain('80%');
  });
});

describe('sanitizeQuotaState', () => {
  it('QUOTA-21: estado válido passa igual', () => {
    const ok: QuotaState = { 'a|fiveHour': { resetsAt: 123, done: [80] }, 'b|sevenDay': { resetsAt: 456, done: [80, 95] }, 'c|fiveHour': { resetsAt: 7, done: [] } };
    expect(sanitizeQuotaState(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
  });

  it('QUOTA-21: null, texto, número, lista e undefined viram {}', () => {
    for (const raw of [null, undefined, 'texto', 42, true, [], [{ resetsAt: 1, done: [] }]]) expect(sanitizeQuotaState(raw)).toEqual({});
  });

  it('QUOTA-21: entrada com resetsAt não numérico (ou não finito) ou sem formato é descartada, as boas ficam', () => {
    const raw = {
      'a|fiveHour': { resetsAt: '123', done: [80] },
      'b|fiveHour': { resetsAt: null, done: [80] },
      'c|fiveHour': { resetsAt: Number.POSITIVE_INFINITY, done: [] },
      'd|fiveHour': 'x',
      'e|fiveHour': null,
      'f|fiveHour': { resetsAt: 5, done: 'nao-lista' },
      'g|fiveHour': { resetsAt: 9, done: [95] },
    };
    expect(sanitizeQuotaState(raw)).toEqual({ 'g|fiveHour': { resetsAt: 9, done: [95] } });
  });

  it('QUOTA-21: done com valores fora de 80 e 95 é filtrado e sem repetição', () => {
    const raw = { 'a|fiveHour': { resetsAt: 1, done: [95, 50, '80', 80, 80, 95, null, 100] } };
    const r = sanitizeQuotaState(raw);
    expect([...r['a|fiveHour'].done].sort()).toEqual([80, 95]);
    expect(r['a|fiveHour'].done).toHaveLength(2);
  });

  it('QUOTA-21: mais de 40 entradas viram 40', () => {
    const raw: Record<string, unknown> = {};
    for (let n = 0; n < 55; n++) raw[`conta${n}|fiveHour`] = { resetsAt: n + 1, done: [80] };
    const r = sanitizeQuotaState(raw);
    expect(Object.keys(r)).toHaveLength(40);
    expect(r['conta0|fiveHour']).toEqual({ resetsAt: 1, done: [80] });
  });
});
