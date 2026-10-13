// Liga a decisão pura (quota-alert.ts) à interface: guardas, armazenamento e envio dos avisos.
// Sem DOM: o armazenamento e o `push` são injetados (testável em node).
import type { Notice } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { safeLocalStorage } from './prefs';
import { evaluateQuota, QUOTA_KEY, sanitizeQuotaState, type QuotaLast, type QuotaState } from './quota-alert';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Avisa quando uma janela de uso de uma conta cruza 80% e 95%, uma vez por ciclo (neste navegador). */
export class QuotaToaster implements UiComponent {
  /** Último percentual válido visto por esta página, por conta e janela. */
  private last: QuotaLast = {};
  /** Estado dos ciclos quando não há `localStorage` utilizável. */
  private memory: QuotaState = {};

  constructor(
    private ctx: Pick<UiContext, 'store' | 'prefs' | 'now'>,
    private push: (n: Notice) => void,
    private storage: StorageLike | null = safeLocalStorage(),
  ) {}

  render(): void {
    const { store, prefs } = this.ctx;
    // Opção desligada: nada de estado, e religar começa uma linha de base nova (QUOTA-19).
    if (!prefs.quotaAlerts) {
      this.last = {};
      return;
    }
    // Sem servidor real (inclui o ?mock=1) ou no timelapse, os números não valem como atuais (QUOTA-14, QUOTA-15).
    if (store.connection !== 'open' || store.replaying) return;
    const snap = store.snapshot;
    if (!snap) return;
    const r = evaluateQuota({ accounts: snap.accounts, now: this.ctx.now(), hidden: prefs.hiddenAccounts, state: this.read(), last: this.last });
    this.last = r.last;
    // Grava antes de empurrar: a outra aba que ler agora já enxerga o aviso como dado.
    if (r.changed) this.write(r.state);
    for (const n of r.notices) this.push(n);
  }

  private read(): QuotaState {
    if (!this.storage) return this.memory;
    try {
      const raw = this.storage.getItem(QUOTA_KEY);
      return raw ? sanitizeQuotaState(JSON.parse(raw)) : {};
    } catch {
      // Armazenamento bloqueado ou JSON corrompido: segue com o que esta página lembra.
      return this.memory;
    }
  }

  private write(state: QuotaState): void {
    this.memory = state;
    try {
      this.storage?.setItem(QUOTA_KEY, JSON.stringify(state));
    } catch {
      // Cheio ou bloqueado: vale só nesta página.
    }
  }
}
