import path from 'node:path';
import { exactKeys, nonempty, record } from '../../../shared/agents/validation';
import type { RuntimeSessionConfig } from '../runtime';
import type { PromptInput } from '../../../shared/agents/contracts';
export type WorkerCode = 'invalid' | 'unavailable' | 'busy' | 'cancelled' | 'runtime-failed';
export const codes: readonly WorkerCode[] = ['invalid', 'unavailable', 'busy', 'cancelled', 'runtime-failed'];
export type Command = { version: 1; id: string } & (
  | { type: 'create'; config: RuntimeSessionConfig }
  | { type: 'prompt'; runtimeSessionId: string; runId: string; input: PromptInput }
  | { type: 'cancel' | 'close'; runtimeSessionId: string }
);
export function isCommand(x: unknown): x is Command {
  if (!record(x) || x.version !== 1 || !nonempty(x.id)) return false;
  if (x.type === 'create') {
    if (!exactKeys(x, ['version', 'id', 'type', 'config']) || !record(x.config)) return false;
    const c = x.config, s = c.selection;
    return exactKeys(c, ['id', 'agentId', 'projectId', 'cwd', 'selection', 'instructions'])
      && nonempty(c.id) && nonempty(c.agentId) && nonempty(c.projectId) && nonempty(c.cwd) && path.isAbsolute(c.cwd)
      && (c.instructions === undefined || typeof c.instructions === 'string') && record(s)
      && exactKeys(s, ['providerId', 'accountId', 'modelId', 'thinkingLevel']) && nonempty(s.providerId) && nonempty(s.accountId) && nonempty(s.modelId)
      && (s.thinkingLevel === undefined || nonempty(s.thinkingLevel));
  }
  if (!nonempty(x.runtimeSessionId)) return false;
  if (x.type === 'prompt') return exactKeys(x, ['version', 'id', 'type', 'runtimeSessionId', 'runId', 'input']) && nonempty(x.runId)
    && record(x.input) && exactKeys(x.input, ['messageId', 'text']) && nonempty(x.input.messageId) && nonempty(x.input.text);
  return (x.type === 'cancel' || x.type === 'close') && exactKeys(x, ['version', 'id', 'type', 'runtimeSessionId']);
}
export class WorkerFailure extends Error {
  constructor(readonly code: WorkerCode) { super(code); }
}
