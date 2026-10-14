// Pedidos de aprovação do OpenCode (plugin ~/.config/opencode/plugins/habblaud.js): a ação e os recursos que o
// OpenCode quer usar. O Permission.Request do binário instalado é {id, sessionID, action, resources[], save?,
// metadata?, source?, message?} e o plugin manda `tool_name` = action, `tool_input.resources` e
// `provider: "opencode"` — o mesmo corpo do hook do Claude, então parseHookInput não muda de forma.
//
// As ações do OpenCode 2 (docs de permissões) não batem com as do Claude Code: shell em vez de Bash, edit em vez
// de Edit, webfetch em vez de WebFetch... Cada uma vira a ferramenta EQUIVALENTE do Claude só para o resumo e o
// ícone (describeTool, que já traz o PT-BR, o mascaramento e a iconografia); o TÍTULO fica com o nome real do
// OpenCode, porque é ele que diz o que está sendo pedido. É o mesmo truque de codex.ts, só no sentido inverso:
// ali o nome do Codex já é o do Claude, aqui é preciso traduzir.
//
// Caminhos vêm do Windows (o plugin roda nativo lá), por isso o relPath daqui aceita barra invertida — o de
// sources/terminal.ts é POSIX e devolveria o caminho inteiro.
//
// `message` do pedido fica de fora de propósito: não sei o que significa no OpenCode e não existe campo para ele
// em PermissionRequestInfo. Se um dia servir para algo, é decisão nova, não chute.
import { describeTool, maskSecrets, truncate } from '../../shared/activity';
import type { AskQuestion, TerminalInputKind } from '../../shared/types';
import { TITLE_ARG_MAX, toolView } from '../sources/terminal';

/** Resumo de um pedido do OpenCode: o que vai em PermissionRequestInfo (title, text, icon, input, inputKind). */
export interface OpenCodeToolView {
  title: string;
  text: string;
  icon: string;
  input?: string;
  inputKind?: TerminalInputKind;
  /** Perguntas de uma `Question`: vão para PermissionRequestInfo.questions (cartão de resposta). */
  questions?: AskQuestion[];
}

type Rec = Record<string, unknown>;

/** Tamanho do resumo (o mesmo das atividades). */
const TEXT_MAX = 46;
/** Argumento mostrado no detalhe (o mesmo limite do input do terminal). */
const INPUT_MAX = 2_000;
/** Recursos que valem a pena listar (um pedido nunca chega perto disso). */
const MAX_RESOURCES = 64;

/**
 * Ação do OpenCode → ferramenta equivalente do Claude Code, só para descrever (describeTool). As sem
 * equivalente ficam de fora e caem no padrão do describeTool.
 */
const EQUIVALENT: Record<string, string> = {
  shell: 'Bash',
  edit: 'Edit',
  read: 'Read',
  glob: 'Glob',
  grep: 'Grep',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  subagent: 'Task',
  skill: 'Skill',
};

/** Campo em que cada equivalente espera o recurso (describeTool lê por nome). */
const FIELD: Record<string, string> = {
  Bash: 'command',
  Edit: 'file_path',
  Read: 'file_path',
  Glob: 'pattern',
  Grep: 'pattern',
  WebFetch: 'url',
  WebSearch: 'query',
  Task: 'subagent_type',
  Skill: 'skill',
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** Recursos pedidos (caminhos, comandos, URLs, padrões), na ordem em que o OpenCode pediu. */
export function resources(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const s = str(item);
    if (s && out.length < MAX_RESOURCES) out.push(s);
  }
  return out;
}

/** Uma linha mascarada e cortada (o mesmo tratamento do codex.ts). */
function line(s: string, max: number): string {
  return truncate(maskSecrets(s.slice(0, max * 8)), max);
}

/** O argumento já cabe no título: não precisa se repetir no painel de detalhe (a mesma regra de sources/terminal.ts). */
function fitsTitle(v: string): boolean {
  return !v.includes('\n') && v.trim().length <= TITLE_ARG_MAX;
}

/**
 * Caminho relativo à raiz do trabalho, aceitando também Windows (C:\Users\...): sources/terminal.ts só entende
 * POSIX e devolveria o caminho inteiro no título.
 */
export function relPath(p: string, cwd: string | undefined): string {
  if (!cwd) return p;
  const base = cwd.replace(/[\\/]+$/, '');
  const path = p.replace(/[\\/]+$/, '');
  if (!base || !path) return p;
  if (path.toLowerCase() === base.toLowerCase()) return '.';
  if (path.length < base.length) return p;
  const rest = path.slice(base.length);
  return path.slice(0, base.length).toLowerCase() === base.toLowerCase() && /^[\\/]/.test(rest) ? rest.slice(1) : p;
}

/**
 * Painel de argumentos do detalhe. O shell mostra sempre (como no Codex: o comando é longo e o título corta);
 * os outros só quando o título não dá conta — ou quando há mais de um recurso, que aí precisa aparecer inteiro.
 */
function argPanel(action: string, list: readonly string[]): Pick<OpenCodeToolView, 'input' | 'inputKind'> {
  const first = list[0];
  if (!first) return {};
  if (action === 'shell') {
    // O pedido cobre todos os comandos (um compound vira vários recursos): o detalhe mostra os todos.
    const view = toolView('Bash', { command: list.length > 1 ? list.join('\n') : first });
    return view.input ? { input: view.input, inputKind: view.inputKind ?? 'command' } : {};
  }
  // Os recursos precisam de separador visível: `truncate` (linha()) colapsa quebra de linha, então "\n" aqui
  // viraria uma linha corrida. O "·" é o mesmo do resumo das perguntas no registry.
  if (list.length > 1 || !fitsTitle(first)) return { input: line(list.join(' · '), INPUT_MAX), inputKind: 'text' };
  return {};
}

/** Resumo das ações que não têm ferramenta equivalente no Claude Code (describeTool cairia no "Usando <nome>"). */
function ownText(action: string): { text: string; icon: string } | undefined {
  switch (action) {
    case 'question':
      return { text: 'Pedindo para perguntar', icon: '❓' };
    case 'external_directory':
      return { text: 'Acessando uma pasta fora do projeto', icon: '📁' };
    case 'execute':
      return { text: 'Pedindo para executar em Code Mode', icon: '🧰' };
    default:
      return undefined;
  }
}

/** Um recurso de cada vez na ferramenta equivalente, com o campo que ela lê. */
function equivalentInput(tool: string, resource: string | undefined): Rec {
  const field = FIELD[tool];
  return resource && field ? { [field]: resource } : {};
}

/** Título, resumo e argumentos de um pedido do OpenCode. */
export function openCodeToolView(action: string, raw: Rec, cwd?: string): OpenCodeToolView {
  if (action === 'Question') {
    // Pergunta de múltipla escolha (registrada pelo embrulho da ferramenta no plugin, não pelo
    // permission.asked): o input real traz `questions`, e o cartão mostra as opções. Sem perguntas
    // válidas não há o que responder — o registro recusa (`unsupported-tool`).
    const desc = describeTool('Question', raw);
    return { title: 'Question', text: desc.text, icon: desc.icon, ...(desc.questions?.length ? { questions: desc.questions } : {}) };
  }
  const list = resources(raw.resources);
  const first = list[0];
  const panel = argPanel(action, list);

  // Título com a ação REAL do OpenCode: é ela que diz o que está sendo pedido.
  // `question` e `execute` sempre pedem "*": não dizem qual recurso, então ficam fora do título.
  const arg = first && action !== 'question' && action !== 'execute' ? relPath(first, cwd) : undefined;
  const more = list.length > 1 ? ` +${list.length - 1}` : '';
  const title = arg ? `${action}(${line(arg, TITLE_ARG_MAX)})${more}` : action;

  const own = ownText(action);
  if (own) return { title, text: own.text, icon: own.icon, ...panel };

  const tool = EQUIVALENT[action] ?? action;
  const desc = describeTool(tool, equivalentInput(tool, first));

  // Mais de um recurso coberto pelo MESMO pedido (um compound do shell, um patch em vários arquivos): o resumo
  // do primeiro esconderia o resto, e aprovar vale para todos.
  let text = desc.text;
  if (list.length > 1) {
    if (action === 'shell') text = `Rodando ${list.length} comandos`;
    else if (action === 'edit') text = `Editando ${list.length} arquivos`;
    else text = `${desc.text} +${list.length - 1}`;
  }

  return { title, text: truncate(text, TEXT_MAX), icon: desc.icon, ...panel };
}
