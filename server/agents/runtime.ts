import type { ModelSelection, PromptInput } from '../../shared/agents/contracts';

export interface RuntimeSessionConfig {
  id: string;
  agentId: string;
  projectId: string;
  cwd: string;
  selection: ModelSelection;
  instructions?: string;
}
export interface RuntimeResumeConfig extends RuntimeSessionConfig {
  runtimeSessionId: string;
  /** Only a brand-new session may opt into an empty SDK transcript. */
  allowEmpty?: boolean;
}
export type RuntimeMessageReceipt = {
  messageId: string;
  inputHash: string;
  outcome: 'completed' | 'cancelled' | 'error' | 'interrupted';
};
export type RuntimeResumeResult = {
  runtimeSessionId: string;
  lastSeq: number;
  messages: RuntimeMessageReceipt[];
};
/** Internal execution seam; create/resume never starts inference.
 * prompt settles only when the turn actually stops, including after cancel.
 * cancel acknowledges a request; its resolution alone does not free a slot.
 */
export interface ManagedRuntime {
  create(config: RuntimeSessionConfig): Promise<{ runtimeSessionId: string }>;
  resume(config: RuntimeResumeConfig): Promise<RuntimeResumeResult>;
  prompt(runtimeSessionId: string, input: PromptInput): Promise<void>;
  cancel(runtimeSessionId: string): Promise<void>;
  close(runtimeSessionId: string): Promise<void>;
}
