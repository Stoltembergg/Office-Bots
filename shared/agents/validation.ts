import type { AgentEvent } from './contracts';
export const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
export const exactKeys = (x: Record<string, unknown>, allowed: readonly string[]) => Object.keys(x).every(k => allowed.includes(k));
export const nonempty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
export function isAgentEvent(x: unknown): x is AgentEvent {
  if (!record(x) || !exactKeys(x, ['schemaVersion', 'origin', 'sessionId', 'runId', 'seq', 'at', 'type', 'payload'])
    || x.schemaVersion !== 1 || x.origin !== 'managed-pi' || !nonempty(x.sessionId) || !nonempty(x.runId)
    || !Number.isSafeInteger(x.seq) || (x.seq as number) < 1 || !nonempty(x.at) || !Number.isFinite(Date.parse(x.at)) || !record(x.payload)) return false;
  const p = x.payload;
  switch (x.type) {
    case 'message-start': return exactKeys(p, ['messageId']) && nonempty(p.messageId);
    case 'text-delta': return exactKeys(p, ['text']) && typeof p.text === 'string';
    case 'message-end': return exactKeys(p, ['outcome']) && ['completed', 'cancelled', 'error'].includes(p.outcome as string);
    case 'state': return exactKeys(p, ['state']) && ['running', 'idle', 'error'].includes(p.state as string);
    case 'error': return exactKeys(p, ['code']) && ['unavailable', 'runtime-failed'].includes(p.code as string);
    case 'usage': return exactKeys(p, ['input', 'output', 'cacheRead', 'cacheWrite']) && Object.keys(p).length > 0
      && Object.values(p).every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
    default: return false;
  }
}
