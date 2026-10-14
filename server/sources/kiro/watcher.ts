// Observador de sessões ativas do Kiro (~/.kiro/sessions/cli/*.lock e *.json)
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { AgentStatus } from '../../../shared/types';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import { FileTail } from '../tail';
import { parseKiroJsonlLine } from './parser';
import { tr } from '../../../shared/i18n';

export interface KiroWatcherDeps {
  office: Office;
  sessionsDir: string;
  pollMs?: number;
  now?: () => number;
  inDocker?: boolean;
  checkPid?: boolean;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ActiveKiroSession {
  sessionId: string;
  pid: number;
  cwd: string;
  role: string;
  title?: string;
  startedAt: number;
  tail?: FileTail;
  lineCount: number;
}

export class KiroWatcher {
  private readonly office: Office;
  private readonly sessionsDir: string;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly checkPid: boolean;
  private active = new Map<string, ActiveKiroSession>();
  private timer?: NodeJS.Timeout;
  private fsWatcher?: FSWatcher;
  private running = false;

  constructor(deps: KiroWatcherDeps) {
    this.office = deps.office;
    this.sessionsDir = deps.sessionsDir;
    this.pollMs = deps.pollMs ?? 2_000;
    this.now = deps.now ?? Date.now;
    this.checkPid = deps.checkPid ?? !deps.inDocker;
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    if (existsSync(this.sessionsDir)) {
      this.scan();
      try {
        this.fsWatcher = watch(this.sessionsDir, () => this.scan());
      } catch (err) {
        log.warn(tr('Kiro: falha ao criar watcher fs ({0}), usando polling.', [errMsg(err)]));
      }
    } else {
      log.info(tr('Kiro: diretório de sessões não encontrado ({0}), aguardando...', [this.sessionsDir]));
    }

    this.timer = setInterval(() => {
      if (!this.fsWatcher && existsSync(this.sessionsDir)) {
        try {
          this.fsWatcher = watch(this.sessionsDir, () => this.scan());
        } catch {
          // segue no polling
        }
      }
      this.scan();
    }, this.pollMs);
    this.timer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.fsWatcher) {
      try {
        this.fsWatcher.close();
      } catch {
        // ignora
      }
      this.fsWatcher = undefined;
    }
    this.active.clear();
  }

  sessionCount(): number {
    return this.active.size;
  }

  transcriptPathOf(sessionId: string): string | undefined {
    const candidate = join(this.sessionsDir, `${sessionId}.jsonl`);
    return existsSync(candidate) ? candidate : undefined;
  }

  scan(): void {
    if (!existsSync(this.sessionsDir)) return;

    let entries: string[] = [];
    try {
      entries = readdirSync(this.sessionsDir);
    } catch (err) {
      log.warn(tr('Kiro: erro ao listar sessões ({0})', [errMsg(err)]));
      return;
    }

    const currentLiveIds = new Set<string>();

    for (const file of entries) {
      if (!file.endsWith('.lock')) continue;
      const sessionId = file.slice(0, -5);

      const lockPath = join(this.sessionsDir, file);
      const jsonPath = join(this.sessionsDir, `${sessionId}.json`);
      const jsonlPath = join(this.sessionsDir, `${sessionId}.jsonl`);

      if (!existsSync(jsonPath)) continue;

      let pid = 0;
      let startedAt = this.now();
      try {
        const lockContent = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number; started_at?: string };
        if (typeof lockContent.pid === 'number') pid = lockContent.pid;
        if (lockContent.started_at) startedAt = Date.parse(lockContent.started_at) || startedAt;
      } catch {
        continue;
      }

      if (this.checkPid && (!pid || !pidAlive(pid))) {
        continue; // Processo morto
      }

      currentLiveIds.add(sessionId);

      if (this.active.has(sessionId)) {
        continue; // Já rastreado
      }

      // Nova sessão viva detectada
      let cwd = '';
      let title: string | undefined;
      let role = 'Agente Kiro';

      try {
        const meta = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, unknown>;
        cwd = typeof meta.cwd === 'string' ? meta.cwd : '';
        title = typeof meta.title === 'string' ? meta.title : undefined;

        // Tenta descobrir o nome do agente especializado
        const turns = (meta.session_state as Record<string, unknown>)?.conversation_metadata as Record<string, unknown>;
        const userTurns = turns?.user_turn_metadatas as Array<Record<string, unknown>> | undefined;
        const agentId = (userTurns?.[0]?.loop_id as Record<string, unknown>)?.agent_id as Record<string, unknown> | undefined;
        if (typeof agentId?.name === 'string') {
          role = agentId.name.replace(/^kiro_/, '');
        }
      } catch {
        continue;
      }

      if (!cwd) continue;

      const sessionObj: ActiveKiroSession = {
        sessionId,
        pid,
        cwd,
        role,
        title,
        startedAt,
        lineCount: 0,
      };

      this.active.set(sessionId, sessionObj);

      // Adiciona ao Office
      this.office.addMain({
        id: sessionId,
        provider: 'kiro',
        account: '.kiro',
        sessionId,
        cwd,
        role,
        startedAt,
        status: 'working',
      });

      if (title) {
        this.office.applyTranscript(sessionId, {
          title,
          tasks: [],
          stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
        });
      }

      // Inicia leitura do arquivo de streaming .jsonl
      if (existsSync(jsonlPath)) {
        sessionObj.tail = new FileTail(jsonlPath);
      }
    }

    // Processa novas linhas dos tails ativos
    for (const session of this.active.values()) {
      if (!session.tail) continue;
      let res = session.tail.read();
      while (res.lines.length > 0) {
        for (const line of res.lines) {
          session.lineCount++;
          const parsed = parseKiroJsonlLine(line, session.lineCount, this.now());
          if (!parsed) continue;

          if (parsed.activity) {
            this.office.addActivity(session.sessionId, parsed.activity, true, { feed: true });
          }
          if (parsed.status) {
            this.office.setStatus(session.sessionId, parsed.status, parsed.waitingFor);
          }
        }
        if (!res.more) break;
        res = session.tail.read();
      }
    }

    // Encerrar sessões que não estão mais vivas
    for (const [id] of this.active.entries()) {
      if (!currentLiveIds.has(id)) {
        this.active.delete(id);
        this.office.closeMain(id);
      }
    }
  }
}
