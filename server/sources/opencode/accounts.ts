// Contas do OpenCode: uma pasta de dados por conta. Node puro e sem dependências do servidor: também é
// importado por scripts/docker-up.ts (via tsx) no host.
//
// Descoberta: HABBLAUD_OPENCODE_DIRS (lista separada por vírgula) substitui tudo; senão OPENCODE_DATA_DIR e
// `$HOME/.local/share/opencode` que tenham cara de pasta do OpenCode (isOpenCodeHome). Letra da conta: o alias de
// shell `alias x='... opencode ...'` (sem variável = a pasta padrão); sem alias, uma letra derivada que não colide
// com a das outras ferramentas. Cor: da paleta das contas, sem repetir.
//
// Privacidade: NUNCA abre o `opencode.db` (o SQLite exige lock de arquivo, que a montagem /mnt/c do WSL não
// oferece — e ele guarda tokens do provedor). A fonte lê só o que o plugin do OpenCode escreve: sessions/,
// open-sessions/ e sessions/<id>.meta.json. Dos arquivos de shell, só as linhas `alias X='... opencode ...'`.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  accountIds,
  expandHome,
  parseAccountOverrides,
  readShellAliases,
  shortcutsByDir,
  type AccountOverride,
  type DetectedAccount,
} from '../../accounts/detect';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * Pastas de dados do OpenCode (a raiz, ANTES do `habblaud/`), em ordem de preferência.
 *
 * OPENCODE_DATA_DIR manda; depois $HOME (a ordem que o resto do projeto usa) e USERPROFILE (no Windows
 * nativo o HOME costuma faltar). Por fim, quando o disco do Windows está por perto (WSL), o perfil do
 * usuário em /mnt/c/Users: é lá que o OpenCode Desktop guarda os dados e é de onde o plugin grava. Sem
 * este candidato, um `docker:up` numa sessão limpa só encontra o $HOME do Linux — que, se existir de
 * verdade, é uma pasta de teste — e monta a errada (ou nenhuma) sem nenhum erro, deixando o escritório
 * sem os agentes do OpenCode.
 */
function openCodeDataBases(env: NodeJS.ProcessEnv, home: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Uma RAIZ de dados (o que vem antes do `habblaud/`), não um home.
  const add = (raw?: string) => {
    if (!raw) return;
    const r = resolve(expandHome(raw, home));
    if (seen.has(r)) return;
    seen.add(r);
    out.push(r);
  };
  const addFromHome = (h?: string) => {
    const v = h?.trim();
    if (v) add(join(v, '.local', 'share', 'opencode'));
  };
  add(env.OPENCODE_DATA_DIR?.trim());
  addFromHome(home);
  addFromHome(env.USERPROFILE);
  for (const profile of windowsProfiles(env)) addFromHome(profile);
  return out;
}

/**
 * Perfis de usuário do Windows visíveis pelo WSL (`/mnt/c/Users`), ou a raiz dada em
 * HABBLAUD_WIN_PROFILES (mount fora do padrão, e o que os testes usam para não depender da máquina).
 * Vazio quando não há disco do Windows por perto.
 */
function windowsProfiles(env: NodeJS.ProcessEnv): string[] {
  const root = env.HABBLAUD_WIN_PROFILES?.trim() || (isDir('/mnt/c/Users') ? '/mnt/c/Users' : '');
  if (!root || !isDir(root)) return [];
  try {
    return readdirSync(root).map((name) => join(root, name));
  } catch {
    return [];
  }
}

/**
 * Pasta que a fonte do OpenCode observa: a MESMA que o plugin escreve.
 *
 * HABBLAUD_OPENCODE_DIR manda; senão é o subdiretório `habblaud/` dentro da primeira pasta de dados que
 * exista de verdade (openCodeDataBases). O subdiretório é separado de propósito: a pasta de dados do
 * OpenCode tem o opencode.db (com tokens do provedor), que esta fonte nunca abre.
 */
export function defaultOpenCodeHome(env: NodeJS.ProcessEnv, home: string): string {
  const explicit = env.HABBLAUD_OPENCODE_DIR?.trim();
  if (explicit) return expandHome(explicit, home);
  const bases = openCodeDataBases(env, home);
  const real = bases.find((b) => isOpenCodeHome(join(b, 'habblaud')));
  return join(real ?? bases[0] ?? join(home, '.local', 'share', 'opencode'), 'habblaud');
}

/**
 * Tem a cara de uma pasta de dados do OpenCode? Exige `sessions/`: é lá que o plugin do OpenCode grava a
 * conversa que a fonte lê. A pasta de dados do OpenCode também tem `opencode.db`, `log/` e `snapshot/`, mas
 * nunca são lidos aqui.
 */
export function isOpenCodeHome(p: string): boolean {
  return isDir(join(p, 'sessions')) || isDir(join(p, 'open-sessions'));
}

/**
 * Pastas do OpenCode observadas. HABBLAUD_OPENCODE_DIRS substitui a detecção e vale como veio (só precisa
 * existir). Senão: HABBLAUD_OPENCODE_DIR, e depois TODAS as pastas de dados (openCodeDataBases) que passem
 * em isOpenCodeHome — a ordem entre elas é a de preferência.
 */
export function discoverOpenCodeDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.HABBLAUD_OPENCODE_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isDir);
  const explicit = env.HABBLAUD_OPENCODE_DIR?.trim();
  if (explicit) {
    const dir = expandHome(explicit, home);
    if (isOpenCodeHome(dir)) return [dir];
  }
  return openCodeDataBases(env, home)
    .map((b) => join(b, 'habblaud'))
    .filter(isOpenCodeHome);
}

/** Overrides das contas do OpenCode em HABBLAUD_ACCOUNTS (vindos do host, no Docker). */
export function opencodeOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'opencode');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/** Letras candidatas de uma conta sem alias: a inicial do sufixo (".opencode-trabalho" → T), depois X, Y, Z... */
function letterCandidates(dir: string): string[] {
  const suffix = /^\.?opencode[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('O', 'X', 'Y', 'Z', 'W', 'V', 'U');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface OpenCodeDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Letras e cores já usadas pelas contas das outras ferramentas (não se repetem). */
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/**
 * Uma conta por pasta de dados do OpenCode, NA MESMA ORDEM de `dirs`. Sem e-mail e sem plano: o OpenCode não
 * expõe nenhum dos dois por arquivo, e ler o banco seria justamente o que esta fonte evita.
 */
export function detectOpenCodeAccounts(dirs: string[], opts: OpenCodeDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = opencodeOverrides(env.HABBLAUD_ACCOUNTS);
  const shortcuts = shortcutsByDir(readShellAliases(home, 'opencode'), home, defaultOpenCodeHome(env, home));
  const main = resolve(defaultOpenCodeHome(env, home));
  // A pasta padrão do OpenCode se chama "opencode"; o id da conta segue o do Codex (".codex"), com o ponto.
  const ids = accountIds(dirs).map((id, i) => (resolve(dirs[i]) === main ? '.opencode' : id));
  const usedShorts = new Set([...(opts.taken?.shorts ?? [])].map((s) => s.toUpperCase()));
  const usedColors = new Set(opts.taken?.colors ?? []);

  const partial = dirs.map((dir, i) => {
    const ov = matchOverride(overrides, ids[i], resolve(dir), home);
    const short = str(ov?.short)?.slice(0, 3) ?? shortcuts.get(resolve(dir));
    return { dir, id: str(ov?.id) ?? ids[i], ov, short: short && !usedShorts.has(short.toUpperCase()) ? short : undefined };
  });
  for (const p of partial) if (p.short) usedShorts.add(p.short.toUpperCase());

  return partial.map((p) => {
    const short = p.short ?? letterCandidates(p.dir).find((l) => !usedShorts.has(l)) ?? '?';
    usedShorts.add(short.toUpperCase());
    let color = str(p.ov?.color);
    if (!color) {
      color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[usedColors.size % ACCOUNT_COLORS.length];
      usedColors.add(color);
    }
    const acc: DetectedAccount = {
      id: p.id,
      provider: 'opencode',
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? `OpenCode ${short}` : 'OpenCode'),
      color,
    };
    return acc;
  });
}

/**
 * Uma conta observada. DOIS caminhos, como a do Codex: `dir` é o que a fonte LÊ (no Docker, a montagem em
 * /opencode/<id>) e `configDir` é o que se EXIBE (no Docker, o do host). Confundir os dois fazia a fonte ler um
 * caminho que não existe dentro do container — e reportava zero sessões sem nenhum erro.
 */
export interface OpenCodeAccount {
  id: string;
  /** O que a fonte lê: a pasta com sessions/ e open-sessions/. */
  dir: string;
  /** O que se exibe na interface (o caminho do host, quando em Docker). */
  configDir: string;
  short: string;
  name: string;
  color: string;
  error?: string;
}

/** Contas detectadas de `dirs`, na mesma ordem. */
export function openCodeAccounts(dirs: string[], opts: OpenCodeDetectOptions = {}): OpenCodeAccount[] {
  return detectOpenCodeAccounts(dirs, opts).map((d) => ({
    id: d.id,
    dir: d.configDir,
    configDir: d.configDir,
    short: d.short,
    name: d.name,
    color: d.color,
  }));
}