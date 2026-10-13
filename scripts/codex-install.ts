// Instala (ou remove) os hooks do Habblaud no OpenAI Codex (CLI `codex` e o app desktop). Roda no HOST, com tsx:
//
//   npm run codex:install     # acrescenta os grupos do Habblaud em <CODEX_HOME>/hooks.json (backup antes)
//   npm run codex:uninstall   # tira só os grupos do Habblaud (os outros hooks ficam)
//   npm run codex:status      # mostra, por pasta, se os grupos estão lá e se o Habblaud está respondendo
//   (opções: --dry-run, --conta <id>, --port <n>, --espera <s>)
//
// O hook (mod/habblaud-codex/hook.mjs) manda ao escritório o que as sessões do Codex fazem (SessionStart,
// UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart, SubagentStop, SessionEnd) e deixa aprovar ou recusar
// pelo escritório os pedidos de aprovação (PermissionRequest): o Codex espera o hook por até a espera configurada
// (padrão 25 s) e, sem decisão, segue a aprovação normal no terminal.
//
// Pastas: as mesmas contas do Codex que o servidor acompanha: HABBLAUD_CODEX_DIRS (lista separada por vírgula;
// substitui tudo) ou CODEX_HOME e as pastas ~/.codex* do Codex (isCodexHome). Pasta do Claude Code nunca é tocada.
//
// Em <pasta>/hooks.json ({description?, hooks: {<Evento>: [{matcher?, hooks: [handler]}]}}) só mudam as listas dos
// eventos acima: entra, no FIM da lista de cada um, um grupo sem matcher com o handler
// {type: "command", command: 'node "<Habblaud>/mod/habblaud-codex/hook.mjs"', ...}. O resto do arquivo fica como
// está. Antes de gravar, uma cópia vai para hooks.json.habblaud-backup-<data>.
//
// Windows: o Codex roda cada hook como `pwsh.exe -NoProfile -Command "<comando>"` (sem shell configurado, `cmd /C`).
// Com um Node 22+ no PATH, o comando é `node "<caminho com />"`, que roda no PowerShell, no cmd e no sh; senão,
// `& "<outro Node 22+>" "<caminho>"`, a forma do PowerShell (o install avisa: no cmd e no sh ela não roda).
//
// Confiança: o Codex só roda um hook novo ou alterado depois que você o aprova em /hooks, e guarda essa aprovação
// (config.toml, [hooks.state."<hooks.json>:<evento>:<grupo>:<handler>"].trusted_hash) pela POSIÇÃO do grupo e por um
// hash do evento, do matcher e do handler (comando, timeout, async, statusMessage). Por isso o instalador:
// - nunca grava a confiança nem mexe no config.toml (quem aprova é você, em /hooks);
// - sempre ACRESCENTA no fim e, ao atualizar, troca o handler do Habblaud NO MESMO lugar: os grupos de outros apps
//   (ex.: o Orca) nunca mudam de posição nem de conteúdo; uma cópia repetida do Habblaud só sai se isso não mudar a
//   posição de nenhum handler de outro app (senão fica, com aviso);
// - usa um comando sem opções e valores fixos (porta e espera ficam em ~/.habblaud/codex-hook.json, que o hook lê):
//   mudar a porta não pede aprovação nova; mudar a espera muda o timeout do PermissionRequest e pede.
// Rodar de novo não duplica (o grupo do Habblaud é reconhecido pelo comando).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isClaudeDir } from '../server/accounts/detect';
import { discoverCodexDirs } from '../server/sources/codex/accounts';
import { quotePath, readSettings, tildify, writeSettings, type Settings } from './statusline-install';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_SCRIPT = join(ROOT, 'mod', 'habblaud-codex', 'hook.mjs');
/** O hook do Habblaud é reconhecido pelo caminho do script no comando (em qualquer pasta do repositório). */
const HOOK_MARK = /habblaud-codex[\\/]+hook\.mjs/;
export const DEFAULT_PORT = 4747;
export const DEFAULT_WAIT_S = 25;
export const MIN_WAIT_S = 5;
export const MAX_WAIT_S = 120;
/** Eventos só de observação: em segundo plano (async), sem atrasar a sessão. */
export const OBSERVE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop'] as const;
/** Todos os eventos em que o Habblaud entra. */
export const EVENTS = [...OBSERVE_EVENTS, 'SessionEnd', 'PermissionRequest'] as const;
/** Tempo limite dos eventos de observação (o hook manda o evento com prazo de 1,5 s). */
export const OBSERVE_TIMEOUT_S = 5;
/** SessionEnd: o Codex sempre o roda em primeiro plano, com 1 s por padrão (máx. 3). */
export const SESSION_END_TIMEOUT_S = 1;
/** Folga do tempo limite do PermissionRequest sobre a espera (node subindo, evento e registro; o hook desiste antes). */
export const PERMISSION_SLACK_S = 10;
export const STATUS_MESSAGE = tr('Aguardando resposta no Habblaud…');
/** Configuração lida pelo hook (porta e espera), em ~/.habblaud. */
export const CONFIG_NAME = 'codex-hook.json';

/** Versão mínima do Node para o hook (o mesmo `engines` do Habblaud, na parte que importa: fetch e AbortSignal). */
export const MIN_NODE_MAJOR = 22;

const USAGE = tr(
  'Uso: npm run codex:<install|uninstall|status> [-- opções]\n\n  install     acrescenta os hooks do Habblaud no hooks.json de cada pasta do Codex (faz backup antes)\n  uninstall   tira os hooks do Habblaud de cada pasta (os outros hooks ficam)\n  status      mostra se os hooks estão lá e se o Habblaud está respondendo\n\nOpções:\n  --dry-run        mostra o que mudaria, sem gravar nada\n  --conta <id>     só a pasta desta conta (o nome da pasta, ex.: .codex)\n  --port <n>       porta do Habblaud (padrão: HABBLAUD_PORT ou {0})\n  --espera <s>     quanto o Codex espera sua resposta no Habblaud antes de pedir a aprovação no terminal\n                   (padrão: {1} s; entre {2} e {3})\n  --node <caminho> o Node {4}+ que roda os hooks (padrão: o `node` que o Codex acha, se for {5}+: o do shell\n                   de login no macOS/Linux, o do PATH no Windows; senão o primeiro {6}+ entre /opt/homebrew/bin,\n                   /usr/local/bin e o deste comando; no Windows, o deste comando, na forma do PowerShell)\n  -h, --help       mostra esta ajuda\n\nPastas: HABBLAUD_CODEX_DIRS (lista separada por vírgula) ou CODEX_HOME e as pastas ~/.codex* do Codex.\nDepois de instalar, abra o Codex e aprove os hooks do Habblaud em /hooks.',
  [DEFAULT_PORT, DEFAULT_WAIT_S, MIN_WAIT_S, MAX_WAIT_S, MIN_NODE_MAJOR, MIN_NODE_MAJOR, MIN_NODE_MAJOR],
);

// ---------------------------------------------------------------------------------------------
// Funções puras (testadas em server/test/codex-install.test.ts)
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

/**
 * `node "<hook>"` (ou `"<node>" "<hook>"` com um Node escolhido, ver chooseNode), sem opções: o comando entra no hash
 * da confiança do Codex.
 */
export function hookCommand(scriptPath: string, nodeBin?: string): string {
  return `${nodeBin ? quotePath(nodeBin) : 'node'} ${quotePath(scriptPath)}`;
}

/**
 * O comando no Windows, onde o Codex roda cada hook como `pwsh.exe -NoProfile -Command "<comando>"` (sem shell
 * configurado, `cmd /C "<comando>"`): `node "<hook>"`, com barras `/` e aspas duplas, roda no PowerShell, no cmd e no
 * sh. Com um Node escolhido (o do PATH é antigo ou não deu para conferir): `& "<node>" "<hook>"`, a forma do PowerShell
 * (no cmd e no sh, não roda). Aspas simples, como as do quotePath, são erro de sintaxe no PowerShell nessa posição.
 */
export function windowsHookCommand(scriptPath: string, nodeBin?: string): string {
  const q = (p: string) => `"${p.split('\\').join('/')}"`;
  return nodeBin ? `& ${q(nodeBin)} ${q(scriptPath)}` : `node ${q(scriptPath)}`;
}

/** Caracteres que o PowerShell ($ e a crase) e o cmd (%VAR%) trocam dentro das aspas duplas do comando do Windows. */
const WINDOWS_EXPANDS = /[$`%]/;

/** PATHEXT do Windows quando a variável não vem. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Variável de ambiente sem diferenciar maiúsculas (no Windows, uma cópia do process.env traz `Path`, não `PATH`). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function isFileOnDisk(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Windows: o programa que o PowerShell e o cmd rodam para `name`. Para cada pasta do PATH, em ordem, cada extensão do
 * PATHEXT; o 1º arquivo que existir decide, mesmo que seja um script (.cmd). Pasta vazia ou relativa não conta.
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv, isFile: (p: string) => boolean = isFileOnDisk): string | undefined {
  const exts = (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  for (const raw of (envValue(env, 'PATH') ?? '').split(';')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !win32.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const p = win32.join(dir, `${name}${ext}`);
      if (isFile(p)) return p;
    }
  }
  return undefined;
}

/** Roda `<bin> <args>` sem shell e devolve a saída (lança se falhar). */
export type ExecFn = (bin: string, args: string[]) => string;

function execNoShell(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
}

/**
 * A sonda do chooseNode: `probe(undefined)` = versão do `node` que o Codex acha ao rodar o hook; `probe(caminho)` =
 * versão daquele binário. Sempre sem shell (execFileSync). macOS/Linux: o `node` do shell de login (`$SHELL -lc`, ou
 * /bin/sh). Windows: o `node` do PATH com o PATHEXT (findOnPath), executado direto; o $SHELL (o Git Bash o define) não
 * conta, porque o Codex roda o hook no PowerShell. Falha (inclusive um node.cmd, que não roda sem shell) = undefined.
 */
export function createNodeProbe(opts: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; exec?: ExecFn; isFile?: (p: string) => boolean }): (bin: string | undefined) => string | undefined {
  const exec = opts.exec ?? execNoShell;
  const version = (bin: string, args: string[]): string | undefined => {
    try {
      return exec(bin, args).trim().split(/\r?\n/).pop()?.trim() || undefined;
    } catch {
      return undefined;
    }
  };
  return (bin) => {
    if (bin) return version(bin, ['--version']);
    if (opts.platform !== 'win32') return version(opts.env.SHELL || '/bin/sh', ['-lc', 'node --version']);
    const found = findOnPath('node', opts.env, opts.isFile);
    return found ? version(found, ['--version']) : undefined;
  };
}

/** Major de uma versão como `node --version` imprime ("v24.17.0" → 24). */
export function nodeMajor(version: string | undefined): number | undefined {
  const m = /^v?(\d+)\./.exec(version?.trim() ?? '');
  return m ? Number(m[1]) : undefined;
}

/**
 * O Node dos hooks. No macOS/Linux, o Codex roda o hook por `$SHELL -lc`: um shell de LOGIN, que no zsh não lê o
 * .zshrc (onde o nvm costuma estar), então o `node` dele pode ser outro, e antigo. No Windows, pelo PowerShell (ou cmd),
 * que acha o `node` pelo PATH. `probe(undefined)` = versão do `node` desse shell (ver createNodeProbe);
 * `probe(caminho)` = versão daquele binário. `node` do shell com Node 22+: `node` (comando curto, sobrevive a trocas de
 * versão). Senão, o primeiro candidato 22+ com caminho absoluto; nenhum: `node` mesmo, com aviso.
 */
export function chooseNode(probe: (bin: string | undefined) => string | undefined, candidates: readonly string[]): { bin?: string; login?: string; chosen?: string } {
  const login = probe(undefined);
  if ((nodeMajor(login) ?? 0) >= MIN_NODE_MAJOR) return { login };
  for (const bin of candidates) {
    const v = probe(bin);
    if ((nodeMajor(v) ?? 0) >= MIN_NODE_MAJOR) return { bin, login, chosen: v };
  }
  return { login };
}

/** Tempo limite do PermissionRequest para uma espera (s). */
export function permissionTimeout(waitS: number): number {
  return waitS + PERMISSION_SLACK_S;
}

/** O handler do Habblaud para um evento, como o Codex o lê em hooks.<Evento>[].hooks[]. */
export function handlerFor(event: string, command: string, waitS: number): Rec {
  if (event === 'PermissionRequest') return { type: 'command', command, timeout: permissionTimeout(waitS), statusMessage: STATUS_MESSAGE };
  if (event === 'SessionEnd') return { type: 'command', command, timeout: SESSION_END_TIMEOUT_S };
  return { type: 'command', command, async: true, timeout: OBSERVE_TIMEOUT_S };
}

export function isOurHandler(h: unknown): boolean {
  const r = rec(h);
  return !!r && typeof r.command === 'string' && HOOK_MARK.test(r.command);
}

/** JSON com as chaves em ordem (para comparar handlers sem depender da ordem em que foram gravados). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const r = rec(v);
  if (!r) return JSON.stringify(v) ?? 'null';
  return `{${Object.keys(r)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`)
    .join(',')}}`;
}

/** Caminho do script num comando instalado (entre aspas duplas ou simples, ou sem aspas). */
export function scriptPathOf(command: string): string | undefined {
  const m = /("[^"]*habblaud-codex[\\/]+hook\.mjs"|'(?:[^']|'\\'')*habblaud-codex[\\/]+hook\.mjs'|\S*habblaud-codex[\\/]+hook\.mjs)/.exec(command);
  if (!m) return undefined;
  const q = m[1];
  if (q.startsWith('"')) return q.slice(1, -1);
  if (q.startsWith("'")) return q.slice(1, -1).replace(/'\\''/g, "'");
  return q;
}

export type PlanAction =
  | {
      action: 'install';
      file: Settings;
      message: string;
      /** Eventos com hook novo ou alterado (aprovar em /hooks). */
      approve: string[];
      /** Comandos do Habblaud trocados pelo novo: o Codex só volta a rodar o hook depois de aprovado de novo em /hooks. */
      replaced: string[];
      /** Eventos em que cópias repetidas do Habblaud saíram (sem mudar a posição de nenhum hook de outro app). */
      deduped: string[];
    }
  | { action: 'uninstall'; file: Settings; message: string; /** Eventos em que grupos de outros apps mudaram de posição. */ shifted: string[] }
  | { action: 'none'; message: string }
  | { action: 'skip'; message: string };

/** `hooks` num formato que dá para editar (ou o motivo para não mexer). */
function hooksOf(file: Settings): Rec | string {
  if (file.hooks !== undefined && !rec(file.hooks)) return tr('"hooks" em formato desconhecido; nada foi alterado');
  const hooks = rec(file.hooks) ?? {};
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) return tr('"hooks.{0}" em formato desconhecido; nada foi alterado', [event]);
  }
  return hooks;
}

/** Posições (grupo, handler) dos handlers do Habblaud numa lista de grupos, na ordem. */
function ourPositions(list: unknown[]): Array<{ g: number; h: number }> {
  const out: Array<{ g: number; h: number }> = [];
  list.forEach((g, gi) => {
    const hooks = rec(g)?.hooks;
    if (Array.isArray(hooks)) hooks.forEach((h, hi) => isOurHandler(h) && out.push({ g: gi, h: hi }));
  });
  return out;
}

/** Posições (grupo:handler) dos handlers de OUTROS apps, na ordem: a chave da confiança deles no Codex. */
function otherPositions(list: unknown[]): string {
  const out: string[] = [];
  list.forEach((g, gi) => {
    const hooks = rec(g)?.hooks;
    if (Array.isArray(hooks)) hooks.forEach((h, hi) => !isOurHandler(h) && out.push(`${gi}:${hi}`));
  });
  return out.join(',');
}

/** Tira os handlers nas posições dadas (do fim para o começo, sem bagunçar os índices); grupo que fica vazio por isso sai. */
function removeAt(list: unknown[], positions: Array<{ g: number; h: number }>): unknown[] {
  const out = [...list];
  const byGroup = new Map<number, number[]>();
  for (const p of positions) byGroup.set(p.g, [...(byGroup.get(p.g) ?? []), p.h]);
  for (const g of [...byGroup.keys()].sort((a, b) => b - a)) {
    const group = rec(out[g])!;
    const drop = new Set(byGroup.get(g));
    const kept = (group.hooks as unknown[]).filter((_, i) => !drop.has(i));
    if (kept.length) out[g] = { ...group, hooks: kept };
    else out.splice(g, 1);
  }
  return out;
}

/**
 * Tira as cópias repetidas do Habblaud (a primeira fica) sem mudar a posição de nenhum handler de outro app. A
 * confiança do Codex vai pela posição (grupo:handler), então fica a cópia que vem antes do handler de outro app no
 * mesmo grupo ou num grupo inteiro antes do grupo dele. Do fim para o começo: tirar uma cópia de trás nunca mexe nas da
 * frente, e a da frente pode ficar livre para sair depois disso.
 */
function dropDuplicates(list: unknown[]): { list: unknown[]; removed: number } {
  const others = otherPositions(list);
  let out = list;
  let removed = 0;
  for (const p of ourPositions(list).slice(1).reverse()) {
    const next = removeAt(out, [p]);
    if (otherPositions(next) !== others) continue;
    out = next;
    removed++;
  }
  return { list: out, removed };
}

/**
 * Plano de instalação para um hooks.json já lido (não grava nada). Evento sem o Habblaud: um grupo novo no FIM da
 * lista. Com ele: o handler é trocado no MESMO lugar se mudou (comando, caminho do repositório, espera); cópias
 * repetidas saem quando isso não desloca o hook de outro app (dropDuplicates).
 */
export function planInstall(file: Settings, command: string, waitS: number): PlanAction {
  const parsed = hooksOf(file);
  if (typeof parsed === 'string') return { action: 'skip', message: parsed };
  const hooks: Rec = { ...parsed };
  const added: string[] = [];
  const updated: string[] = [];
  const deduped: string[] = [];
  const replaced = new Set<string>();
  for (const event of EVENTS) {
    const handler = handlerFor(event, command, waitS);
    let list = [...((hooks[event] as unknown[] | undefined) ?? [])];
    const found = ourPositions(list);
    if (!found.length) {
      list.push({ hooks: [handler] });
      added.push(event);
    } else {
      const first = found[0];
      const group = rec(list[first.g])!;
      const handlers = [...(group.hooks as unknown[])];
      const old = rec(handlers[first.h])!;
      if (canonical(old) !== canonical(handler)) {
        if (old.command !== command) replaced.add(String(old.command));
        handlers[first.h] = handler;
        list[first.g] = { ...group, hooks: handlers };
        updated.push(event);
      }
      // Cópias repetidas (editadas à mão): o hook rodaria uma vez por cópia. Tirar uma cópia de trás não muda a chave
      // nem o hash da que fica: não entra no `approve`.
      const dedup = found.length > 1 ? dropDuplicates(list) : undefined;
      if (dedup?.removed) {
        list = dedup.list;
        deduped.push(event);
      }
    }
    hooks[event] = list;
  }
  if (!added.length && !updated.length && !deduped.length) return { action: 'none', message: tr('já instalado') };
  const parts = [
    added.length ? (updated.length || deduped.length ? tr('instalado em {0}', [added.join(', ')]) : tr('instalado ({0} eventos)', [added.length])) : '',
    updated.length ? tr('atualizado em {0}', [updated.join(', ')]) : '',
    deduped.length ? tr('cópias repetidas tiradas em {0}', [deduped.join(', ')]) : '',
  ].filter(Boolean);
  return { action: 'install', file: { ...file, hooks }, message: parts.join('; '), approve: [...added, ...updated], replaced: [...replaced], deduped };
}

/**
 * Plano de remoção: tira só os handlers do Habblaud (e os grupos que ficarem vazios por isso; a lista de um evento que
 * esvaziar sai, e `hooks` também, se ficar vazio). Grupos de outros apps que vinham DEPOIS de um grupo do Habblaud
 * sobem uma posição: o Codex pede para aprová-los de novo em /hooks (`shifted`).
 */
export function planUninstall(file: Settings): PlanAction {
  const parsed = hooksOf(file);
  if (typeof parsed === 'string') return { action: 'skip', message: parsed };
  const hooks: Rec = { ...parsed };
  let removed = 0;
  const shifted: string[] = [];
  for (const [event, raw] of Object.entries(hooks)) {
    const list = raw as unknown[];
    const found = ourPositions(list);
    if (!found.length) continue;
    const next = removeAt(list, found);
    removed += found.length;
    // Algum handler de outro app mudou de posição (vinha depois de um do Habblaud)?
    if (otherPositions(list) !== otherPositions(next)) shifted.push(event);
    if (next.length) hooks[event] = next;
    else delete hooks[event];
  }
  if (!removed) return { action: 'none', message: tr('não estava instalado') };
  const next: Settings = { ...file };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return { action: 'uninstall', file: next, message: tr('hooks do Habblaud removidos'), shifted };
}

export interface InstallState {
  /** Eventos com o handler do Habblaud (o 1º, se houver cópias) igual ao esperado. */
  ok: string[];
  /** Eventos com o handler do Habblaud diferente (outro comando, outro caminho ou outra espera). */
  outdated: string[];
  missing: string[];
  /** Eventos com mais de uma cópia do hook do Habblaud (ele roda uma vez por cópia); ausente = nenhum. */
  duplicates?: string[];
  /** Caminhos do script nos handlers instalados. */
  paths: string[];
}

/** O que está instalado num hooks.json (para o status). */
export function installState(file: Settings, command: string, waitS: number): InstallState {
  const parsed = hooksOf(file);
  const hooks = typeof parsed === 'string' ? {} : parsed;
  const state: InstallState = { ok: [], outdated: [], missing: [], paths: [] };
  const duplicates: string[] = [];
  for (const event of EVENTS) {
    const list = (hooks[event] as unknown[] | undefined) ?? [];
    const found = ourPositions(list);
    if (!found.length) {
      state.missing.push(event);
      continue;
    }
    if (found.length > 1) duplicates.push(event);
    const group = rec(list[found[0].g])!;
    const h = rec((group.hooks as unknown[])[found[0].h])!;
    const path = typeof h.command === 'string' ? scriptPathOf(h.command) : undefined;
    if (path && !state.paths.includes(path)) state.paths.push(path);
    (canonical(h) === canonical(handlerFor(event, command, waitS)) ? state.ok : state.outdated).push(event);
  }
  return duplicates.length ? { ...state, duplicates } : state;
}

/** Aviso das cópias repetidas que o install deixa no lugar (linhas de saída, a 1ª depois do rótulo da pasta). */
function stuckDuplicates(events: string[]): string[] {
  return [
    `mais de uma cópia do hook do Habblaud em ${events.join(', ')} (ele roda uma vez por cópia).`,
    '    Tirar a repetida mudaria a posição do hook de outro app nesse evento (e o Codex pediria para aprová-lo de novo',
    '    em /hooks), por isso ela fica; se quiser, tire-a à mão no hooks.json.',
  ];
}

/**
 * Pastas do Codex: as MESMAS que o servidor acompanha (discoverCodexDirs da fonte do Codex: HABBLAUD_CODEX_DIRS, que
 * substitui tudo, ou CODEX_HOME e as pastas ~/.codex* com cara de Codex; ~/.codex primeiro). Pasta do Claude Code
 * listada por engano fica de fora (`refused`).
 */
export function discoverCodexHomes(env: NodeJS.ProcessEnv, home: string): { dirs: string[]; refused: string[] } {
  const dirs: string[] = [];
  const refused: string[] = [];
  for (const p of discoverCodexDirs(env, home)) (isClaudeDir(p) ? refused : dirs).push(p);
  return { dirs, refused };
}

// ---------------------------------------------------------------------------------------------
// Efeitos (arquivos e o /api/health do Habblaud)
// ---------------------------------------------------------------------------------------------

export interface HookConfig {
  port: number;
  permissionTimeoutS: number;
}

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  /** Só a pasta desta conta (basename). */
  account?: string;
  port: number;
  waitS: number;
  /** --node: o Node dos hooks, com caminho absoluto (sem ela, chooseNode). */
  node?: string;
}

export interface Health {
  permissions?: boolean;
  messages?: boolean;
  codexEvents?: boolean;
}

export interface RunContext {
  env: NodeJS.ProcessEnv;
  home: string;
  now: Date;
  hookPath: string;
  out: (line: string) => void;
  /** Consulta o /api/health do Habblaud (testes injetam um falso). */
  health?: (port: number) => Promise<Health | undefined>;
  /** Plataforma em que o Codex roda os hooks (ausente = process.platform). win32: windowsHookCommand. */
  platform?: NodeJS.Platform;
  /** Versão de um Node (ver chooseNode e createNodeProbe); ausente = não consulta e usa `node` (os testes não rodam shells). */
  nodeProbe?: (bin: string | undefined) => string | undefined;
  /** Candidatos a Node quando o do shell de login (no Windows, o do PATH) é antigo. */
  nodeCandidates?: readonly string[];
}

class FatalError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  let account: string | undefined;
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  let waitS = DEFAULT_WAIT_S;
  let node: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--conta') {
      account = argv[++i];
      if (!account) throw new FatalError(tr('--conta precisa do nome da pasta da conta (ex.: .codex).'));
    } else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError(tr('--port precisa de um número entre 1 e 65535.'));
    } else if (a === '--espera') {
      waitS = Number(argv[++i]);
      if (!Number.isInteger(waitS) || waitS < MIN_WAIT_S || waitS > MAX_WAIT_S) throw new FatalError(tr('--espera precisa de um número de segundos entre {0} e {1}.', [MIN_WAIT_S, MAX_WAIT_S]));
    } else if (a === '--node') {
      node = argv[++i];
      if (!node || !isAbsolute(node)) throw new FatalError(tr('--node precisa do caminho absoluto de um Node 22+ (ex.: /opt/homebrew/bin/node).'));
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(tr('opção desconhecida: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new FatalError(tr('diga o que fazer: install, uninstall ou status.\n\n{0}', [USAGE]));
  return { command, dryRun, account, port, waitS, ...(node ? { node } : {}) };
}

export function configPath(home: string): string {
  return join(home, '.habblaud', CONFIG_NAME);
}

/** Configuração gravada para o hook (undefined = não existe ou ilegível). */
export function readHookConfig(home: string): Partial<HookConfig> | undefined {
  try {
    const j = rec(JSON.parse(readFileSync(configPath(home), 'utf8')));
    if (!j) return undefined;
    const out: Partial<HookConfig> = {};
    if (typeof j.port === 'number') out.port = j.port;
    if (typeof j.permissionTimeoutS === 'number') out.permissionTimeoutS = j.permissionTimeoutS;
    return out;
  } catch {
    return undefined;
  }
}

/** Grava a configuração do hook se mudou. Devolve true se gravou. */
function writeHookConfig(home: string, cfg: HookConfig): boolean {
  const cur = readHookConfig(home);
  if (cur?.port === cfg.port && cur.permissionTimeoutS === cfg.permissionTimeoutS) return false;
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(configPath(home), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o644 });
  return true;
}

async function fetchHealth(port: number): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return undefined;
    return (await res.json()) as Health;
  } catch {
    return undefined;
  }
}

/** Executa o comando para todas as pastas do Codex. Devolve o código de saída. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { env, home, out } = ctx;
  const found = discoverCodexHomes(env, home);
  for (const p of found.refused) out(tr('! {0}: é uma pasta do Claude Code, não do Codex; fica de fora.', [tildify(p, home)]));
  const dirs = opts.account ? found.dirs.filter((d) => basename(d) === opts.account) : found.dirs;
  if (!dirs.length) {
    out(
      opts.account
        ? tr('Nenhuma pasta do Codex com o nome {0} (pastas encontradas: {1}).', [opts.account, found.dirs.map((d) => basename(d)).join(', ') || tr('nenhuma')])
        : tr('Nenhuma pasta do Codex encontrada (~/.codex ou CODEX_HOME). Use HABBLAUD_CODEX_DIRS se ela estiver em outro lugar.'),
    );
    return 1;
  }
  const win = (ctx.platform ?? process.platform) === 'win32';
  let nodeBin = opts.node;
  if (!nodeBin && ctx.nodeProbe) {
    const pick = chooseNode(ctx.nodeProbe, ctx.nodeCandidates ?? []);
    nodeBin = pick.bin;
    const where = win ? tr('O `node` do PATH (o que o Codex roda nos hooks, pelo PowerShell ou pelo cmd)') : tr('O shell de login (onde o Codex roda os hooks)');
    const has = win ? (pick.login ? tr('é o Node {0}', [pick.login]) : tr('não existe ou não respondeu')) : tr('tem {0}', [pick.login ? `Node ${pick.login}` : tr('nenhum Node')]);
    if (pick.bin && win) {
      out(tr('! {0} {1}; o hook precisa do {2}+ e vai usar {3} ({4}) na forma do PowerShell:', [where, has, MIN_NODE_MAJOR, tildify(pick.bin, home), pick.chosen]));
      out(tr('    & "<node>" "<hook>" roda no PowerShell, o shell dos hooks do Codex no Windows, mas não roda no cmd nem no sh. Para'));
      out(tr('    o comando curto (node "<hook>", que roda nos três), ponha um Node {0}+ no PATH e rode de novo.', [MIN_NODE_MAJOR]));
    } else if (pick.bin) out(tr('i {0} {1}; o hook precisa do {2}+ e vai usar {3} ({4}).', [where, has, MIN_NODE_MAJOR, tildify(pick.bin, home), pick.chosen]));
    else if ((nodeMajor(pick.login) ?? 0) < MIN_NODE_MAJOR)
      out(tr('! {0} {1} e não achei um Node {2}+: os hooks podem falhar. Use --node <caminho de um Node {3}+>.', [where, has, MIN_NODE_MAJOR, MIN_NODE_MAJOR]));
  } else if (nodeBin && win) {
    out(tr('i --node no Windows: o comando fica na forma do PowerShell (& "<node>" "<hook>"), o shell dos hooks do Codex; no cmd e no sh, ele não roda.'));
  }
  const command = win ? windowsHookCommand(ctx.hookPath, nodeBin) : hookCommand(ctx.hookPath, nodeBin);
  if (win && opts.command !== 'uninstall') {
    // No install, recusa (o hook gravado falharia calado); no status, só avisa.
    const mark = opts.command === 'install' ? '✗' : '!';
    const expands = tr(' tem $, crase ou %: no Windows, o PowerShell e o cmd trocam esses caracteres dentro das aspas e o hook falharia sem aviso.');
    const bad = [
      WINDOWS_EXPANDS.test(ctx.hookPath) && tr('{0} O caminho do hook ({1}){2} Ponha o Habblaud numa pasta sem eles e rode de novo.', [mark, tildify(ctx.hookPath, home), expands]),
      nodeBin && WINDOWS_EXPANDS.test(nodeBin) && tr('{0} O caminho do Node ({1}){2} Use um Node {3}+ numa pasta sem eles (--node <caminho>).', [mark, tildify(nodeBin, home), expands, MIN_NODE_MAJOR]),
    ].filter((line): line is string => typeof line === 'string');
    for (const line of bad) out(line);
    if (bad.length && opts.command === 'install') {
      out(tr('✗ Instalação recusada: nada foi gravado.'));
      return 1;
    }
  }
  let failures = 0;
  let changed = 0;
  const approve = new Set<string>();
  const replaced = new Set<string>();
  for (const dir of dirs) {
    const file = join(dir, 'hooks.json');
    const label = `${basename(dir)} (${tildify(file, home)})`;
    const read = readSettings(file);
    if ('error' in read) {
      out(`✗ ${label}: ${read.error}`);
      failures++;
      continue;
    }
    if (opts.command === 'status') {
      const cfgWait = readHookConfig(home)?.permissionTimeoutS;
      const wait = typeof cfgWait === 'number' ? cfgWait : opts.waitS;
      const st = installState(read.settings, command, wait);
      if (!st.ok.length && !st.outdated.length) {
        out(tr('• {0}: não instalado', [label]));
        continue;
      }
      for (const p of st.paths) {
        if (resolve(p) === resolve(ctx.hookPath)) continue;
        const gone = !existsSync(p) ? tr(' (esse arquivo não existe mais: os hooks falham e nada chega ao escritório)') : '';
        out(tr('! {0}: os hooks apontam para {1}{2}; rode npm run codex:install para atualizar', [label, p, gone]));
      }
      if (st.outdated.length) out(tr('! {0}: diferente do esperado em {1}; rode npm run codex:install para atualizar', [label, st.outdated.join(', ')]));
      if (st.duplicates) {
        // As mesmas que o install deixaria (tirá-las mudaria a posição do hook de outro app): rodar o install não resolve.
        const plan = planInstall(read.settings, command, wait);
        const stuck = (plan.action === 'install' ? installState(plan.file, command, wait).duplicates : st.duplicates) ?? [];
        const fixable = st.duplicates.filter((e) => !stuck.includes(e));
        if (fixable.length) out(tr('! {0}: mais de uma cópia do hook do Habblaud em {1}; rode npm run codex:install para tirar as repetidas', [label, fixable.join(', ')]));
        if (stuck.length) {
          const [first, ...rest] = stuckDuplicates(stuck);
          out(`! ${label}: ${first}`);
          for (const l of rest) out(l);
        }
      }
      if (st.missing.length) out(tr('! {0}: faltando em {1}; rode npm run codex:install', [label, st.missing.join(', ')]));
      out(tr('• {0}: instalado em {1} de {2} eventos', [label, st.ok.length + st.outdated.length, EVENTS.length]));
      continue;
    }
    const plan = opts.command === 'install' ? planInstall(read.settings, command, opts.waitS) : planUninstall(read.settings);
    // Cópias repetidas que o install deixa no lugar: avisadas depois da linha da pasta.
    const stuck = opts.command === 'install' && plan.action !== 'skip' ? installState(plan.action === 'install' ? plan.file : read.settings, command, opts.waitS).duplicates : undefined;
    const warnStuck = () => {
      if (!stuck) return;
      const [first, ...rest] = stuckDuplicates(stuck);
      out(`! ${label}: ${first}`);
      for (const l of rest) out(l);
    };
    if (plan.action === 'none') {
      out(`= ${label}: ${plan.message}`);
      warnStuck();
      continue;
    }
    if (plan.action === 'skip') {
      out(`✗ ${label}: ${plan.message}`);
      failures++;
      continue;
    }
    if (opts.dryRun) {
      out(tr('~ {0}: {1} (simulação: nada gravado)', [label, plan.message]));
      out(`    hooks → ${JSON.stringify(plan.file.hooks ?? null)}`);
      warnStuck();
      continue;
    }
    try {
      const backup = writeSettings(file, plan.file, read.raw, ctx.now);
      out(`✓ ${label}: ${plan.message}${backup ? tr(' · backup em {0}', [tildify(backup, home)]) : ''}`);
      warnStuck();
      changed++;
      if (plan.action === 'install') {
        for (const e of plan.approve) approve.add(e);
        for (const c of plan.replaced) replaced.add(c);
      }
      if (plan.action === 'uninstall' && plan.shifted.length) {
        out(tr('    Hooks de outros apps que vinham depois dos do Habblaud ({0}) mudaram de posição:', [plan.shifted.join(', ')]));
        out(tr('    o Codex vai pedir para aprová-los de novo em /hooks.'));
      }
    } catch (err) {
      out(tr('✗ {0}: não consegui gravar ({1})', [label, (err as Error).message]));
      failures++;
    }
  }
  const cfgFile = tildify(configPath(home), home);
  if (opts.command === 'install') {
    const cfg: HookConfig = { port: opts.port, permissionTimeoutS: opts.waitS };
    if (opts.dryRun) out(tr('~ configuração do hook ({0}): porta {1}, espera {2} s (simulação: nada gravado)', [cfgFile, cfg.port, cfg.permissionTimeoutS]));
    else {
      try {
        if (writeHookConfig(home, cfg)) out(tr('✓ configuração do hook gravada em {0} (porta {1}, espera {2} s)', [cfgFile, cfg.port, cfg.permissionTimeoutS]));
        else out(tr('= configuração do hook ({0}): porta {1}, espera {2} s', [cfgFile, cfg.port, cfg.permissionTimeoutS]));
      } catch (err) {
        out(tr('✗ não consegui gravar {0} ({1}): o hook usa a porta {2} e espera {3} s', [cfgFile, (err as Error).message, DEFAULT_PORT, DEFAULT_WAIT_S]));
        failures++;
      }
    }
  }
  if (opts.command === 'status') {
    const cfg = readHookConfig(home);
    out(
      cfg
        ? tr('Configuração do hook ({0}): porta {1}, espera {2} s.', [cfgFile, cfg.port ?? DEFAULT_PORT, cfg.permissionTimeoutS ?? DEFAULT_WAIT_S])
        : tr('Configuração do hook ({0}): não existe (o hook usa HABBLAUD_PORT ou a porta {1} e espera {2} s).', [cfgFile, DEFAULT_PORT, DEFAULT_WAIT_S]),
    );
    const port = cfg?.port ?? opts.port;
    const health = await (ctx.health ?? fetchHealth)(port);
    if (!health) out(tr('Habblaud em http://127.0.0.1:{0}: fora do ar (com ele parado, os hooks saem na hora e o Codex segue normal).', [port]));
    else {
      const events = health.codexEvents ? tr('recebendo os eventos do Codex') : tr('no ar, mas sem a fonte do Codex (os eventos são ignorados)');
      const perms = health.permissions ? tr('aprovar pelo escritório ligado (com alguma página aberta)') : tr('aprovar pelo escritório desligado (porta exposta na rede ou HABBLAUD_TERMINAL=0)');
      out(tr('Habblaud em http://127.0.0.1:{0}: {1}; {2}.', [port, events, perms]));
    }
    out(tr('Confiança: o Codex só roda um hook novo ou alterado depois que você o aprova; confira em /hooks dentro do Codex.'));
  }
  if (opts.command === 'install' && opts.account && !opts.dryRun) {
    // A espera fica num arquivo só, mas o timeout do PermissionRequest fica em cada hooks.json: as outras pastas com o
    // Habblaud e outra espera cortariam o hook antes da hora.
    const behind = found.dirs.filter((d) => {
      if (dirs.includes(d)) return false;
      const r = readSettings(join(d, 'hooks.json'));
      return !('error' in r) && installState(r.settings, command, opts.waitS).outdated.includes('PermissionRequest');
    });
    if (behind.length) {
      out(tr('! {0}: o Habblaud está lá com outra espera; rode npm run codex:install sem --conta para alinhar.', [behind.map((d) => basename(d)).join(', ')]));
    }
  }
  if (opts.command === 'install' && approve.size && !opts.dryRun) {
    out('');
    out(tr('Pronto. Falta um passo: abra o Codex e aprove os hooks do Habblaud em /hooks (o Codex só roda hook novo'));
    out(tr('ou alterado depois que você aprova). Com o Habblaud aberto no navegador, as sessões do Codex aparecem no'));
    out(tr('escritório e os pedidos de aprovação esperam sua resposta lá por até {0} s antes de irem para o terminal.', [opts.waitS]));
    if (replaced.size) {
      out(tr('O comando dos hooks mudou (antes: {0}; agora: {1}): o Codex trata hook com', [[...replaced].join('; '), command]));
      out(tr('comando novo como alterado e só volta a rodá-lo depois que você aprovar de novo em /hooks.'));
    } else if (approve.size < EVENTS.length) {
      out(tr('(Hooks novos ou alterados, a aprovar em /hooks: {0}.)', [[...approve].join(', ')]));
    }
    out(tr('Para desfazer: npm run codex:uninstall'));
  }
  if (opts.command === 'uninstall' && changed) out(tr('A configuração em ~/.habblaud/codex-hook.json fica (só o hook a lê).'));
  return failures ? 1 : 0;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const home = process.env.HOME || homedir();
  const platform = process.platform;
  process.exitCode = await run(parsed, {
    env: process.env,
    home,
    now: new Date(),
    hookPath: HOOK_SCRIPT,
    out: (l) => console.log(l),
    platform,
    nodeProbe: createNodeProbe({ platform, env: process.env }),
    // No Windows não há /opt/homebrew nem /usr/local: sobra o Node deste comando.
    nodeCandidates: platform === 'win32' ? [process.execPath] : ['/opt/homebrew/bin/node', '/usr/local/bin/node', process.execPath],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? tr('[codex] Erro: {0}', [err.message]) : tr('[codex] Erro inesperado: {0}', [String(err)]));
    process.exitCode = 1;
  });
}
