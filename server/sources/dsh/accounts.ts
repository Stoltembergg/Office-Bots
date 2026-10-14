// Contas do DeepSeek Harness (DSH): uma pasta de dados por instalação (~/.dsh). Node puro e sem dependências do
// servidor: também pode ser importado por scripts/docker-up.ts (via tsx) no host.
//
// Descoberta: HABBLAUD_DSH_DIRS (lista separada por vírgula) substitui tudo; senão `$HOME/.dsh` que tenha cara de
// pasta do DSH (tem sessions/ ou profiles/). A pasta padrão do Windows é a mesma (~/.dsh). Letra, cor e nome seguem
// o mesmo esquema das contas do Codex (sem colidir com as do Claude Code e as do Codex).
//
// Privacidade: só a EXISTÊNCIA das subpastas é conferida; nada de credenciais nem perfis são abertos aqui.
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  accountIds,
  expandHome,
  parseAccountOverrides,
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

/** Pasta de dados do DSH: tem sessões (sessions/) e/ou perfis (profiles/). */
export function isDshHome(p: string): boolean {
  return isDir(join(p, 'sessions')) || isDir(join(p, 'profiles'));
}

/** Pasta padrão do DSH: DSH_HOME ou $HOME/.dsh. */
export function defaultDshHome(env: NodeJS.ProcessEnv, home: string): string {
  const raw = env.DSH_HOME?.trim();
  return raw ? expandHome(raw, home) : join(home, '.dsh');
}

/**
 * Pastas do DSH observadas. HABBLAUD_DSH_DIRS substitui a detecção (só precisa existir). Senão: DSH_HOME ou
 * `$HOME/.dsh*` que passem em isDshHome. Ordem estável: a padrão primeiro, depois alfabética.
 */
export function discoverDshDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.HABBLAUD_DSH_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isDir);
  const found: string[] = [];
  const main = defaultDshHome(env, home);
  if (isDshHome(main)) found.push(main);
  try {
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (!ent.name.startsWith('.dsh')) continue;
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const p = join(home, ent.name);
      if (isDshHome(p)) found.push(p);
    }
  } catch {
    // $HOME ilegível
  }
  const dirs = [...new Set(found.map((p) => expandHome(p, home)))];
  dirs.sort((a, b) => (a === main ? 0 : 1) - (b === main ? 0 : 1) || a.localeCompare(b));
  return dirs;
}

/** Overrides das contas do DSH em HABBLAUD_ACCOUNTS (vindos do host, no Docker). */
export function dshOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'dsh');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/** Letras candidatas de uma conta: inicial do sufixo (".dsh-laptop" → L), S (deepSeek), H (Harness)... e o alfabeto. */
function letterCandidates(dir: string): string[] {
  const suffix = /^\.?dsh[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('S', 'H', 'D');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface DshDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Letras e cores já usadas pelas contas do Claude Code e do Codex (não se repetem). */
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/**
 * Uma conta por pasta do DSH, NA MESMA ORDEM de `dirs`. `configDir` é o caminho para exibição (no Docker, o do
 * host, vindo de HABBLAUD_ACCOUNTS). Sem e-mail nem plano (não são lidos).
 */
export function detectDshAccounts(dirs: string[], opts: DshDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = dshOverrides(env.HABBLAUD_ACCOUNTS);
  const ids = accountIds(dirs);
  const usedShorts = new Set([...(opts.taken?.shorts ?? [])].map((s) => s.toUpperCase()));
  const usedColors = new Set(opts.taken?.colors ?? []);

  const partial = dirs.map((dir, i) => {
    const ov = matchOverride(overrides, ids[i], resolve(dir), home);
    const short = str(ov?.short)?.slice(0, 3);
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
    return {
      id: p.id,
      provider: 'dsh' as const,
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? `DeepSeek Harness ${short}` : 'DeepSeek Harness'),
      color,
    };
  });
}
