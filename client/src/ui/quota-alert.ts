// Aviso de limite de uso: decide, para cada conta e janela (sessão de 5 h ou semana), se um limiar (80% e 95%)
// foi cruzado agora e ainda não foi avisado neste ciclo. Funções puras: sem DOM, relógio nem armazenamento
// (o componente quota-watch.ts cuida do armazenamento e do push). Testes em ui/quota-alert.test.ts.
import { tr } from '../../../shared/i18n';

export type QuotaThreshold = 80 | 95;
export type QuotaWindowKey = 'fiveHour' | 'sevenDay';

/** Limiares avisados, em ordem crescente. */
export const QUOTA_THRESHOLDS = [80, 95] as const;
/** Diferença de `resetsAt` até a qual duas leituras ainda são o mesmo ciclo. */
export const CYCLE_TOLERANCE_MS = 10 * 60_000;
/** Chave do `localStorage` com o estado dos ciclos. */
export const QUOTA_KEY = 'habblaud:quota-alerts';

/** Um ciclo gravado: o resetsAt que o identifica e os limiares já tratados (avisados ou só registrados). */
export interface QuotaCycle {
  resetsAt: number;
  done: QuotaThreshold[];
}
/** `localStorage` `habblaud:quota-alerts`: chave `${accountId}|${window}`. No máximo 40 entradas. */
export type QuotaState = Record<string, QuotaCycle>;
/** Só em memória: último percentual válido visto por esta página, por `${accountId}|${window}`. */
export type QuotaLast = Record<string, number>;

export interface QuotaSample {
  pct: number;
  resetsAt: number | undefined;
  prevPct: number | undefined;
  cycle: QuotaCycle | undefined;
}
export interface QuotaDecision {
  notify: QuotaThreshold | null;
  cycle: QuotaCycle | undefined;
  /** Leitura de ciclo mais antigo que o gravado: ignorada, não atualiza a leitura anterior. */
  skip: boolean;
}

/** Decide se esta leitura cruzou um limiar ainda não tratado no ciclo. Pura: não muta a entrada. */
export function decideQuota(s: QuotaSample): QuotaDecision {
  const { pct, resetsAt, prevPct, cycle } = s;
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return { notify: null, cycle, skip: false };
  const fresh = !cycle || resetsAt - cycle.resetsAt > CYCLE_TOLERANCE_MS;
  if (!fresh && cycle.resetsAt - resetsAt > CYCLE_TOLERANCE_MS) return { notify: null, cycle, skip: true };
  const base: QuotaCycle = fresh ? { resetsAt, done: [] } : cycle;
  const reached = QUOTA_THRESHOLDS.filter((t) => pct >= t && !base.done.includes(t));
  const next: QuotaCycle = reached.length === 0 ? base : { resetsAt: base.resetsAt, done: [...base.done, ...reached] };
  const top = reached.length > 0 ? reached[reached.length - 1] : undefined;
  const notify = top !== undefined && !fresh && prevPct !== undefined && prevPct < top ? top : null;
  return { notify, cycle: next, skip: false };
}

/** O texto do aviso: `label` é a conta, `pct` o percentual real lido, `reset` o reinício de `formatResetAt`. */
export function quotaNoticeText(label: string, key: QuotaWindowKey, threshold: QuotaThreshold, pct: number, reset: string): string {
  if (threshold === 95) {
    return key === 'fiveHour'
      ? tr('🚨 {0}: perto do limite, {1}% da sessão de 5 h usados (reinicia {2})', [label, pct, reset])
      : tr('🚨 {0}: perto do limite, {1}% da semana usados (reinicia {2})', [label, pct, reset]);
  }
  return key === 'fiveHour'
    ? tr('⚠️ {0}: {1}% da sessão de 5 h usados (reinicia {2})', [label, pct, reset])
    : tr('⚠️ {0}: {1}% da semana usados (reinicia {2})', [label, pct, reset]);
}
