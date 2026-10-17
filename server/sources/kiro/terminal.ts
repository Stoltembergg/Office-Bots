// Terminal do Kiro: converte as linhas do streaming JSONL (~/.kiro/sessions/cli/<sessionId>.jsonl)
// em TerminalEntry (prompts, respostas, pensamentos e chamadas de ferramentas).
import type { TerminalEntry } from '../../../shared/types';
import { maskSecrets } from '../../../shared/activity';
import { prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, toolView, type TerminalParser } from '../terminal';

export class KiroTerminalParser implements TerminalParser {
  private count = 0;

  push(line: string): TerminalEntry[] {
    if (!line || !line.trim()) return [];
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }

    const kind = parsed.kind as string;
    const data = (parsed.data as Record<string, unknown>) || {};
    const now = Date.now();
    const entries: TerminalEntry[] = [];

    if (kind === 'Prompt') {
      const contents = (data.content as Array<{ kind: string; data: unknown }>) || [];
      const textPart = contents.find((c) => c.kind === 'text');
      const text = typeof textPart?.data === 'string' ? textPart.data : '';
      if (text.trim()) {
        this.count++;
        const prep = prepare(text, TEXT_MAX);
        entries.push({
          id: `kiro-term-prompt-${this.count}`,
          kind: 'user',
          text: prep.text,
          at: now,
        });
      }
    } else if (kind === 'AssistantMessage') {
      const contents = (data.content as Array<{ kind: string; data: unknown }>) || [];

      for (const part of contents) {
        if (part.kind === 'thinking' && part.data && typeof part.data === 'object') {
          const thinkText = typeof (part.data as { text?: unknown }).text === 'string'
            ? (part.data as { text: string }).text
            : '';
          if (thinkText.trim()) {
            this.count++;
            const prep = prepare(thinkText, THINKING_MAX);
            entries.push({
              id: `kiro-term-think-${this.count}`,
              kind: 'thinking',
              text: prep.text,
              at: now,
            });
          }
        } else if (part.kind === 'toolUse' && part.data && typeof part.data === 'object') {
          const toolData = part.data as { toolUseId?: string; name?: string; input?: Record<string, unknown> };
          const toolName = toolData.name || 'tool';
          const input = toolData.input || {};
          const view = toolView(toolName, input);

          this.count++;
          entries.push({
            id: toolData.toolUseId || `kiro-term-tool-${this.count}`,
            kind: 'tool',
            tool: toolName,
            title: view.title,
            ...(view.input ? { input: view.input, inputKind: view.inputKind } : {}),
            at: now,
          });
        } else if (part.kind === 'text') {
          const text = typeof part.data === 'string' ? part.data : '';
          if (text.trim()) {
            this.count++;
            const prep = prepare(text, TEXT_MAX);
            entries.push({
              id: `kiro-term-resp-${this.count}`,
              kind: 'assistant',
              text: prep.text,
              at: now,
            });
          }
        }
      }
    } else if (kind === 'ToolResults') {
      const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : `tool-${this.count}`;
      const contents = (data.content as Array<{ kind: string; data: unknown }>) || [];
      const textPart = contents.find((c) => c.kind === 'text');
      const rawText = typeof textPart?.data === 'string' ? textPart.data : (typeof data.output === 'string' ? data.output : '');
      const isError = Boolean(data.isError);

      this.count++;
      const masked = maskSecrets(rawText);
      const lines = masked.split('\n');
      const truncated = masked.length > RESULT_MAX || lines.length > RESULT_MAX_LINES;
      const text = lines.slice(0, RESULT_MAX_LINES).join('\n').slice(0, RESULT_MAX);

      entries.push({
        id: `kiro-term-res-${this.count}`,
        kind: 'result',
        toolUseId,
        text,
        error: isError || undefined,
        truncated: truncated || undefined,
        at: now,
      });
    }

    return entries;
  }
}
