import { describe, expect, it } from 'vitest';
import { CYCLE_TOLERANCE_MS, decideQuota, QUOTA_KEY, QUOTA_THRESHOLDS, quotaNoticeText, type QuotaCycle } from './quota-alert';

const MIN = 60_000;
const HOUR = 60 * MIN;
const R = 1_000 * HOUR; // um resetsAt qualquer
const cyc = (done: (80 | 95)[] = [], resetsAt = R): QuotaCycle => ({ resetsAt, done });

describe('decideQuota', () => {
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
