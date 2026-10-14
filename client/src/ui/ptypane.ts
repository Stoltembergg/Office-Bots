// Tela do terminal interativo (xterm.js) ligada a um pty do servidor (server/pty/manager.ts): saída pelo SSE
// GET /api/pty/:id/stream (reset | data | exit) e teclas/tamanho por POST. Carregado sob demanda (import
// dinâmico em ui/pty.ts): o xterm só entra quando alguém abre um terminal interativo.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { InputQueues, postPty } from './ptyapi';
import { tr } from '../../../shared/i18n';

const RESIZE_DEBOUNCE_MS = 120;
/** Estado da ligação com o pty, para a barra da janela. */
export type PaneLink = 'live' | 'reconnecting' | 'lost';

export class PtyPane {
  readonly el: HTMLElement;
  private term: Terminal;
  private fit: FitAddon;
  private es: EventSource | null = null;
  private id: string | null = null;
  private exited = false;
  /** O servidor não conhece mais este pty: não adianta mandar teclas. */
  private lost = false;
  private lastNotice = { text: '', at: 0 };
  /** Entrada ainda não enviada, por pty: trocar de aba no meio de um envio não manda teclas ao pty errado. */
  private input = new InputQueues((id, err) => {
    if (this.id === id) this.notice(tr('não foi possível enviar: {0}', [err.message]));
  });
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private ro: ResizeObserver;

  /**
   * `onExit`: o pty terminou. `onLink`: a ligação caiu ou voltou ('lost' = o servidor não conhece mais o pty, por
   * exemplo depois de reiniciar). `onLeave`: F6 (sair do terminal sem fechar a janela).
   */
  constructor(
    private onExit: () => void,
    private onLink: (state: PaneLink) => void = () => undefined,
    private onLeave: () => void = () => undefined,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'ui-pty__screen';
    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Mono', Consolas, Menlo, monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#0a0c12', foreground: '#d5dceb', cursor: '#ffb547', selectionBackground: '#3a4a6b' },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.el);
    // F6 tira o foco do terminal (todas as outras teclas, Tab e Esc inclusive, são do Claude Code).
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.key !== 'F6' || e.ctrlKey || e.metaKey || e.altKey) return true;
      if (e.type === 'keydown') {
        e.preventDefault();
        this.onLeave();
      }
      return false;
    });
    this.term.onData((d) => this.send(d));
    this.term.onResize(({ cols, rows }) => this.scheduleResize(cols, rows));
    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.el);
  }

  get ptyId(): string | null {
    return this.id;
  }

  /** Liga a tela a um pty do servidor (outro pty = tela nova). */
  attach(id: string): void {
    if (this.id === id && this.es) return;
    this.detach();
    this.id = id;
    this.exited = false;
    this.lost = false;
    this.term.reset();
    const es = new EventSource(`/api/pty/${encodeURIComponent(id)}/stream`);
    this.es = es;
    es.addEventListener('reset', (e) => {
      this.onLink('live');
      this.term.reset();
      this.term.write(parse(e));
      this.refit(true);
    });
    es.addEventListener('data', (e) => this.term.write(parse(e)));
    es.addEventListener('exit', (e) => {
      this.exited = true;
      let code = 0;
      try {
        code = (JSON.parse((e as MessageEvent<string>).data) as { code?: number }).code ?? 0;
      } catch {
        // sem código
      }
      this.term.write(`\r\n\x1b[2m[${code ? tr('Claude Code encerrado (código {0})', [code]) : tr('Claude Code encerrado')}]\x1b[0m\r\n`);
      es.close();
      this.onExit();
    });
    // Caiu: o EventSource tenta de novo sozinho; fechado (o servidor respondeu erro, ex.: 404 depois de reiniciar)
    // não volta mais.
    es.addEventListener('error', () => {
      if (this.es !== es || this.exited) return;
      if (es.readyState === EventSource.CLOSED) {
        this.es = null;
        this.lost = true;
        this.onLink('lost');
      } else this.onLink('reconnecting');
    });
  }

  detach(): void {
    this.es?.close();
    this.es = null;
    this.id = null;
  }

  focus(): void {
    this.term.focus();
  }

  /** Reajusta colunas/linhas ao tamanho do elemento (`force` reenvia ao servidor mesmo sem mudança). */
  refit(force = false): void {
    if (!this.el.isConnected || this.el.clientWidth < 40 || this.el.clientHeight < 40) return;
    const before = `${this.term.cols}x${this.term.rows}`;
    try {
      this.fit.fit();
    } catch {
      return;
    }
    if (force && before === `${this.term.cols}x${this.term.rows}`) this.scheduleResize(this.term.cols, this.term.rows);
  }

  private send(data: string): void {
    if (this.id && !this.exited && !this.lost) this.input.send(this.id, data);
  }

  /** Linha de aviso na tela (fora do que o Claude Code desenha). */
  private notice(text: string): void {
    // Tecla a tecla com o servidor fora do ar: um aviso só.
    const now = Date.now();
    if (text === this.lastNotice.text && now - this.lastNotice.at < 3000) return;
    this.lastNotice = { text, at: now };
    this.term.write(`\r\n\x1b[33m[${text}]\x1b[0m\r\n`);
  }

  private scheduleResize(cols: number, rows: number): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (this.id && !this.exited) void postPty(`/api/pty/${encodeURIComponent(this.id)}/resize`, { cols, rows }).catch(() => undefined);
    }, RESIZE_DEBOUNCE_MS);
  }
}

function parse(e: Event): string {
  try {
    const v = JSON.parse((e as MessageEvent<string>).data) as unknown;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}
