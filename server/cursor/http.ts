// Eventos dos hooks do Cursor (mod/habblaud-cursor/hook.mjs, que npm run cursor:install acrescenta em
// ~/.cursor/hooks.json): chegam aqui e vão para a fonte do Cursor (CursorLive). Só observam (nada volta para o
// Cursor) e só valem vindos do próprio computador: a trava é a mesma dos eventos do Codex (http/app.ts).
//
//   POST /api/cursor/events   (hook)   {cursorDir?, event: <stdin do hook, textos cortados>}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import type { CursorLive } from '../sources/cursor/source';
import { tr } from '../../shared/i18n';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/** Corpo de POST /api/cursor/events. Sem `event` (objeto com hook_event_name): 400. */
export function parseCursorEvent(raw: unknown): { event: Rec; cursorDir?: string } {
  const r = rec(raw);
  const event = rec(r?.event);
  if (!r || !event || typeof event.hook_event_name !== 'string') throw new HttpError(400, 'esperado {cursorDir?, event: <JSON do hook do Cursor>}');
  const dir = typeof r.cursorDir === 'string' && r.cursorDir.trim() && r.cursorDir.length <= 4_096 ? r.cursorDir.trim() : undefined;
  return dir ? { event, cursorDir: dir } : { event };
}

/** Trata POST /api/cursor/events (método e Host já conferidos). `ok` = a fonte do Cursor aproveitou o evento. */
export async function handleCursorEvent(req: IncomingMessage, res: ServerResponse, live: CursorLive | undefined): Promise<void> {
  const body = parseCursorEvent(await readJson(req));
  let ok = false;
  if (live) {
    try {
      ok = live.applyHookEvent(body.event, body.cursorDir) === true;
    } catch (err) {
      log.warnOnce(`cursor-event:${errMsg(err)}`, tr('Eventos do Cursor: falha ao aplicar um evento ({0}).', [errMsg(err)]));
    }
  }
  sendJson(res, 200, { ok });
}
