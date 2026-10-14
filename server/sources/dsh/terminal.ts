// Parser do terminal para as sessões do DeepSeek Harness: converte as linhas JSONL do espelho decodificado
// (eventos DSH, ver sources/dsh/log.ts) em TerminalEntry — prompts, respostas, ferramentas e resultados — no
// formato do Claude Code. Segredos mascarados e textos truncados (limites de sources/terminal.ts).
import type { TerminalEntry } from '../../../shared/types';
import { maskSecrets, truncate } from '../../../shared/activity';
import { INPUT_MAX, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, prepare } from '../terminal';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Texto multilinha pronto (limpo, mascarado e cortado), do terminal do Claude Code. */
function clean(s: string, max: number): string {
  return prepare(s, max).text;
}

function cutLines(s: string): { text: string; truncated: boolean } {
  return prepare(s, RESULT_MAX, RESULT_MAX_LINES);
}

/** Texto dos blocos `content` de uma mensagem do DSH (content: [{type:'text', text}...]). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    const block = rec(b);
    if (!block) continue;
    if (block.type === 'text') {
      const t = str(block.text);
      if (t) parts.push(t);
    }
  }
  return parts.join('\n\n');
}

/** Título de uma ferramenta no estilo do Claude Code: "pwsh(npm test)", "read(app.ts)". */
function toolTitle(name: string, argsRaw: string | undefined): string {
  let arg = '';
  const args = argsRaw ? tryParse(argsRaw) : undefined;
  if (args) arg = str(args.command) ?? str(args.file_path) ?? str(args.path) ?? str(args.pattern) ?? str(args.query) ?? str(args.url) ?? str(args.description) ?? '';
  if (arg) arg = truncate(maskSecrets(arg.replace(/\s+/g, ' ').trim()), 100);
  return arg ? `${name}(${arg})` : name;
}

function tryParse(raw: string): Rec | undefined {
  try {
    return rec(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Cria o parser do terminal de uma sessão do DSH (um por stream: guarda o que já saiu). */
export function createDshTerminalParser(): { push(line: string): TerminalEntry[] } {
  const seen = new Set<string>();
  let seq = 0;
  return {
    push(line: string): TerminalEntry[] {
      if (!line.trim()) return [];
      let j: Rec;
      try {
        j = JSON.parse(line) as Rec;
      } catch {
        return [];
      }
      const type = str(j.type);
      if (!type) return [];
      const data = rec(j.data) ?? {};
      const at = num(j.time) ?? num(j.createdAt) ?? 0;
      const key = `${type}:${num(j.seq) ?? 'x'}:${at}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const id = `dsh-${seq++}`;
      switch (type) {
        case 'user/message': {
          // Só o que você digitou (a caixa de mensagens e avisos automáticos chegam por outros tipos).
          const src = str(rec(data.source)?.kind);
          if (src && src !== 'user') return [];
          const text = clean(contentText(data.content), TEXT_MAX);
          return text.trim() ? [{ kind: 'user', id, at, text }] : [];
        }
        case 'assistant/message': {
          const msg = rec(data.message) ?? {};
          const out: TerminalEntry[] = [];
          const text = clean(contentText(msg.content), TEXT_MAX);
          if (text.trim()) out.push({ kind: 'assistant', id, at, text });
          return out;
        }
        case 'tool/call': {
          const name = str(data.name) ?? 'ferramenta';
          const argsRaw = str(data.arguments);
          const entry: TerminalEntry = {
            kind: 'tool',
            id: str(data.callId) ?? id,
            at,
            tool: name,
            title: toolTitle(name, argsRaw),
          };
          if (argsRaw) {
            entry.input = clean(argsRaw, INPUT_MAX);
            entry.inputKind = 'json';
            const cmd = tryParse(argsRaw);
            if (cmd && (str(cmd.command) || str(cmd.cmd))) {
              entry.input = clean(str(cmd.command) ?? str(cmd.cmd)!, INPUT_MAX);
              entry.inputKind = 'command';
            }
          }
          return [entry];
        }
        case 'tool/result': {
          const msg = rec(data.message) ?? {};
          const cut = cutLines(clean(contentText(msg.content), RESULT_MAX * 4));
          return [
            {
              kind: 'result',
              id,
              at,
              toolUseId: str(data.toolCallId) ?? str(data.callId) ?? '',
              text: cut.text,
              ...(cut.truncated ? { truncated: true } : {}),
            },
          ];
        }
        case 'approval/asked':
          return [{ kind: 'system', id, at, text: 'Pedido de permissão: a sessão espera a sua resposta', level: 'warn' }];
        case 'approval/decided':
          return [{ kind: 'system', id, at, text: 'Pedido de permissão respondido', level: 'info' }];
        case 'turn/end': {
          const kind = str(rec(data.reason)?.kind);
          return kind === 'aborted' ? [{ kind: 'system', id, at, text: 'Turno interrompido', level: 'warn' }] : [];
        }
        case 'command/run': {
          const name = str(data.name) ?? '';
          return name ? [{ kind: 'user', id, at, text: clean(`/${name}${str(data.args) ?? ''}`, TEXT_MAX) }] : [];
        }
        default:
          return [];
      }
    },
  };
}
