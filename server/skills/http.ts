// Rotas da biblioteca de skills (/api/skills): inventário automático (só leitura: nomes, descrições,
// presença) e instalação de uma skill noutra ferramenta (cópia da pasta, com trava local).
//
//   GET  /api/skills            inventário (skills, MCPs, memória) — aberto, como o snapshot
//   POST /api/skills/install    {name, from: {provider, accountId}, toProvider} — só pelo próprio
//                              computador (age sobre os arquivos dele, como as permissões)
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import type { Provider, SkillsInventory } from '../../shared/types';
import type { AccountsService } from '../accounts/service';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg } from '../log';
import {
  buildInventory,
  installSkill,
  parseHostFacts,
  parseSkillsRoots,
  validSkillName,
  writableSkillsDirs,
  type HostFacts,
  type SkillAccount,
  type SkillsRoot,
  type SkillsScan,
} from './inventory';

export interface SkillsServiceOptions {
  accounts: AccountsService;
  home: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Segundos de cache do inventário (novas skills aparecem sozinhas depois disso). */
  cacheSecs?: number;
}

const PROVIDERS: Provider[] = ['claude', 'codex', 'opencode', 'dsh'];

function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as string[]).includes(v);
}

/** Serviço da biblioteca: inventário com cache curto + instalação com trava de escrita. */
export class SkillsService {
  private cache: { at: number; scan: SkillsScan } | null = null;
  private readonly now: () => number;
  private readonly cacheMs: number;
  readonly extraRoots: SkillsRoot[];
  private readonly hostFacts: HostFacts;

  constructor(private readonly opts: SkillsServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.cacheMs = (opts.cacheSecs ?? 30) * 1000;
    const env = opts.env ?? process.env;
    this.extraRoots = parseSkillsRoots(env.HABBLAUD_SKILLS_DIRS);
    this.hostFacts = parseHostFacts(env.HABBLAUD_HOST_FACTS);
  }

  private skillAccounts(): SkillAccount[] {
    return this.opts.accounts.allEntries().map((e) => ({ provider: e.provider, accountId: e.id, accountName: e.detected.name, dir: e.dir }));
  }

  /** Inventário interno (com pastas), com cache. */
  scan(): SkillsScan {    const now = this.now();
    if (this.cache && now - this.cache.at < this.cacheMs) return this.cache.scan;
    const scan = buildInventory(this.skillAccounts(), { home: this.opts.home, extraRoots: this.extraRoots, hostFacts: this.hostFacts, now: this.now });
    this.cache = { at: now, scan };
    return scan;
  }

  /** Inventário para o protocolo (sem pastas locais). */
  inventory(): SkillsInventory {
    const scan = this.scan();
    return {
      skills: scan.skills.map(({ dir: _dir, ...rest }) => rest),
      mcp: scan.mcp,
      memory: scan.memory,
      generatedAt: scan.generatedAt,
    };
  }

  refresh(): SkillsInventory {
    this.cache = null;
    return this.inventory();
  }

  install(body: unknown): { ok: true; name: string; from: string; to: string } {
    const b = (body ?? {}) as { name?: unknown; from?: { provider?: unknown; accountId?: unknown }; toProvider?: unknown };
    const name = typeof b.name === 'string' ? b.name : '';
    const fromProvider = b.from?.provider;
    const fromAccount = typeof b.from?.accountId === 'string' ? b.from.accountId : '';
    const toProvider = b.toProvider;
    if (!validSkillName(name) || !isProvider(fromProvider) || !isProvider(toProvider)) throw new HttpError(400, 'esperado {name, from: {provider, accountId}, toProvider}');
    if (fromProvider === toProvider) throw new HttpError(400, 'origem e destino são a mesma ferramenta');
    const inv = this.scan();
    const src = inv.skills.find((s) => s.name === name && s.provider === fromProvider && (s.accountId === fromAccount || !fromAccount));
    if (!src) throw new HttpError(404, 'skill não encontrada no inventário');
    const toDirs = writableSkillsDirs(this.skillAccounts(), toProvider);
    const toDir = toDirs[0];
    if (!toDir) throw new HttpError(400, 'ferramenta de destino sem pasta visível');
    try {
      const r = installSkill(inv.skills, { name: src.name, fromDir: dirname(src.dir), toDir });
      this.cache = null;
      return r;
    } catch (err) {
      const msg = errMsg(err);
      if (/já existe/.test(msg)) throw new HttpError(409, msg);
      if (/EROFS|EACCES|EPERM/i.test(msg)) throw new HttpError(403, 'pasta somente leitura (no Docker, instale pela ferramenta ou rode o Habblaud em modo Node)');
      throw new HttpError(400, msg);
    }
  }
}

export function createSkillsRoutes(svc: SkillsService): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  return (req, res, path) => {
    const method = req.method ?? 'GET';
    try {
      if (path === '/api/skills') {
        if (method !== 'GET') {
          res.setHeader('Allow', 'GET');
          sendJson(res, 405, { error: 'método não permitido' });
          return;
        }
        sendJson(res, 200, svc.inventory());
        return;
      }
      if (path === '/api/skills/install') {
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST');
          sendJson(res, 405, { error: 'método não permitido' });
          return;
        }
        readJson(req).then(
          (body) => {
            try {
              sendJson(res, 200, svc.install(body));
            } catch (err) {
              if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
              else sendJson(res, 500, { error: 'erro interno' });
            }
          },
          (err) => {
            if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
            else sendJson(res, 400, { error: 'corpo inválido' });
          },
        );
        return;
      }
      sendJson(res, 404, { error: 'rota desconhecida' });
    } catch (err) {
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
      else sendJson(res, 500, { error: 'erro interno' });
    }
  };
}
