// Fonte de agentes do Cursor (AgentSource 'cursor', ver sources/source.ts): observa os chats de ~/.cursor/chats.
//
// Presença: o `meta.json` de cada chat (e o mtime do store.db, sem abrir o SQLite) diz a última atividade; chat
// com atividade nos últimos CURSOR_RECENT_MS está "aberto". Sem atividade na janela = fechado, com a mesma folga de
// 1,5 s das outras fontes. 'working' só na janela quente (CURSOR_WORKING_MS); presente e parado = 'idle'.
// MVP: sem subagentes (isSubagent fica de fora), sem cwd não há sala, sem transcript (o formato é SQLite) e uma
// conta só (.cursor), mesmo com várias pastas.
import type { SourceInfo } from '../../../shared/types';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { detectCursorAccount } from './accounts';
import { isCursorPresent, isCursorWorking, listCursorChats, type CursorChatMeta } from './files';

const MAIN_ROLE = 'Agente principal (Cursor)';
/** Tempo que o chat precisa ficar ausente para ser dado como encerrado. */
const CLOSE_AFTER_MISSING_MS = 1_500;

export interface CursorSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas do Cursor (com `chats/`) lidas por este processo. */
  roots: string[];
  now?: () => number;
  pollMs?: number;
}

interface ChatTracker {
  key: string;
  chatId: string;
  inOffice: boolean;
  missingSince?: number;
}

export class CursorSource implements AgentSource {
  readonly provider = 'cursor' as const;
  private entry: AccountEntry | undefined;
  private chats = new Map<string, ChatTracker>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: CursorSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.register();
  }

  private register(): void {
    const root = this.opts.roots[0];
    if (!root) {
      this.opts.accounts.setProviderAccounts('cursor', []);
      return;
    }
    const others = this.opts.accounts.entries().concat(this.opts.accounts.entriesOf('codex'));
    const detected = detectCursorAccount(root, { taken: { colors: others.map((e) => e.detected.color) } });
    this.entry = this.opts.accounts.setProviderAccounts('cursor', [{ dir: root, detected }])[0];
  }

  /** Contas do Cursor (id final, no AccountsService). */
  accountEntries(): readonly AccountEntry[] {
    return this.entry ? [this.entry] : [];
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 2_000);
    this.timer.unref?.();
  }

  /** Reconstrói os chats abertos sem gerar avisos. Síncrono e curto. */
  boot(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sources(): SourceInfo[] {
    if (!this.entry) return [];
    let sessions = 0;
    for (const t of this.chats.values()) if (t.inOffice) sessions++;
    return [{ label: this.entry.id, provider: 'cursor', path: this.entry.detected.configDir, sessions, ok: true }];
  }

  /** O Cursor guarda a conversa em SQLite (store.db): sem transcript para o terminal. */
  transcriptPathOf(): undefined {
    return undefined;
  }

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`cursor-poll:${errMsg(err)}`, `Cursor: falha no ciclo de leitura: ${errMsg(err)}`);
    }
  }

  poll(boot = false): void {
    if (!this.entry) return;
    const now = this.now();
    const office = this.opts.office;
    const present = new Map<string, CursorChatMeta>();
    for (const root of this.opts.roots) {
      for (const meta of listCursorChats(root, now)) {
        if (meta.isSubagent || !meta.cwd || !isCursorPresent(meta, now)) continue;
        present.set(meta.chatId, meta);
      }
    }
    for (const [chatId, meta] of present) {
      const key = `${this.entry.id}:${chatId}`;
      let t = this.chats.get(chatId);
      if (!t) {
        t = { key, chatId, inOffice: false };
        this.chats.set(chatId, t);
      }
      delete t.missingSince;
      if (t.inOffice && !office.has(key)) t.inOffice = false; // saiu do escritório (graça encerrada)
      this.sync(t, meta, now);
    }
    for (const [chatId, t] of [...this.chats]) {
      if (present.has(chatId)) continue;
      t.missingSince ??= now;
      if (!boot && now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      if (t.inOffice) office.closeMain(t.key);
      this.chats.delete(chatId);
    }
  }

  private sync(t: ChatTracker, meta: CursorChatMeta, now: number): void {
    const office = this.opts.office;
    const status = isCursorWorking(meta, now) ? 'working' : 'idle';
    if (!t.inOffice) {
      office.addMain({
        id: t.key,
        provider: 'cursor',
        account: this.entry!.id,
        sessionId: t.chatId,
        cwd: meta.cwd!,
        role: MAIN_ROLE,
        startedAt: meta.updatedAtMs,
        status,
      });
      t.inOffice = office.has(t.key);
      if (!t.inOffice) return;
    }
    office.setStatus(t.key, status);
    office.applyTranscript(t.key, {
      title: meta.title,
      tasks: [],
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      lastAt: Math.max(meta.updatedAtMs, meta.storeMtimeMs ?? 0),
    });
  }
}
