// Histórico do terminal do DSH (o HistoryProvider 'dsh', ver sources/source.ts): as conversas recentes de cada
// conta (abertas ou encerradas), listadas dos logs session.v4.jsonl(.zstd) modificados nos últimos 7 dias. O
// resumo de cada um (projeto, título, início, fim) sai decodificando o início (com cache); para abrir a conversa
// resolve() decodifica a sessão inteira para um espelho JSONL em <dataDir>/transcripts/dsh/ (o terminal lê de lá).
// Subagentes (parentSession/origin "subagent") ficam de fora, como os subagentes das outras ferramentas.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecentSession } from '../../../shared/types';
import { errMsg, log } from '../../log';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { DshLogReader, dshHeader, listDshSessions, type DshEvent } from './log';
import { createDshTerminalParser } from './terminal';

export interface DshHistoryAccount {
  id: string;
  /** Pasta do DSH lida por este processo (no Docker, a montada). */
  dir: string;
}

export interface DshHistoryOptions {
  accounts: () => readonly DshHistoryAccount[];
  /** Agente principal da sessão, se ela ainda estiver aberta no escritório. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  /** Pasta dos espelhos decodificados (a mesma da fonte). */
  mirrorDir?: string;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

const SESSION_ID = /^[\w-]{4,80}$/;

interface DshSummary {
  cwd?: string;
  title?: string;
  sub?: boolean;
  firstAt?: number;
  lastAt?: number;
}

/** Decodifica a sessão inteira e devolve os eventos (espelho em memória). Síncrono e só na abertura. */
export function readDshSessionEvents(path: string): DshEvent[] {
  return new DshLogReader(path).read().events;
}

function summarize(events: DshEvent[]): DshSummary {
  const s: DshSummary = {};
  for (const ev of events) {
    if (ev.type === 'session') {
      const h = dshHeader(ev);
      if (h) {
        s.cwd = h.cwd;
        s.sub = !!h.parentSession || h.origin === 'subagent' || (h.delegationDepth ?? 0) > 0;
        s.firstAt = h.createdAt;
      }
    } else if (ev.type === 'session/title' && !s.title) {
      s.title = str(ev.data?.title);
    }
    if (ev.time && (s.lastAt === undefined || ev.time > s.lastAt)) s.lastAt = ev.time;
  }
  return s;
}

export class DshHistory implements HistoryProvider {
  readonly provider = 'dsh' as const;
  private cache = new Map<string, { mtimeMs: number; size: number; summary: DshSummary }>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: DshHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  list(): Promise<RecentSession[]> {
    const now = this.now();
    const out: RecentSession[] = [];
    const keep = new Set<string>();
    for (const acc of this.opts.accounts()) {
      for (const f of listDshSessions(acc.dir)) {
        if (now - f.mtimeMs > this.maxAgeMs) continue;
        const cached = this.cache.get(f.path);
        const summary = cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size ? cached.summary : this.summarizeFile(f.path, f.mtimeMs, f.size);
        keep.add(f.path);
        if (summary.sub) continue; // subagente: não é conversa sua
        const agentId = this.opts.openAgentOf(acc.id, f.sessionId);
        if (!agentId && summary.firstAt === undefined && summary.lastAt === undefined) continue;
        const r: RecentSession = {
          account: acc.id,
          provider: 'dsh',
          sessionId: f.sessionId,
          projectDir: summary.cwd ? encodeCwd(summary.cwd) : f.projectDirName,
          lastAt: summary.lastAt ?? f.mtimeMs,
          size: f.size,
          open: !!agentId,
        };
        if (summary.cwd) r.project = summary.cwd;
        if (summary.title) r.title = summary.title;
        if (summary.firstAt !== undefined) r.firstAt = summary.firstAt;
        if (agentId) r.agentId = agentId;
        out.push(r);
      }
    }
    for (const path of [...this.cache.keys()]) if (!keep.has(path)) this.cache.delete(path);
    out.sort((a, b) => b.lastAt - a.lastAt);
    return Promise.resolve(out.slice(0, this.limit));
  }

  /** Decodifica a sessão toda para o espelho (idempotente quando o arquivo não mudou) e devolve o caminho. */
  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!SESSION_ID.test(sessionId)) return { status: 400, error: 'id de sessão inválido' };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: 'conta desconhecida' };
    const f = listDshSessions(acc.dir).find((s) => s.sessionId === sessionId);
    if (!f) return { status: 404, error: 'sessão não encontrada' };
    if (this.opts.mirrorDir) {
      const mirror = join(this.opts.mirrorDir, `${encodeURIComponent(`${acc.id}:${sessionId}`)}.jsonl`);
      const cached = this.cache.get(f.path);
      const upToDate = cached && cached.mtimeMs === f.mtimeMs && cached.size === f.size && (cached as { mirrored?: boolean }).mirrored;
      if (!upToDate) {
        try {
          const events = readDshSessionEvents(f.path);
          mkdirSync(this.opts.mirrorDir, { recursive: true });
          writeFileSync(mirror, events.map((ev) => JSON.stringify(ev.raw)).join('\n') + '\n');
          this.cache.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, summary: summarize(events), mirrored: true } as never);
        } catch (err) {
          log.warnOnce(`dsh-history:${errMsg(err)}`, `Histórico do DeepSeek Harness: não consegui decodificar a sessão (${errMsg(err)}).`);
          return { status: 404, error: 'sessão ilegível' };
        }
      }
      return { path: mirror, createParser: createDshTerminalParser };
    }
    return { status: 404, error: 'histórico sem espelho configurado' };
  }

  private summarizeFile(path: string, mtimeMs: number, size: number): DshSummary {
    let summary: DshSummary;
    try {
      summary = summarize(readDshSessionEvents(path));
    } catch (err) {
      log.warnOnce(`dsh-history:${errMsg(err)}`, `Histórico do DeepSeek Harness: sessão ilegível (${errMsg(err)}).`);
      summary = {};
    }
    this.cache.set(path, { mtimeMs, size, summary });
    return summary;
  }
}
