// Instala (ou remove) o plugin do Habblaud no OpenCode. Roda no HOST, com tsx:
//
//   npm run opencode:install     # copia mod/habblaud-opencode/habblaud.js para <config>/plugins/ (backup antes)
//   npm run opencode:uninstall   # tira o plugin do Habblaud (só se for o nosso; o resto fica)
//   npm run opencode:status      # mostra se o plugin está lá, se está atualizado e se o Habblaud responde
//   (opções: --dry-run, --force, --config <pasta>)
//
// O plugin (mod/habblaud-opencode/habblaud.js) roda DENTRO do OpenCode, nativo no sistema dele, e escreve os
// arquivos que a fonte do Habblaud lê (sessions/*.jsonl no formato do Claude Code, open-sessions/*.lock): o
// SQLite do OpenCode (`opencode.db`) o WSL não consegue abrir, então quem escreve é o lado de lá. Sem o plugin,
// o escritório não vê nenhuma sessão do OpenCode; com ele, vê conversa, presença, permissões, mensagens e
// perguntas. Pasta de configuração: OPENCODE_CONFIG_DIR ou o padrão da plataforma (~/.config/opencode; no
// Windows, %USERPROFILE%\.config\opencode; no WSL, a do Windows via interop, porque é lá que o OpenCode roda).
//
// Regras: nunca apaga nem sobrescreve um habblaud.js que não seja o nosso (só com --force, e com backup antes);
// nunca trava nem quebra a sessão (todo erro vira mensagem e código de saída). Só fala com 127.0.0.1.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_FILE = join(ROOT, 'mod', 'habblaud-opencode', 'habblaud.js');
export const PLUGIN_NAME = 'habblaud.js';
/** Primeira linha do nosso plugin: é ela que diz que um habblaud.js instalado é nosso (para atualizar ou tirar). */
export const PLUGIN_MARK = '// Plugin do OpenCode para o Habblaud.';
export const DEFAULT_PORT = 4747;

class FatalError extends Error {}

const USAGE = tr('Uso: npm run opencode:<install|uninstall|status> [-- opções]\n\n  install     copia o plugin do Habblaud para a pasta de plugins do OpenCode (faz backup antes)\n  uninstall   tira o plugin do Habblaud (só se for o nosso; os outros plugins ficam)\n  status      mostra se o plugin está lá, se está atualizado e se o Habblaud está respondendo\n\nOpções:\n  --dry-run        mostra o que mudaria, sem gravar nada\n  --force          instala mesmo se já existir um habblaud.js que não é o nosso (com backup antes)\n  --config <pasta> pasta de configuração do OpenCode (padrão: OPENCODE_CONFIG_DIR ou a da plataforma)\n  -h, --help       mostra esta ajuda\n\nSem OPENCODE_CONFIG_DIR, a pasta é ~/.config/opencode (%USERPROFILE%\\.config\\opencode no Windows; no WSL, a do Windows, porque é lá que o OpenCode roda).');

// ---------------------------------------------------------------------------------------------
// Funções puras (testadas em server/test/opencode-install.test.ts)
// ---------------------------------------------------------------------------------------------

export interface EnvLike {
  OPENCODE_CONFIG_DIR?: string;
  USERPROFILE?: string;
  HOME?: string;
  HABBLAUD_URL?: string;
  HABBLAUD_PORT?: string;
}

/** Release de kernel do WSL (tem "microsoft" ou "wsl"): o OpenCode que importa roda no Windows. */
export function isWslRelease(release: string): boolean {
  return /microsoft|wsl/i.test(release);
}

/**
 * Pasta de configuração do OpenCode: OPENCODE_CONFIG_DIR, ou o padrão da plataforma. No Windows é o
 * %USERPROFILE%; no WSL, o perfil do Windows (vindo por interop, porque $HOME lá é o do Linux). undefined =
 * não deu para saber (o chamador explica e desiste).
 */
export function configDirOf(env: EnvLike, plat: string, kernelRelease: string, wslProfile?: string): string | undefined {
  const explicit = env.OPENCODE_CONFIG_DIR?.trim();
  if (explicit) return explicit;
  if (plat === 'win32') {
    const home = env.USERPROFILE?.trim();
    return home ? join(home, '.config', 'opencode') : undefined;
  }
  if (isWslRelease(kernelRelease)) return wslProfile?.trim() ? join(wslProfile.trim(), '.config', 'opencode') : undefined;
  const home = env.HOME?.trim();
  return home ? join(home, '.config', 'opencode') : undefined;
}

/** Onde o plugin mora: <config>/plugins/habblaud.js. */
export function pluginPath(configDir: string): string {
  return join(configDir, 'plugins', PLUGIN_NAME);
}

/**
 * Caminho usável NESTE runtime: no WSL, `C:\...` vira `/mnt/c/...` (o instalador escreve pelo interop).
 * Fora do WSL, volta como veio.
 */
export function toLocalPath(p: string, plat: string, kernelRelease: string): string {
  if (plat === 'win32' || !isWslRelease(kernelRelease)) return p;
  const m = /^([A-Za-z]):[\\/]/.exec(p);
  return m ? `/mnt/${m[1].toLowerCase()}/${p.slice(3).replace(/\\/g, '/')}` : p;
}

/** O texto é o nosso plugin (para atualizar ou tirar sem encostar no dos outros). */
export function isOurPlugin(text: string): boolean {
  return text.split('\n', 1)[0]?.trim() === PLUGIN_MARK;
}

/** Nome do backup antes de sobrescrever ou tirar: habblaud.js.habblaud-backup-<data> (em UTC: igual em toda máquina). */
export function backupName(path: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${path}.habblaud-backup-${stamp}`;
}

/** Base do Habblaud local (a mesma do plugin: HABBLAUD_URL ou 127.0.0.1:HABBLAUD_PORT ou 4747). */
export function habblaudBase(env: EnvLike): string {
  if (env.HABBLAUD_URL?.trim()) return env.HABBLAUD_URL.trim().replace(/\/+$/, '');
  const port = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT}`;
}

// ---------------------------------------------------------------------------------------------
// Impuros (arquivos, rede, interop)
// ---------------------------------------------------------------------------------------------

function wslProfile(): string | undefined {
  for (const cmd of [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$env:USERPROFILE']], ['cmd.exe', ['/c', 'echo', '%USERPROFILE%']]] as const) {
    try {
      const out = execFileSync(cmd[0], [...cmd[1]], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim();
      if (out) return out;
    } catch {
      /* tenta o próximo */
    }
  }
  return undefined;
}

async function habblaudOk(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5_000) });
    return r.ok;
  } catch {
    return false;
  }
}

interface Deps {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  now: () => Date;
  read: (path: string) => string | undefined;
  write: (path: string, text: string) => void;
  rename: (from: string, to: string) => void;
  mkdir: (path: string) => void;
}

function realDeps(out: (line: string) => void): Deps {
  const read = (p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  };
  return {
    env: process.env,
    out,
    now: () => new Date(),
    read,
    write: (p, t) => writeFileSync(p, t),
    rename: (f, t) => renameSync(f, t),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
  };
}

function resolveTarget(deps: Deps, configOver?: string): { dir: string; path: string } {
  const env = deps.env;
  const cfg = configOver?.trim() || env.OPENCODE_CONFIG_DIR?.trim();
  const raw = cfg || configDirOf(env, platform(), release(), platform() === 'linux' ? wslProfile() : undefined);
  if (!raw) throw new FatalError(tr('não achei a pasta de configuração do OpenCode (defina OPENCODE_CONFIG_DIR ou use --config <pasta>).'));
  const dir = toLocalPath(raw, platform(), release());
  if (!isAbsolute(dir)) throw new FatalError(tr('pasta de configuração inválida: {0}', [dir]));
  return { dir, path: pluginPath(dir) };
}

function cmdInstall(deps: Deps, o: { dryRun: boolean; force: boolean; config?: string }): number {
  const wanted = deps.read(PLUGIN_FILE);
  if (wanted === undefined) throw new FatalError(tr('não achei o plugin em {0} (repositório incompleto?).', [PLUGIN_FILE]));
  const { path } = resolveTarget(deps, o.config);
  const current = deps.read(path);
  if (current !== undefined && current === wanted) {
    deps.out(tr('já instalado e atualizado em {0}.', [path]));
    return 0;
  }
  if (current !== undefined && !isOurPlugin(current) && !o.force) {
    deps.out(tr('já existe um habblaud.js que não é o nosso em {0}: nada feito (use --force para trocar, com backup).', [path]));
    return 2;
  }
  if (o.dryRun) {
    deps.out(tr(current === undefined ? 'instalaria em {0}.' : 'atualizaria {0} (com backup).', [path]));
    return 0;
  }
  if (current !== undefined) deps.rename(path, backupName(path, deps.now()));
  deps.mkdir(dirname(path));
  deps.write(path, wanted);
  deps.out(tr('instalado em {0}. Abra o OpenCode: a sessão aparece no escritório.', [path]));
  return 0;
}

function cmdUninstall(deps: Deps, o: { dryRun: boolean; config?: string }): number {
  const { path } = resolveTarget(deps, o.config);
  const current = deps.read(path);
  if (current === undefined) {
    deps.out(tr('nada para tirar em {0}.', [path]));
    return 0;
  }
  if (!isOurPlugin(current)) {
    deps.out(tr('o habblaud.js em {0} não é o nosso: nada feito.', [path]));
    return 2;
  }
  if (o.dryRun) {
    deps.out(tr('tiraria {0} (com backup).', [path]));
    return 0;
  }
  // Tirar = mover para o backup ao lado: o conteúdo se preserva, a pasta volta a não ter o plugin.
  const backup = backupName(path, deps.now());
  deps.rename(path, backup);
  deps.out(tr('tirado de {0} (backup em {1}).', [path, backup]));
  return 0;
}

async function cmdStatus(deps: Deps, o: { config?: string }): Promise<number> {
  const wanted = deps.read(PLUGIN_FILE);
  const { path } = resolveTarget(deps, o.config);
  const current = deps.read(path);
  if (current === undefined) deps.out(tr('plugin: ausente em {0} (`npm run opencode:install` instala).', [path]));
  else if (current === wanted) deps.out(tr('plugin: instalado e atualizado em {0}.', [path]));
  else if (isOurPlugin(current)) deps.out(tr('plugin: nosso, mas desatualizado em {0} (`npm run opencode:install` atualiza).', [path]));
  else deps.out(tr('plugin: um habblaud.js de outro em {0} (não encosto).', [path]));
  const base = habblaudBase(deps.env);
  deps.out((await habblaudOk(base)) ? tr('Habblaud: respondendo em {0}.', [base]) : tr('Habblaud: fora do ar em {0}.', [base]));
  return 0;
}

export interface Parsed {
  command?: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  force: boolean;
  config?: string;
  help?: boolean;
}

export function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { dryRun: false, force: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'install' || a === 'uninstall' || a === 'status') out.command = a;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--config') out.config = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new FatalError(tr('opção desconhecida: {0}\n\n{1}', [a, USAGE]));
  }
  return out;
}

export async function run(parsed: Parsed, deps: Deps): Promise<number> {
  if (parsed.help || !parsed.command) {
    deps.out(USAGE);
    return parsed.help ? 0 : 1;
  }
  if (parsed.command === 'install') return cmdInstall(deps, parsed);
  if (parsed.command === 'uninstall') return cmdUninstall(deps, parsed);
  return cmdStatus(deps, parsed);
}

async function main(): Promise<void> {
  const out = (l: string) => console.log(l);
  try {
    process.exitCode = await run(parseArgs(process.argv.slice(2)), realDeps(out));
  } catch (err) {
    console.error(err instanceof FatalError ? err.message : err);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main();
}
