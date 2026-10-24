import type { ModelSelection, PromptInput } from '../../shared/agents/contracts';

export interface RuntimeSessionConfig {
  id: string;
  agentId: string;
  projectId: string;
  cwd: string;
  selection: ModelSelection;
  instructions?: string;
}
/** Internal execution seam; creating a session must never start inference.
 * prompt settles only when the turn actually stops, including after cancel.
 * cancel acknowledges a request; its resolution alone does not free a slot.
 * The Pi worker adapter will implement this interface in a later increment.
 */
export interface ManagedRuntime {
  create(config: RuntimeSessionConfig): Promise<{ runtimeSessionId: string }>;
  prompt(runtimeSessionId: string, input: PromptInput): Promise<void>;
  cancel(runtimeSessionId: string): Promise<void>;
  close(runtimeSessionId: string): Promise<void>;
}
