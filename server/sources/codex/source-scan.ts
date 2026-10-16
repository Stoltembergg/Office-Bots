// Leitura de um rollout ao abrir a sessão (source.ts): a fronteira de turno da varredura reversa, o horário da última
// linha lida e o começo de um rollout grande, lido em stream depois, em segundo plano.
import { createReadStream } from 'node:fs';
import type { Activity } from '../../../shared/types';
import { LineBuffer, warnOversizedLine } from '../tail';
import { isTurnBoundary, lineTimestamp } from './reader';
import { createCodexState, parseRolloutLine, type CodexState } from './rollout';

/**
 * Fronteira de turno para a varredura reversa, mas só depois de juntar `minBytes` do fim: as atividades recentes e o
 * último token_count/rate_limits vêm junto, como na janela fixa de antes, mesmo com o turno recém-fechado.
 */
export function boundaryAfter(minBytes: number): (line: string) => boolean {
  let bytes = 0;
  return (line) => {
    bytes += Buffer.byteLength(line) + 1;
    return bytes >= minBytes && isTurnBoundary(line);
  };
}

/** `timestamp` da última linha que tiver um (as linhas vêm na ordem do arquivo). */
export function lastLineAt(lines: string[]): number | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lineTimestamp(lines[i]);
    if (at !== undefined) return at;
  }
  return undefined;
}

/**
 * Lê em stream (sem travar o event loop) os bytes [0, end) de um rollout: os números, o título e as últimas
 * `keep` atividades (distintas) anteriores à varredura feita ao abrir a sessão. `now` = o relógio da fonte (a hora das
 * linhas sem `timestamp`).
 */
export async function scanPrefix(path: string, end: number, idPrefix: string, keep: number, now: number): Promise<{ state: CodexState; activities: Activity[] }> {
  const state = createCodexState();
  if (end <= 0) return { state, activities: [] };
  const ctx = { idPrefix, now, activities: keep > 0 };
  // Por id, na ordem de chegada: a mesma chamada em duas linhas (function_call e o CommandExecution de mesmo call_id)
  // fica uma entrada só, como no Office.addActivity: com `replace`, a versão mais nova no lugar (e no horário) da
  // primeira; sem ele, fica a primeira.
  const byId = new Map<string, Activity>();
  const take = (line: string) => {
    const r = parseRolloutLine(state, line, ctx);
    for (const a of r.activities) {
      const old = byId.get(a.activity.id);
      if (!old) byId.set(a.activity.id, a.activity);
      else if (a.replace) byId.set(a.activity.id, { ...a.activity, at: old.at });
    }
    if (byId.size > keep * 2) for (const id of [...byId.keys()].slice(0, byId.size - keep)) byId.delete(id);
  };
  const pending = new LineBuffer();
  let discarded = 0;
  const stream = createReadStream(path, { start: 0, end: end - 1, highWaterMark: 1024 * 1024 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const fed = pending.push(chunk);
    discarded += fed.discarded;
    for (const buf of fed.lines) {
      const line = buf.toString('utf8');
      if (line) take(line);
    }
  }
  const rest = pending.flush();
  if (rest?.length) take(rest.toString('utf8'));
  if (discarded) warnOversizedLine(path);
  return { state, activities: [...byId.values()].slice(-keep) };
}
