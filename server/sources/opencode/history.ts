// Histórico do terminal do OpenCode (o HistoryProvider 'opencode', ver sources/source.ts): as conversas recentes
// de cada conta (abertas ou encerradas), listadas do session_v2 (janela de 7 dias, sem subagentes). Para abrir a
// conversa, resolve() exporta as mensagens (session_message) da sessão para um espelho JSONL em
// <dataDir>/transcripts/opencode/ (o terminal lê de lá).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RecentSession } from '../../../shared/types';
import { errMsg, log } from '../../log';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { createOpencodeTerminalParser } from './terminal';

export interface OpencodeHistoryAccount {
  id: string;
  /** Pasta de dados do OpenCode lida por este processo (no Docker, a montada). */
  dir: string;
}

export interface OpencodeHistoryOptions {
  accounts: () => readonly OpencodeHistoryAccount[];
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  /** Pasta dos espelhos (a mesma da fonte). */
  mirrorDir?: string;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

interface HistRow {
  id: string;
  parent_id: string | null;
  title: string | null;
  directory: string | null;
  time_created: number;
  time_updated: number;
  size: number;
}

const SESSION_ID = /^[\w-]{4,80}$/;

/** Abre o banco da conta só para leitura; undefined = erro (já logado). */
function openDb(dir: string): DatabaseSync | undefined {
  try {
    return new DatabaseSync(join(dir, 'opencode.db'), { readOnly: true });
  } catch (err) {
    log.warnOnce(`opencode-history:${errMsg(err)}`, `Histórico do OpenCode: não consegui abrir o banco (${errMsg(err)}).`);
    return undefined;
  }
}

export class OpencodeHistory implements HistoryProvider {
  readonly provider = 'opencode' as const;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: OpencodeHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  list(): Promise<RecentSession[]> {
    const cutoff = this.now() - this.maxAgeMs;
    const out: RecentSession[] = [];
    for (const acc of this.opts.accounts()) {
      const db = openDb(acc.dir);
      if (!db) continue;
      try {
        const rows = db
          .prepare(
            `SELECT s.id, s.parent_id, s.title, s.directory, s.time_created, s.time_updated,
                    (SELECT LENGTH(GROUP_CONCAT(data, '')) FROM session_message m WHERE m.session_id = s.id) AS size
               FROM session_v2 s
              WHERE s.parent_id IS NULL AND s.time_updated >= ?
              ORDER BY s.time_updated DESC
              LIMIT ?`,
          )
          .all(cutoff, this.limit) as unknown as HistRow[];
        for (const r of rows) {
          if (!r.directory) continue;
          const agentId = this.opts.openAgentOf(acc.id, r.id);
          const item: RecentSession = {
            account: acc.id,
            provider: 'opencode',
            sessionId: r.id,
            projectDir: encodeCwd(r.directory),
            lastAt: r.time_updated,
            size: r.size ?? 0,
            open: !!agentId,
          };
          item.project = r.directory;
          if (r.title) item.title = r.title;
          item.firstAt = r.time_created;
          if (agentId) item.agentId = agentId;
          out.push(item);
        }
      } catch (err) {
        log.warnOnce(`opencode-history-list:${errMsg(err)}`, `Histórico do OpenCode: falha ao listar (${errMsg(err)}).`);
      } finally {
        try {
          db.close();
        } catch {
          // já fechado
        }
      }
    }
    out.sort((a, b) => b.lastAt - a.lastAt);
    return Promise.resolve(out.slice(0, this.limit));
  }

  /** Exporta a conversa da sessão para o espelho (se ainda não exportada) e devolve o caminho. */
  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!SESSION_ID.test(sessionId)) return { status: 400, error: 'id de sessão inválido' };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: 'conta desconhecida' };
    if (!this.opts.mirrorDir) return { status: 404, error: 'histórico sem espelho configurado' };
    const db = openDb(acc.dir);
    if (!db) return { status: 404, error: 'banco ilegível' };
    try {
      const rows = db
        .prepare(`SELECT seq, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq`)
        .all(sessionId) as unknown as Array<{ seq: number; type: string; time_created: number; data: string }>;
      if (!rows.length) return { status: 404, error: 'sessão não encontrada' };
      const lines: string[] = [];
      for (const r of rows) {
        let data: unknown = null;
        try {
          data = JSON.parse(r.data);
        } catch {
          continue;
        }
        lines.push(JSON.stringify({ seq: r.seq, type: r.type, at: r.time_created, data }));
      }
      const mirror = join(this.opts.mirrorDir, `${encodeURIComponent(`${acc.id}:${sessionId}`)}.jsonl`);
      mkdirSync(this.opts.mirrorDir, { recursive: true });
      writeFileSync(mirror, lines.join('\n') + '\n');
      return { path: mirror, createParser: createOpencodeTerminalParser };
    } catch (err) {
      log.warnOnce(`opencode-history-resolve:${errMsg(err)}`, `Histórico do OpenCode: falha ao abrir a sessão (${errMsg(err)}).`);
      return { status: 500 as 404, error: 'sessão ilegível' };
    } finally {
      try {
        db.close();
      } catch {
        // já fechado
      }
    }
  }
}
