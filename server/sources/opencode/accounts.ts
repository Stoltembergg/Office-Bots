// Contas do OpenCode: ele guarda tudo num SQLite (opencode.db) na pasta de dados da plataforma. Node puro e sem
// dependências do servidor: também pode ser importado por scripts/docker-up.ts (via tsx) no host.
//
// Descoberta: HABBLAUD_OPENCODE_DIRS (lista separada por vírgula) substitui tudo (só precisa existir); senão a
// pasta de dados por SO que tenha opencode.db:
// - Windows: %USERPROFILE%\.local\share\opencode
// - macOS:   ~/Library/Application Support/opencode
// - Linux e outros: $XDG_DATA_HOME/opencode ou ~/.local/share/opencode
//
// Privacidade: só a EXISTÊNCIA do banco é conferida aqui; a leitura (somente SELECT) fica na fonte.
import { readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
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

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Pasta de dados do OpenCode: tem o banco opencode.db. */
export function isOpencodeHome(p: string): boolean {
  try {
    return statSync(join(p, 'opencode.db')).isFile();
  } catch {
    return false;
  }
}

/** Candidatos de pasta padrão por SO. */
export function opencodeDataCandidates(env: NodeJS.ProcessEnv, home: string): string[] {
  const out: string[] = [];
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) out.push(join(xdg, 'opencode'));
  if (platform() === 'darwin') out.push(join(home, 'Library', 'Application Support', 'opencode'));
  out.push(join(home, '.local', 'share', 'opencode'));
  return out;
}

/** Pastas de skills do OpenCode (fora da pasta de dados): `~/.config/opencode/skills` e `~/.opencode/skills`. */
export function opencodeSkillsCandidates(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const out: string[] = [];
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (xdg) out.push(join(xdg, 'opencode', 'skills'));
  out.push(join(home, '.config', 'opencode', 'skills'));
  out.push(join(home, '.opencode', 'skills'));
  return [...new Set(out)];
}

/** Pastas do OpenCode observadas. Override primeiro; senão os candidatos por SO com opencode.db. */
export function discoverOpencodeDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.HABBLAUD_OPENCODE_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter((p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  const found = opencodeDataCandidates(env, home).filter(isOpencodeHome);
  return [...new Set(found)];
}

/** Overrides das contas do OpenCode em HABBLAUD_ACCOUNTS (vindos do host, no Docker). */
export function opencodeOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'opencode');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/** Letras candidatas de uma conta: inicial do sufixo ("opencode-trabalho" → T), O, C... e o alfabeto. */
function letterCandidates(dir: string): string[] {
  const suffix = /^\.?opencode[-_.]+([A-Za-z])/i.exec(basename(dir))?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('O', 'C');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface OpencodeDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/** Uma conta por pasta do OpenCode, NA MESMA ORDEM de `dirs`. */
export function detectOpencodeAccounts(dirs: string[], opts: OpencodeDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = opencodeOverrides(env.HABBLAUD_ACCOUNTS);
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
      provider: 'opencode' as const,
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? `OpenCode ${short}` : 'OpenCode'),
      color,
    };
  });
}
