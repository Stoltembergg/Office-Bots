// Atividade de uma ferramenta do OpenCode no formato do escritório (shared/activity.ts): os nomes das ferramentas
// embutidas viram os do Claude Code, para o mesmo texto e ícone; o resto cai no descritivo genérico.
import { describeTool, truncate, type ActivityDescription } from '../../../shared/activity';

const TOOL_NAMES: Record<string, string> = {
  shell: 'Bash',
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  patch: 'Edit',
  apply_patch: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  task: 'Agent',
  todowrite: 'TodoWrite',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Descrição da chamada `name` (nome bruto do OpenCode) com a entrada `input`; `tool` é o nome normalizado. */
export function describeOpenCodeTool(name: string, input: Record<string, unknown>): { desc: ActivityDescription; tool: string } {
  const tool = TOOL_NAMES[name] ?? name;
  if (tool === 'Agent') {
    const prompt = str(input.description) ?? str(input.prompt);
    return { desc: describeTool('Agent', { description: prompt ? truncate(prompt, 60) : undefined, subagent_type: input.subagent_type }), tool };
  }
  // O OpenCode usa filePath (camelCase); o descritivo do Claude Code lê file_path.
  const normalized = input.file_path === undefined && typeof input.filePath === 'string' ? { ...input, file_path: input.filePath } : input;
  return { desc: describeTool(tool, normalized), tool };
}
