// This module is imported only by worker entries, never by the renderer/host.
import path from 'node:path';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AgentEvent, AgentEventData, ModelSelection, PromptInput } from '../../../shared/agents/contracts';
import type { RuntimeSessionConfig } from '../runtime';
import { WorkerFailure } from './protocol';

type RecordSession = { session: AgentSession; config: RuntimeSessionConfig; seq: number; active?: Promise<void>; cancelled: boolean };
export type ModelResolver = (selection: ModelSelection) => Promise<{ models: ModelRuntime; authorize: () => Promise<boolean> }>;
/** No account has been granted yet. M3 will supply account-scoped vault access.
 * Ambient environment/CLI credentials must never authorize an app account.
 */
export const unauthenticatedModels: ModelResolver = async () => ({
  models: await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false }),
  authorize: async () => false,
});
export class PiBackend {
  private readonly sessions = new Map<string, RecordSession & { authorize: () => Promise<boolean> }>();
  private readonly ids = new Set<string>();
  constructor(private readonly directory: string, private readonly emit: (event: AgentEvent) => void,
    private readonly resolve: ModelResolver = unauthenticatedModels) {}
  async create(config: RuntimeSessionConfig): Promise<{ runtimeSessionId: string }> {
    if (this.ids.has(config.id)) throw new WorkerFailure('invalid');
    this.ids.add(config.id);
    let session: AgentSession | undefined;
    try {
      const cwd = await realpath(config.cwd); if (!(await stat(cwd)).isDirectory()) throw new WorkerFailure('invalid');
      const { models, authorize } = await this.resolve(config.selection);
      const model = models.getModel(config.selection.providerId, config.selection.modelId);
      if (!model || model.provider !== config.selection.providerId || model.id !== config.selection.modelId) throw new WorkerFailure('unavailable');
      const level = getSupportedThinkingLevels(model).find(l => l === (config.selection.thinkingLevel ?? 'off'));
      if (!level) throw new WorkerFailure('unavailable');
      const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }, { projectTrusted: false });
      const agentDir = path.join(this.directory, 'agent'); await mkdir(agentDir, { recursive: true });
      // Do not use SDK discovery: even noContextFiles:true still reads
      // APPEND_SYSTEM.md, and a systemPrompt string may be treated as a path.
      const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
      const loader: ResourceLoader = {
        getExtensions: () => extensions,
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => config.instructions ?? '',
        getSystemPromptSource: () => undefined,
        getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
        extendResources: () => {}, reload: async () => {},
      };
      const sdkManager = SessionManager.create(cwd, path.join(this.directory, 'sessions'));
      const result = await createAgentSession({ cwd, agentDir, modelRuntime: models, model, thinkingLevel: level,
        resourceLoader: loader, settingsManager: settings, sessionManager: sdkManager, noTools: 'all', tools: [] });
      session = result.session;
      if (result.modelFallbackMessage || session.model?.id !== model.id || session.model.provider !== model.provider
        || session.thinkingLevel !== level || session.getActiveToolNames().length !== 0) throw new WorkerFailure('unavailable');
      const runtimeSessionId = sdkManager.getSessionId();
      this.sessions.set(runtimeSessionId, { session, config, seq: 0, cancelled: false, authorize });
      return { runtimeSessionId };
    } catch (error) {
      session?.dispose(); this.ids.delete(config.id);
      throw error instanceof WorkerFailure ? error : new WorkerFailure('runtime-failed');
    }
  }
  private get(id: string) { const found = this.sessions.get(id); if (!found) throw new WorkerFailure('invalid'); return found; }
  prompt(id: string, input: PromptInput, runId: string): Promise<void> {
    const s = this.get(id); if (s.active) throw new WorkerFailure('busy');
    s.cancelled = false;
    const send = (data: AgentEventData) => this.emit({ schemaVersion: 1, origin: 'managed-pi', sessionId: s.config.id,
      runId, seq: ++s.seq, at: new Date().toISOString(), ...data } as AgentEvent);
    const operation = Promise.resolve().then(async () => {
      // Check the exact account for every dispatch. No SDK/environment fallback.
      if (!await s.authorize()) throw new WorkerFailure('unavailable');
      if (s.cancelled) throw new WorkerFailure('cancelled');
      send({ type: 'message-start', payload: { messageId: input.messageId } });
      send({ type: 'state', payload: { state: 'running' } });
      let failed = false;
      const unsubscribe = s.session.subscribe(event => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          send({ type: 'text-delta', payload: { text: event.assistantMessageEvent.delta } });
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          if (event.message.stopReason === 'error') failed = true;
          if (event.message.stopReason === 'aborted') s.cancelled = true;
          const u = event.message.usage;
          const payload: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {};
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
            const value = u?.[key]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0) payload[key] = value;
          }
          if (Object.keys(payload).length) send({ type: 'usage', payload });
        }
      });
      let error: WorkerFailure | undefined;
      try {
        await s.session.prompt(input.text, { expandPromptTemplates: false });
        if (failed) error = new WorkerFailure('runtime-failed');
      } catch { error = new WorkerFailure('runtime-failed'); }
      finally { unsubscribe(); }
      if (s.cancelled) error = new WorkerFailure('cancelled');
      if (error && error.code !== 'cancelled') send({ type: 'error', payload: { code: 'runtime-failed' } });
      send({ type: 'message-end', payload: { outcome: error?.code === 'cancelled' ? 'cancelled' : error ? 'error' : 'completed' } });
      send({ type: 'state', payload: { state: error && error.code !== 'cancelled' ? 'error' : 'idle' } });
      if (error) throw error;
    });
    s.active = operation;
    void operation.then(() => { s.active = undefined; }, () => { s.active = undefined; });
    return operation;
  }
  async cancel(id: string): Promise<void> { const s = this.get(id); if (s.active) { s.cancelled = true; await s.session.abort(); } }
  async close(id: string): Promise<void> {
    const s = this.get(id); await this.cancel(id); await s.active?.catch(() => undefined);
    s.session.dispose(); this.sessions.delete(id); this.ids.delete(s.config.id);
  }
}
