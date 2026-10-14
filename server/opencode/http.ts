// Rota dos eventos do plugin do OpenCode (POST /api/opencode/events, plugin ~/.config/opencode/plugins/habblaud.js).
//
// O plugin roda NATIVO no Windows (é ele que consegue ler o SQLite do OpenCode, coisa que o WSL não consegue) e
// escreve os arquivos que a fonte lê. Estes eventos são o complemento ao vivo: garantem que a presença e o status
// apareçam na hora, sem esperar o polling de ~1 s da fonte.
//
// Diferente do Codex (que tem um formato de hook estável e próprio), aqui o corpo é validado apenas o suficiente:
// `hook_event_name` obrigatório e o resto opcional. O que o servidor faz com o evento é pequeno — marcar a sessão
// como presente e, nos casos de turn lifecycle, ajustar o status — justamente porque a verdade mora nos arquivos.
//
// Segurança: os eventos só observam (a resposta nunca volta para a sessão) e, como os do Codex, só valem vindos do
// próprio computador — o guard (http/guard.ts) confere o Host e o transporte local antes de chegar aqui.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import type { AccountEntry } from '../accounts/service';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';

type Rec = Record<string, unknown>;

export interface OpenCodeHookEvent {
  /** Pasta de dados que o plugin gravou (no host). */
  dataDir?: string;
  /** O evento (hook_event_name, session_id, ...). */
  event: Rec;
}

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

/** Corpo de POST /api/opencode/events. Sem `event.hook_event_name`: 400. */
export function parseOpenCodeEvent(raw: unknown): OpenCodeHookEvent {
  const r = rec(raw);
  const event = rec(r?.event);
  if (!r || !event || typeof event.hook_event_name !== 'string') {
    throw new HttpError(400, 'esperado {dataDir?, event: {hook_event_name, ...}}');
  }
  const out: OpenCodeHookEvent = { event };
  const dataDir = shortStr(r.dataDir, 4_096);
  if (dataDir) out.dataDir = dataDir;
  return out;
}

/**
 * Conta de um evento: pela pasta de dados que o plugin mandou.
 *
 * O plugin roda NATIVO NO WINDOWS, então manda o caminho Windows (C:\Users\...); dentro do container a conta
 * tem o caminho do host (/mnt/c/Users/...). O casamento por caminho exato falha, então: caminho igual > igual
 * pelo último segmento ("habblaud") > única conta do OpenCode (inequívoco quando há só uma).
 */
export function openCodeAccountOf(entries: readonly AccountEntry[], dataDir: string | undefined): string | undefined {
  if (!dataDir) return undefined;
  const norm = (v: string) => resolve(v).replace(/\\/g, "/").toLowerCase();
  const incoming = norm(dataDir);
  if (!isAbsolute(dataDir)) {
    // Caminho relativo (WSL): o casamento por segmento resolve.
  }
  const exact = entries.find((x) => norm(x.detected.configDir) === incoming || norm(x.dir) === incoming);
  if (exact) return exact.id;
  const tail = incoming.split("/").filter(Boolean).pop();
  if (tail) {
    const byTail = entries.filter((x) => {
      const a = norm(x.detected.configDir).split("/").filter(Boolean).pop();
      const b = norm(x.dir).split("/").filter(Boolean).pop();
      return a === tail || b === tail;
    });
    if (byTail.length === 1) return byTail[0].id;
  }
  return entries.length === 1 ? entries[0].id : undefined;
}

/** O que a fonte precisa saber quando chega um evento. */
export interface OpenCodeLiveEvent {
  /** Sessão que o evento é sobre. */
  sessionId: string;
  /** 'working' | 'idle' | undefined (o evento não muda o status). */
  status?: 'working' | 'idle';
  /** Epoch ms do evento. */
  at: number;
}

/**
 * Converte o evento do plugin no mínimo que a fonte usa. Só o turn lifecycle muda o status; o resto é presença.
 */
export function openCodeLiveEventOf(event: Rec, now: number): OpenCodeLiveEvent | undefined {
  const sessionId = shortStr(event.session_id, 200);
  if (!sessionId) return undefined;
  const name = event.hook_event_name;
  let status: 'working' | 'idle' | undefined;
  switch (name) {
    case 'SessionStart':
    case 'MessageUpdated':
    case 'PostToolUse':
      status = 'working';
      break;
    case 'Stop':
      status = 'idle';
      break;
    default:
      status = undefined;
  }
  return { sessionId, status, at: now };
}

/** Trata POST /api/opencode/events (método e Host já conferidos). `ok` = a fonte aproveitou o evento. */
export async function handleOpenCodeEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    /** Aplica o evento na fonte (presença/status). Ausente = ninguém do OpenCode ligado. */
    apply?: (account: string | undefined, ev: OpenCodeLiveEvent) => boolean;
    entries: () => readonly AccountEntry[];
    now?: () => number;
  },
): Promise<void> {
  const body = parseOpenCodeEvent(await readJson(req));
  let ok = false;
  const ev = openCodeLiveEventOf(body.event, (deps.now ?? Date.now)());
  if (ev && deps.apply) {
    try {
      ok = deps.apply(openCodeAccountOf(deps.entries(), body.dataDir), ev) === true;
    } catch (err) {
      log.warnOnce(`opencode-event:${errMsg(err)}`, `Eventos do OpenCode: falha ao aplicar um evento (${errMsg(err)}).`);
    }
  }
  sendJson(res, 200, { ok });
}