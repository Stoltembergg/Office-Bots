// This module is imported only by worker entries, never by the renderer/host.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager as PiSessionManager, SettingsManager, type AgentSession, type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AgentEvent, AgentEventData, ModelSelection, PromptInput } from '../../../shared/agents/contracts';
import type { RuntimeMessageReceipt, RuntimeResumeConfig, RuntimeResumeResult, RuntimeSessionConfig } from '../runtime';
import { appendMessageResult, appendMessageStart, appendSequenceReservation, createPiSession, resumePiSession } from './persistence';
import { WorkerFailure } from './protocol';

type RecordSession = {
  session: AgentSession;
  manager: PiSessionManager;
  config: RuntimeSessionConfig;
  seq: number;
  seqLimit: number;
  messages: Map<string, RuntimeMessageReceipt>;
  active?: Promise<void>;
  cancelled: boolean;
  persistenceFailed: boolean;
  authorize: () => Promise<boolean>;
};
export type ModelResolver = (selection: ModelSelection) => Promise<{ models: ModelRuntime; authorize: () => Promise<boolean> }>;
/** No account has been granted yet. M3 will supply account-scoped vault access.
 * Ambient environment/CLI credentials must never authorize an app account.
 */
export const unauthenticatedModels: ModelResolver = async () => ({
  models: await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false }),
  authorize: async () => false,
});
const sequenceReservationSize = 32;
const inputHash = (text: string) => createHash('sha256').update(text).digest('hex');
export class PiBackend {
  private readonly sessions = new Map<string, RecordSession>();
  private readonly ids = new Set<string>();
  constructor(private readonly directory: string, private readonly emit: (event: AgentEvent) => void,
    private readonly resolve: ModelResolver = unauthenticatedModels) {}

  private async openAgent(config: RuntimeSessionConfig, manager: PiSessionManager): Promise<{ session: AgentSession; authorize: () => Promise<boolean> }> {
    let session: AgentSession | undefined;
    try {
      const cwd = await realpath(config.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new WorkerFailure('invalid');
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
      const result = await createAgentSession({ cwd, agentDir, modelRuntime: models, model, thinkingLevel: level,
        resourceLoader: loader, settingsManager: settings, sessionManager: manager, noTools: 'all', tools: [] });
      session = result.session;
      if (result.modelFallbackMessage || session.model?.id !== model.id || session.model?.provider !== model.provider
        || session.thinkingLevel !== level || session.getActiveToolNames().length !== 0) throw new WorkerFailure('unavailable');
      return { session, authorize };
    } catch (error) {
      session?.dispose();
      throw error instanceof WorkerFailure ? error : new WorkerFailure('runtime-failed');
    }
  }

  async create(config: RuntimeSessionConfig): Promise<{ runtimeSessionId: string }> {
    if (this.ids.has(config.id)) throw new WorkerFailure('invalid');
    this.ids.add(config.id);
    let session: AgentSession | undefined;
    try {
      const cwd = await realpath(config.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new WorkerFailure('invalid');
      const canonical = { ...config, cwd };
      const manager = await createPiSession(this.directory, canonical);
      const opened = await this.openAgent(canonical, manager);
      session = opened.session;
      const runtimeSessionId = manager.getSessionId();
      if (this.sessions.has(runtimeSessionId)) throw new WorkerFailure('invalid');
      this.sessions.set(runtimeSessionId, { session, manager, config: canonical, seq: 0, seqLimit: 0,
        messages: new Map(), cancelled: false, persistenceFailed: false, authorize: opened.authorize });
      return { runtimeSessionId };
    } catch (error) {
      session?.dispose(); this.ids.delete(config.id);
      throw error instanceof WorkerFailure ? error : new WorkerFailure('runtime-failed');
    }
  }

  async resume(config: RuntimeResumeConfig): Promise<RuntimeResumeResult> {
    if (this.ids.has(config.id)) throw new WorkerFailure('busy');
    this.ids.add(config.id);
    let session: AgentSession | undefined;
    try {
      // The persistence adapter validates the opaque SDK ID and the existing file
      // before opening it. Existing app sessions never opt into allowEmpty.
      const opened = await resumePiSession(this.directory, config);
      const bound: RuntimeSessionConfig = { ...config, selection: opened.binding.selection,
        instructions: opened.binding.instructions ?? undefined };
      const agent = await this.openAgent(bound, opened.manager);
      session = agent.session;
      const runtimeSessionId = opened.binding.runtimeSessionId;
      if (this.sessions.has(runtimeSessionId)) throw new WorkerFailure('busy');
      const messages = new Map(opened.messages.map(receipt => [receipt.messageId, structuredClone(receipt)]));
      this.sessions.set(runtimeSessionId, { session, manager: opened.manager, config: bound,
        seq: opened.lastSeq, seqLimit: opened.lastSeq, messages, cancelled: false,
        persistenceFailed: false, authorize: agent.authorize });
      return { runtimeSessionId, lastSeq: opened.lastSeq, messages: opened.messages };
    } catch (error) {
      session?.dispose(); this.ids.delete(config.id);
      throw error instanceof WorkerFailure ? error : new WorkerFailure('runtime-failed');
    }
  }

  private get(id: string) { const found = this.sessions.get(id); if (!found) throw new WorkerFailure('invalid'); return found; }
  prompt(id: string, input: PromptInput, runId: string): Promise<void> {
    const s = this.get(id); if (s.active) throw new WorkerFailure('busy');
    if (s.persistenceFailed) throw new WorkerFailure('runtime-failed');
    const hash = inputHash(input.text), previous = s.messages.get(input.messageId);
    if (previous) {
      if (previous.inputHash !== hash) throw new WorkerFailure('invalid');
      if (previous.outcome === 'completed') throw new WorkerFailure('invalid');
      throw new WorkerFailure(previous.outcome === 'cancelled' ? 'cancelled' : previous.outcome === 'interrupted' ? 'resume-required' : 'runtime-failed');
    }
    s.cancelled = false;
    let started = false;
    const ensureStarted = () => {
      if (started) return;
      if (s.persistenceFailed) throw new WorkerFailure('runtime-failed');
      try {
        s.seqLimit = s.seq + sequenceReservationSize;
        // At this point the SDK has durably appended the user message, so this
        // custom entry and its reservation are flushed before any public event.
        appendMessageStart(s.manager, input.messageId, hash, s.seqLimit);
        started = true;
        send({ type: 'message-start', payload: { messageId: input.messageId } });
        send({ type: 'state', payload: { state: 'running' } });
      } catch {
        s.persistenceFailed = true;
        throw new WorkerFailure('runtime-failed');
      }
    };
    const reserveThrough = (sequence: number) => {
      if (sequence <= s.seqLimit) return;
      const nextLimit = sequence + sequenceReservationSize;
      appendSequenceReservation(s.manager, input.messageId, nextLimit);
      s.seqLimit = nextLimit;
    };
    const send = (data: AgentEventData) => {
      if (!started || s.persistenceFailed) throw new WorkerFailure('runtime-failed');
      const seq = s.seq + 1;
      try { reserveThrough(seq); } catch { s.persistenceFailed = true; throw new WorkerFailure('runtime-failed'); }
      s.seq = seq;
      this.emit({ schemaVersion: 1, origin: 'managed-pi', sessionId: s.config.id, runId,
        seq, at: new Date().toISOString(), ...data } as AgentEvent);
    };
    const operation = Promise.resolve().then(async () => {
      if (!await s.authorize()) throw new WorkerFailure('unavailable');
      if (s.cancelled) throw new WorkerFailure('cancelled');
      let failed = false;
      const unsubscribe = s.session.subscribe(event => {
        // The SDK publishes message_end before appending it synchronously. Queue
        // the start record so it follows that append and is durable before send.
        if (event.type === 'message_end' && event.message.role === 'user') {
          queueMicrotask(() => { try { ensureStarted(); } catch { s.persistenceFailed = true; } });
        }
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          if (!started) ensureStarted();
          send({ type: 'text-delta', payload: { text: event.assistantMessageEvent.delta } });
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          if (!started) ensureStarted();
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
        if (!started && s.manager.getEntryCount() > 1) ensureStarted();
        if (failed || s.persistenceFailed || !started) error = new WorkerFailure('runtime-failed');
      } catch (e) {
        error = e instanceof WorkerFailure ? e : new WorkerFailure('runtime-failed');
      } finally { unsubscribe(); }
      if (s.cancelled) error = new WorkerFailure('cancelled');
      if (s.persistenceFailed) throw new WorkerFailure('runtime-failed');
      if (!started) { if (error) throw error; throw new WorkerFailure('runtime-failed'); }
      const outcome: RuntimeMessageReceipt['outcome'] = error?.code === 'cancelled' ? 'cancelled' : error ? 'error' : 'completed';
      const terminalEvents = (error && error.code !== 'cancelled' ? 1 : 0) + 2;
      const finalSeq = s.seq + terminalEvents;
      try {
        reserveThrough(finalSeq);
        appendMessageResult(s.manager, { messageId: input.messageId, inputHash: hash, outcome }, finalSeq);
        s.messages.set(input.messageId, { messageId: input.messageId, inputHash: hash, outcome });
      } catch { s.persistenceFailed = true; throw new WorkerFailure('runtime-failed'); }
      if (error && error.code !== 'cancelled') send({ type: 'error', payload: { code: 'runtime-failed' } });
      send({ type: 'message-end', payload: { outcome: outcome === 'completed' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'error' } });
      send({ type: 'state', payload: { state: outcome === 'error' ? 'error' : 'idle' } });
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
