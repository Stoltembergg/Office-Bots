// Parser do terminal para as sessões do OpenCode: converte as linhas do espelho (mensagens do session_message,
// ver sources/opencode/source.ts) em TerminalEntry — prompts, respostas, ferramentas e resultados — no formato
// do Claude Code. Segredos mascarados e textos truncados (limites de sources/terminal.ts).
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

function clean(s: string, max: number): string {
  return prepare(s, max).text;
}

function cutLines(s: string): { text: string; truncated: boolean } {
  return prepare(s, RESULT_MAX, RESULT_MAX_LINES);
}

/** Texto dos blocos de conteúdo do OpenCode ([{type:'text', text}...]). */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    const block = rec(b);
    if (block?.type === 'text') {
      const t = str(block.text);
      if (t) parts.push(t);
    }
  }
  return parts.join('\n\n');
}

function toolTitle(name: string, input: Rec | undefined): string {
  let arg = '';
  if (input) arg = str(input.command) ?? str(input.path) ?? str(input.file_path) ?? str(input.pattern) ?? str(input.query) ?? str(input.url) ?? str(input.description) ?? '';
  if (arg) arg = truncate(maskSecrets(arg.replace(/\s+/g, ' ').trim()), 100);
  return arg ? `${name}(${arg})` : name;
}

/** Cria o parser do terminal de uma sessão do OpenCode (um por stream: guarda o que já saiu). */
export function createOpencodeTerminalParser(): { push(line: string): TerminalEntry[] } {
  const seen = new Set<number>();
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
      const data = rec(j.data) ?? {};
      const at = num(j.at) ?? num(rec(j.data ? data.time : undefined)?.created) ?? 0;
      const rowSeq = num(j.seq);
      if (rowSeq !== undefined) {
        if (seen.has(rowSeq)) return [];
        seen.add(rowSeq);
      }
      let seq2 = ++seq;
      switch (type) {
        case 'user': {
          // O espelho do OpenCode guarda também mensagens automáticas: só as de texto contam como suas.
          const text = clean(str(data.text) ?? blocksText(data.content), TEXT_MAX);
          return text.trim() ? [{ kind: 'user', id: `oc-${seq2}`, at, text }] : [];
        }
        case 'assistant': {
          const out: TerminalEntry[] = [];
          const text = blocksText(data.content);
          if (text.trim()) out.push({ kind: 'assistant', id: `oc-${seq2}`, at, text: clean(text, TEXT_MAX) });
          const content = Array.isArray(data.content) ? data.content : [];
          for (const b of content) {
            const block = rec(b);
            if (block?.type !== 'tool') continue;
            const name = str(block.name) ?? 'ferramenta';
            const state = rec(block.state) ?? {};
            const input = rec(state.input);
            const entry: TerminalEntry = {
              kind: 'tool',
              id: str(block.id) ?? `oc-${++seq2}`,
              at,
              tool: name,
              title: toolTitle(name, input),
            };
            if (input) {
              const cmd = str(input.command);
              entry.input = clean(cmd ?? JSON.stringify(input), INPUT_MAX);
              entry.inputKind = cmd ? 'command' : 'json';
            }
            out.push(entry);
            const resultText = blocksText(state.content);
            if (resultText.trim()) {
              const cut = cutLines(clean(resultText, RESULT_MAX * 4));
              out.push({
                kind: 'result',
                id: `oc-${++seq2}`,
                at,
                toolUseId: entry.id,
                text: cut.text,
                ...(cut.truncated ? { truncated: true } : {}),
                ...(state.status === 'error' ? { error: true } : {}),
              });
            }
          }
          return out;
        }
        case 'system':
        case 'synthetic': {
          const text = str(data.description) ?? str(data.text);
          return text ? [{ kind: 'system', id: `oc-${seq2}`, at, text: clean(text, 200) }] : [];
        }
        default:
          return [];
      }
    },
  };
}
