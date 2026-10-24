import path from 'node:path';
import { exactKeys, nonempty, record } from '../../../shared/agents/validation';
import type { RuntimeResumeConfig, RuntimeSessionConfig } from '../runtime';
import type { PromptInput } from '../../../shared/agents/contracts';
export type WorkerCode = 'invalid' | 'unavailable' | 'busy' | 'cancelled' | 'runtime-failed' | 'resume-required';
export const codes: readonly WorkerCode[] = ['invalid', 'unavailable', 'busy', 'cancelled', 'runtime-failed', 'resume-required'];
export type Command = { version: 1; id: string } & (
  | { type: 'create'; config: RuntimeSessionConfig }
  | { type: 'resume'; config: RuntimeResumeConfig }
  | { type: 'prompt'; runtimeSessionId: string; runId: string; input: PromptInput }
  | { type: 'cancel' | 'close'; runtimeSessionId: string }
);
const safeSessionId = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
function validConfig(value: unknown, resume: boolean): boolean {
  if (!record(value)) return false;
  const c = value, s = c.selection;
  const allowed = resume
    ? ['id', 'runtimeSessionId', 'agentId', 'projectId', 'cwd', 'selection', 'instructions', 'allowEmpty']
    : ['id', 'agentId', 'projectId', 'cwd', 'selection', 'instructions'];
  return exactKeys(c, allowed) && nonempty(c.id) && nonempty(c.agentId) && nonempty(c.projectId)
    && nonempty(c.cwd) && path.isAbsolute(c.cwd)
    && (c.instructions === undefined || typeof c.instructions === 'string')
    && (!resume || (typeof c.runtimeSessionId === 'string' && safeSessionId.test(c.runtimeSessionId)
      && (c.allowEmpty === undefined || typeof c.allowEmpty === 'boolean')))
    && record(s) && exactKeys(s, ['providerId', 'accountId', 'modelId', 'thinkingLevel'])
    && nonempty(s.providerId) && nonempty(s.accountId) && nonempty(s.modelId)
    && (s.thinkingLevel === undefined || nonempty(s.thinkingLevel));
}
export function isCommand(x: unknown): x is Command {
  if (!record(x) || x.version !== 1 || !nonempty(x.id)) return false;
  if (x.type === 'create' || x.type === 'resume') {
    return exactKeys(x, ['version', 'id', 'type', 'config']) && validConfig(x.config, x.type === 'resume');
  }
  if (!nonempty(x.runtimeSessionId)) return false;
  if (x.type === 'prompt') return exactKeys(x, ['version', 'id', 'type', 'runtimeSessionId', 'runId', 'input']) && nonempty(x.runId)
    && record(x.input) && exactKeys(x.input, ['messageId', 'text']) && nonempty(x.input.messageId) && nonempty(x.input.text);
  return (x.type === 'cancel' || x.type === 'close') && exactKeys(x, ['version', 'id', 'type', 'runtimeSessionId']);
}
export class WorkerFailure extends Error {
  constructor(readonly code: WorkerCode) { super(code); }
}
