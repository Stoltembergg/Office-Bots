/** App-owned identities. These contracts do not expose provider SDK types. */
export interface ModelSelection {
  providerId: string;
  accountId: string;
  modelId: string;
  thinkingLevel?: string;
}
export type AgentModelPolicy = { mode: 'fixed'; selection: ModelSelection } | { mode: 'choose-on-start' };
export interface Project { id: string; name: string; cwd: string }
export interface AgentProfile {
  id: string;
  projectId: string;
  name: string;
  instructions?: string;
  appearanceSeed: string;
  modelPolicy: AgentModelPolicy;
  archivedAt?: string;
}
export type AgentPatch = Partial<Pick<AgentProfile, 'name' | 'instructions' | 'appearanceSeed' | 'modelPolicy'>>;

export type SessionState = 'idle' | 'queued' | 'running' | 'cancelling' | 'error' | 'closed' | 'interrupted';
export interface SessionConfig { agentId: string; selection?: ModelSelection }
export interface SessionInfo {
  id: string;
  origin: 'managed-pi';
  runtimeSessionId: string;
  projectId: string;
  agentId: string;
  selection: ModelSelection;
  state: SessionState;
}
export interface PromptInput { messageId: string; text: string }

/** Public turn events. SDK objects, errors and tool arguments never pass through. */
type EventBase = { schemaVersion: 1; origin: 'managed-pi'; sessionId: string; runId: string; seq: number; at: string };
export type AgentEvent = EventBase & (
  | { type: 'message-start'; payload: { messageId: string } }
  | { type: 'text-delta'; payload: { text: string } }
  | { type: 'message-end'; payload: { outcome: 'completed' | 'cancelled' | 'error' } }
  | { type: 'state'; payload: { state: 'running' | 'idle' | 'error' } }
  | { type: 'usage'; payload: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }
  | { type: 'error'; payload: { code: 'unavailable' | 'runtime-failed' } }
);
export type AgentEventData = AgentEvent extends infer E ? E extends AgentEvent ? Pick<E, 'type' | 'payload'> : never : never;
