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

export type SessionState = 'idle' | 'queued' | 'running' | 'cancelling' | 'error' | 'closed';
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
