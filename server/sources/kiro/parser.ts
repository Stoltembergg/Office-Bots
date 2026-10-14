// Parser de eventos de sessão do Kiro (~/.kiro/sessions/cli/<uuid>.jsonl)
import type { Activity, ActivityKind, AgentStatus } from '../../../shared/types';

export interface KiroParsedLine {
  activity?: Activity;
  status?: AgentStatus;
  waitingFor?: string;
  command?: string;
  subagent?: { name: string; sessionId?: string };
}

export function describeKiroTool(toolName: string, input: Record<string, unknown> = {}): { kind: ActivityKind; icon: string; text: string; detail?: string } {
  const purpose = typeof input.__tool_use_purpose === 'string' && input.__tool_use_purpose.trim()
    ? input.__tool_use_purpose.trim()
    : undefined;

  const command = typeof input.command === 'string' ? input.command.trim() : undefined;
  const path = typeof input.path === 'string' ? input.path.trim() : (typeof input.file === 'string' ? input.file.trim() : undefined);

  if (toolName === 'shell' || toolName === 'execute' || toolName === 'bash') {
    if (command) {
      if (/\b(?:test|pytest|vitest|jest|phpunit)\b/i.test(command)) {
        return { kind: 'test', icon: '🧪', text: purpose || 'Rodando testes', detail: command };
      }
      if (/\bgit\b/i.test(command)) {
        return { kind: 'git', icon: '🌿', text: purpose || 'Comando git', detail: command };
      }
      if (/\b(?:build|compile)\b/i.test(command)) {
        return { kind: 'run', icon: '🏗️', text: purpose || 'Compilando projeto', detail: command };
      }
      return { kind: 'run', icon: '💻', text: purpose || 'Executando comando', detail: command };
    }
    return { kind: 'run', icon: '💻', text: purpose || 'Terminal shell' };
  }

  if (toolName === 'read_file' || toolName === 'view_file' || toolName === 'cat') {
    return { kind: 'read', icon: '📖', text: purpose || (path ? `Lendo ${path}` : 'Lendo arquivo'), detail: path };
  }

  if (toolName === 'write_file' || toolName === 'edit' || toolName === 'replace_file_content') {
    return { kind: 'edit', icon: '✏️', text: purpose || (path ? `Editando ${path}` : 'Editando código'), detail: path };
  }

  if (toolName === 'subagent' || toolName === 'delegate') {
    return { kind: 'delegate', icon: '🤝', text: purpose || 'Invocando subagente', detail: path || command };
  }

  if (toolName === 'search' || toolName === 'grep' || toolName === 'find') {
    return { kind: 'search', icon: '🔍', text: purpose || 'Buscando no projeto', detail: path || command };
  }

  if (toolName === 'ask' || toolName === 'ask_question') {
    return { kind: 'ask', icon: '❓', text: purpose || 'Aguardando confirmação do usuário', detail: command };
  }

  // Ferramentas customizadas (skills como revisor, frontend, etc.)
  return {
    kind: 'skill',
    icon: '⚡',
    text: purpose || `Executando ${toolName}`,
    detail: command || path || JSON.stringify(input).slice(0, 150),
  };
}

export function parseKiroJsonlLine(line: string, index: number, now: number = Date.now()): KiroParsedLine | undefined {
  if (!line || !line.trim()) return undefined;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const kind = parsed.kind as string;
  const data = (parsed.data as Record<string, unknown>) || {};

  if (kind === 'Prompt') {
    const contents = (data.content as Array<{ kind: string; data: unknown }>) || [];
    const textPart = contents.find((c) => c.kind === 'text');
    const promptText = typeof textPart?.data === 'string' ? textPart.data : 'Nova instrução';
    return {
      activity: {
        id: `kiro-prompt-${index}`,
        kind: 'prompt',
        icon: '💬',
        text: 'Nova instrução',
        detail: promptText.slice(0, 300),
        at: now,
      },
      status: 'working',
    };
  }

  if (kind === 'AssistantMessage') {
    const contents = (data.content as Array<{ kind: string; data: unknown }>) || [];

    // Checar se há toolUse
    const toolUsePart = contents.find((c) => c.kind === 'toolUse');
    if (toolUsePart && toolUsePart.data && typeof toolUsePart.data === 'object') {
      const toolData = toolUsePart.data as { toolUseId?: string; name?: string; input?: Record<string, unknown> };
      const toolName = toolData.name || 'tool';
      const input = toolData.input || {};
      const desc = describeKiroTool(toolName, input);

      return {
        activity: {
          id: toolData.toolUseId || `kiro-tool-${index}`,
          kind: desc.kind,
          icon: desc.icon,
          text: desc.text,
          detail: desc.detail,
          tool: toolName,
          at: now,
        },
        status: 'working',
        command: typeof input.command === 'string' ? input.command : undefined,
      };
    }

    // Checar se há thinking
    const thinkPart = contents.find((c) => c.kind === 'thinking');
    if (thinkPart) {
      return {
        activity: {
          id: `kiro-think-${index}`,
          kind: 'think',
          icon: '🧠',
          text: 'Pensando...',
          at: now,
        },
        status: 'working',
      };
    }

    // Resposta em texto pura
    const textPart = contents.find((c) => c.kind === 'text');
    if (textPart && typeof textPart.data === 'string' && textPart.data.trim()) {
      return {
        activity: {
          id: `kiro-resp-${index}`,
          kind: 'respond',
          icon: '💬',
          text: 'Respondendo',
          detail: textPart.data.slice(0, 150),
          at: now,
        },
        status: 'idle', // Resposta final concluída, aguardando usuário
      };
    }
  }

  if (kind === 'ToolResults') {
    // Fim da execução de ferramenta
    return {
      status: 'working',
    };
  }

  return undefined;
}
