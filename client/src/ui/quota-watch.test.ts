import { describe, expect, it } from 'vitest';
import type { AccountInfo, Notice } from '../../../shared/types';
import { QUOTA_KEY } from './quota-alert';
import { QuotaToaster } from './quota-watch';
import type { UiContext } from './context';

const HOUR = 3_600_000;
const NOW = 1_000_000 * HOUR;
const RESET = NOW + 2 * HOUR;

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const calls = { set: 0 };
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      calls.set++;
      data.set(k, v);
    },
    data,
    calls,
  };
}

function account(pct: number, id = 'conta-a'): AccountInfo {
  return {
    id,
    name: 'Conta A',
    usageStatus: 'ok',
    usage: { source: 'cache', fetchedAt: NOW, fiveHour: { utilization: pct, resetsAt: RESET } },
  } as unknown as AccountInfo;
}

/** Um "navegador": contexto falso + componente; `see(pct)` entrega um quadro com a conta nesse percentual. */
function page(storage: Parameters<typeof newToaster>[1], opts: { push?: (n: Notice) => void } = {}) {
  return newToaster(opts.push ? { push: opts.push } : {}, storage);
}
function newToaster(opts: { push?: (n: Notice) => void }, storage: ConstructorParameters<typeof QuotaToaster>[2]) {
  const notices: Notice[] = [];
  const store = { snapshot: { accounts: [account(0)] }, connection: 'open', replaying: false };
  const prefs = { quotaAlerts: true, hiddenAccounts: [] as string[] };
  const ctx = { store, prefs, now: () => NOW } as unknown as UiContext;
  const toaster = new QuotaToaster(ctx, opts.push ?? ((n) => notices.push(n)), storage);
  const see = (pct: number) => {
    store.snapshot = { accounts: [account(pct)] };
    toaster.render();
  };
  return { toaster, notices, store, prefs, see };
}

describe('QuotaToaster', () => {
  it('QUOTA-01 e QUOTA-02: a sequência 70, 79, 81, 83, 96 gera exatamente dois avisos (80 e 95)', () => {
    const p = page(memoryStorage());
    for (const pct of [70, 79]) p.see(pct);
    expect(p.notices).toHaveLength(0);
    p.see(81);
    expect(p.notices).toHaveLength(1);
    expect(p.notices[0].text).toContain('81%');
    p.see(83);
    expect(p.notices).toHaveLength(1);
    p.see(96);
    expect(p.notices).toHaveLength(2);
    expect(p.notices[1].text).toContain('96%');
    expect(p.notices.every((n) => n.level === 'warn')).toBe(true);
  });

  it('QUOTA-17: conta oculta nas preferências não avisa, e reexibida já em 98% é só linha de base', () => {
    const p = page(memoryStorage());
    p.see(70);
    p.prefs.hiddenAccounts = ['conta-a'];
    p.see(85);
    p.see(97);
    expect(p.notices).toHaveLength(0);
    p.prefs.hiddenAccounts = [];
    p.see(98);
    expect(p.notices).toHaveLength(0);
  });

  it('QUOTA-19: opção desligada não avisa nem grava, e religar em 90% é só linha de base', () => {
    const st = memoryStorage();
    const p = page(st);
    p.see(70);
    const writes = st.calls.set;
    p.prefs.quotaAlerts = false;
    p.see(79);
    p.see(85);
    p.see(97);
    expect(p.notices).toHaveLength(0);
    expect(st.calls.set).toBe(writes);
    p.prefs.quotaAlerts = true;
    p.see(90);
    expect(p.notices).toHaveLength(0);
    p.see(96);
    expect(p.notices).toHaveLength(1);
  });

  it("QUOTA-15: conexão 'mock', 'connecting' ou 'closed' não avisa, 'open' avisa", () => {
    for (const connection of ['mock', 'connecting', 'closed']) {
      const p = page(memoryStorage());
      p.see(70);
      p.store.connection = connection;
      p.see(85);
      p.see(97);
      expect(p.notices, connection).toHaveLength(0);
    }
    const p = page(memoryStorage());
    p.see(70);
    p.see(85);
    expect(p.notices).toHaveLength(1);
  });

  it('QUOTA-14: no timelapse não avisa nem grava; ao sair, avisa o que cruzou ao vivo', () => {
    const st = memoryStorage();
    const p = page(st);
    p.see(70);
    const writes = st.calls.set;
    p.store.replaying = true;
    p.see(85);
    p.see(97);
    expect(p.notices).toHaveLength(0);
    expect(st.calls.set).toBe(writes);
    p.store.replaying = false;
    p.see(97);
    expect(p.notices).toHaveLength(1);
    expect(p.notices[0].text).toContain('97%');
  });

  it('QUOTA-04: recarregar a página (nova instância, mesmo armazenamento) não repete o aviso já dado', () => {
    const st = memoryStorage();
    const first = page(st);
    first.see(70);
    first.see(82);
    expect(first.notices).toHaveLength(1);
    const reloaded = page(st);
    reloaded.see(70);
    reloaded.see(82);
    reloaded.see(83);
    expect(reloaded.notices).toHaveLength(0);
    reloaded.see(96);
    expect(reloaded.notices).toHaveLength(1);
  });

  it('QUOTA-04: duas abas com o mesmo armazenamento veem o mesmo cruzamento e só uma avisa', () => {
    const st = memoryStorage();
    const a = page(st);
    const b = page(st);
    a.see(70);
    b.see(70);
    a.see(82);
    b.see(82);
    expect(a.notices.length + b.notices.length).toBe(1);
    a.see(96);
    b.see(96);
    expect(a.notices.length + b.notices.length).toBe(2);
  });

  it('QUOTA-21: getItem e setItem que lançam exceção seguem em memória, um aviso por ciclo', () => {
    const broken = {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('cheio');
      },
    };
    const p = page(broken);
    expect(() => {
      for (const pct of [70, 82, 79, 83]) p.see(pct);
    }).not.toThrow();
    expect(p.notices).toHaveLength(1);
  });

  it('QUOTA-21: JSON corrompido ou de formato inesperado no armazenamento é descartado sem exceção', () => {
    for (const bad of ['{oops', '[1,2]', '"x"', '{"conta-a|fiveHour":{"resetsAt":"x","done":5}}']) {
      const p = page(memoryStorage({ [QUOTA_KEY]: bad }));
      expect(() => {
        p.see(70);
        p.see(82);
      }, bad).not.toThrow();
      expect(p.notices, bad).toHaveLength(1);
    }
  });

  it('QUOTA-21: sem armazenamento (null) segue em memória, um aviso por ciclo', () => {
    const p = page(null);
    for (const pct of [70, 82, 79, 83]) p.see(pct);
    expect(p.notices).toHaveLength(1);
  });

  it('QUOTA-04: o estado do ciclo já está gravado quando o push roda', () => {
    const st = memoryStorage();
    const seen: unknown[] = [];
    const p = page(st, { push: () => seen.push(JSON.parse(st.data.get(QUOTA_KEY) ?? 'null')) });
    p.see(70);
    p.see(82);
    expect(seen).toEqual([{ 'conta-a|fiveHour': { resetsAt: RESET, done: [80] } }]);
  });
});
