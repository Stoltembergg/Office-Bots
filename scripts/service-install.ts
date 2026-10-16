// Instala (ou remove) o Habblaud como serviço de usuário do systemd (Linux e WSL com systemd). Roda no HOST, com tsx:
//
//   npm run service:install     # grava ~/.config/systemd/user/habblaud.service e liga o serviço
//   npm run service:uninstall   # desliga o serviço e apaga a unit
//   npm run service:status      # mostra a unit, se está ligada e se o linger está ativo
//   (opções: --dry-run, --port <n>, --force)
//
// A unit roda `node dist/server/index.js` (o mesmo que `npm start`), com o node que rodou o instalador, a pasta
// deste projeto e o PATH de quem instalou (assim o servidor acha `claude` e `codex`). O instalador não roda o build:
// antes, `npm run build`. Depois de um `git pull`: `npm install`, `npm run build` e
// `systemctl --user restart habblaud`.
//
// A primeira linha da unit é uma marca. Uma unit sem a marca (feita à mão) só é trocada ou apagada com --force.
// Rodar o install de novo, sem nada que mudar, não grava nem reinicia nada.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tr } from '../shared/i18n';
import { tildify } from './statusline-install';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_ENTRY = join(ROOT, 'dist', 'server', 'index.js');
export const SERVICE_NAME = 'habblaud.service';
/** Primeira linha da unit gerada aqui: é por ela que o instalador sabe que a unit é dele. */
export const MARK = '# habblaud: npm run service:install';
export const DEFAULT_PORT = 4747;

// ---------------------------------------------------------------------------------------------
// Funções puras (testadas em server/test/service-install.test.ts)
// ---------------------------------------------------------------------------------------------

export interface UnitOptions {
  nodePath: string;
  root: string;
  serverEntry: string;
  pathEnv: string;
  /** Só entra na unit quando vem de --port; sem ele o servidor usa o padrão. */
  port?: number;
}

/** O systemd expande especificadores (%h, %u...) quase em todo valor: `%` literal é `%%`. */
export function escapeSpecifiers(s: string): string {
  return s.replace(/%/g, '%%');
}

/** Palavra entre aspas duplas (`\` e `"` escapados, `%` dobrado), como o ExecStart e o Environment a leem. */
export function quoteWord(s: string): string {
  return `"${escapeSpecifiers(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

class FatalError extends Error {}

/** O texto da unit para estes caminhos. */
export function buildUnit(o: UnitOptions): string {
  // Uma quebra de linha num caminho ou no PATH quebraria a unit em linhas novas (injeção de diretivas).
  if ([o.nodePath, o.root, o.serverEntry, o.pathEnv].some((v) => /[\r\n]/.test(v))) {
    throw new FatalError(tr('caminho ou PATH com quebra de linha não pode entrar na unit'));
  }
  // No ExecStart o `$` expande variáveis; `$$` é o `$` literal.
  const exec = [o.nodePath, o.serverEntry].map((w) => quoteWord(w.replace(/\$/g, () => '$$'))).join(' ');
  const env = [`PATH=${o.pathEnv}`, ...(o.port ? [`HABBLAUD_PORT=${o.port}`] : [])].map((e) => `Environment=${quoteWord(e)}`);
  return [
    MARK,
    '[Unit]',
    `Description=Habblaud (escritório dos agentes) em http://localhost:${o.port ?? DEFAULT_PORT}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${escapeSpecifiers(o.root)}`,
    ...env,
    `ExecStart=${exec}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Pasta das units de usuário: $XDG_CONFIG_HOME/systemd/user, ou ~/.config/systemd/user. */
export function unitDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'systemd', 'user');
}

export function isOurUnit(text: string): boolean {
  return text.split('\n', 1)[0].trim() === MARK;
}

export type InstallPlan = { action: 'write' | 'update' | 'none' | 'skip'; message: string };
export type UninstallPlan = { action: 'remove' | 'none' | 'skip'; message: string };

/** O que o install faz, dada a unit que já existe (undefined = nenhuma) e a que ele geraria. */
export function planInstall(existing: string | undefined, wanted: string, force: boolean): InstallPlan {
  if (existing === undefined) return { action: 'write', message: tr('unit criada') };
  if (existing === wanted) return { action: 'none', message: tr('já instalado') };
  if (isOurUnit(existing) || force) return { action: 'update', message: tr('unit atualizada (novo caminho do Habblaud, do node ou das opções)') };
  return { action: 'skip', message: tr('já existe uma unit {0} que não foi gerada por este instalador; nada foi alterado (use --force para trocá-la)', [SERVICE_NAME]) };
}

/** O que o uninstall faz, dada a unit que já existe (undefined = nenhuma). */
export function planUninstall(existing: string | undefined, force: boolean): UninstallPlan {
  if (existing === undefined) return { action: 'none', message: tr('não instalado') };
  if (isOurUnit(existing) || force) return { action: 'remove', message: tr('unit removida') };
  return { action: 'skip', message: tr('a unit {0} não foi gerada por este instalador; nada foi alterado (use --force para removê-la)', [SERVICE_NAME]) };
}

/** Porta gravada na unit por um install --port (a unit sem ela usa o padrão do servidor). */
export function portOf(unit: string): number | undefined {
  const m = /^Environment="HABBLAUD_PORT=(\d+)"$/m.exec(unit);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Efeitos (a pasta de units, o systemctl e o loginctl)
// ---------------------------------------------------------------------------------------------

const USAGE = tr(`Uso: npm run service:<install|uninstall|status> [-- opções]

  install     grava a unit do systemd de usuário e liga o serviço (rode npm run build antes)
  uninstall   desliga o serviço e apaga a unit
  status      mostra a unit, se está ligada e se o linger está ativo

Opções:
  --dry-run     mostra o que mudaria, sem gravar nem chamar o systemctl (install e uninstall)
  --port <n>    porta do Habblaud no serviço (padrão: a do servidor, {0})
  --force       troca ou apaga uma unit habblaud.service que não foi gerada por este instalador
  -h, --help    mostra esta ajuda

Só Linux e WSL com systemd. A unit fica em ~/.config/systemd/user/{1}.`, [DEFAULT_PORT, SERVICE_NAME]);

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  force: boolean;
  port?: number;
}

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  user: string;
  nodePath: string;
  root: string;
  serverEntry: string;
  out: (line: string) => void;
  /** Roda systemctl e loginctl (os testes injetam um falso). */
  exec: (cmd: string, args: string[]) => ExecResult;
}

export function parseArgs(argv: string[]): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  let force = false;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--force') force = true;
    else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError(tr('--port precisa de um número entre 1 e 65535.'));
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(tr('opção desconhecida: {0}\n\n{1}', [a, USAGE]));
  }
  if (!command) throw new FatalError(tr('diga o que fazer: install, uninstall ou status.\n\n{0}', [USAGE]));
  return { command, dryRun, force, port };
}

export function defaultExec(cmd: string, args: string[]): ExecResult {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr || r.error?.message || '' };
}

function readUnit(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Roda `systemctl --user <args>`; devolve o motivo da falha, ou undefined se deu certo. */
function systemctl(ctx: RunContext, args: string[]): string | undefined {
  const r = ctx.exec('systemctl', ['--user', ...args]);
  return r.status === 0 ? undefined : tr('systemctl --user {0} falhou: {1}', [args.join(' '), r.stderr.trim() || r.stdout.trim() || String(r.status)]);
}

function lingerState(ctx: RunContext): 'yes' | 'no' | undefined {
  const r = ctx.exec('loginctl', ['show-user', ctx.user, '--property=Linger']);
  const v = r.status === 0 ? r.stdout.trim() : '';
  return v === 'Linger=yes' ? 'yes' : v === 'Linger=no' ? 'no' : undefined;
}

function warnLinger(ctx: RunContext): void {
  if (lingerState(ctx) !== 'no') return;
  ctx.out(tr('Atenção: o linger está desligado, então o serviço só roda enquanto você tiver uma sessão aberta.'));
  ctx.out(tr('Para ele subir no boot e seguir ligado sem login: loginctl enable-linger {0} (decisão sua; o instalador não roda isso).', [ctx.user]));
}

const NO_SYSTEMD = (reason: string): string =>
  tr('O systemd de usuário não respondeu ({0}). No WSL, ligue o systemd com "systemd=true" na seção [boot] de /etc/wsl.conf e reinicie o WSL (wsl --shutdown).', [reason]);

function install(opts: RunOptions, ctx: RunContext, file: string, existing: string | undefined, wanted: string): number {
  const { out } = ctx;
  if (!existsSync(ctx.serverEntry)) {
    out(tr('✗ Não achei {0}. Rode npm run build antes de instalar o serviço.', [tildify(ctx.serverEntry, ctx.home)]));
    return 1;
  }
  const plan = planInstall(existing, wanted, opts.force);
  if (plan.action === 'none') {
    out(`= ${plan.message}`);
    return 0;
  }
  if (plan.action === 'skip') {
    out(`✗ ${plan.message}`);
    return 1;
  }
  if (opts.dryRun) {
    out(tr('~ {0} (simulação: nada gravado)', [plan.message]));
    out(wanted);
    return 0;
  }
  const down = systemctl(ctx, ['show-environment']);
  if (down) {
    out(`✗ ${NO_SYSTEMD(down)}`);
    return 1;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, wanted);
  const steps = plan.action === 'write' ? [['daemon-reload'], ['enable', '--now', SERVICE_NAME]] : [['daemon-reload'], ['enable', SERVICE_NAME], ['restart', SERVICE_NAME]];
  for (const step of steps) {
    const failed = systemctl(ctx, step);
    if (failed) {
      out(`✗ ${failed}`);
      // Desfaz a gravação, para a próxima rodada não dizer "já instalado" sem ter ligado nada.
      if (plan.action === 'update' && existing !== undefined) writeFileSync(file, existing);
      else rmSync(file, { force: true });
      systemctl(ctx, ['daemon-reload']); // melhor esforço
      return 1;
    }
  }
  out(`✓ ${plan.message}: ${tildify(file, ctx.home)}`);
  warnLinger(ctx);
  return 0;
}

function uninstall(opts: RunOptions, ctx: RunContext, file: string, existing: string | undefined): number {
  const { out } = ctx;
  const plan = planUninstall(existing, opts.force);
  if (plan.action === 'none') {
    out(`= ${plan.message}`);
    return 0;
  }
  if (plan.action === 'skip') {
    out(`✗ ${plan.message}`);
    return 1;
  }
  if (opts.dryRun) {
    out(tr('~ {0} (simulação: nada alterado)', [plan.message]));
    return 0;
  }
  const failed = systemctl(ctx, ['disable', '--now', SERVICE_NAME]);
  if (failed) {
    out(`✗ ${failed}`);
    return 1;
  }
  rmSync(file, { force: true });
  const reload = systemctl(ctx, ['daemon-reload']);
  if (reload) {
    out(`✗ ${reload}`);
    return 1;
  }
  out(`✓ ${plan.message}: ${tildify(file, ctx.home)}`);
  return 0;
}

function status(ctx: RunContext, file: string, existing: string | undefined): number {
  const { out } = ctx;
  if (existing === undefined) {
    out(tr('• não instalado (não existe {0})', [tildify(file, ctx.home)]));
  } else {
    out(tr('• unit: {0} ({1})', [tildify(file, ctx.home), isOurUnit(existing) ? tr('gerada por este instalador') : tr('feita à mão, não é deste instalador')]));
    const answer = (verb: string) => ctx.exec('systemctl', ['--user', verb, SERVICE_NAME]).stdout.trim() || tr('desconhecido');
    out(tr('• ligado no boot da sessão (is-enabled): {0}', [answer('is-enabled')]));
    out(tr('• rodando agora (is-active): {0}', [answer('is-active')]));
    // Uma unit instalada com --port não é "diferente" só por isso.
    const now = buildUnit({ nodePath: ctx.nodePath, root: ctx.root, serverEntry: ctx.serverEntry, pathEnv: ctx.env.PATH ?? '', port: portOf(existing) });
    if (isOurUnit(existing) && existing !== now) out(tr('! a unit difere do que o install geraria agora (outro node, pasta ou PATH); rode npm run service:install para atualizar'));
  }
  const linger = lingerState(ctx);
  out(tr('• linger: {0}', [linger === 'yes' ? tr('ligado (o serviço sobe no boot e segue sem login)') : linger === 'no' ? tr('desligado (o serviço só roda com uma sessão aberta; veja loginctl enable-linger)') : tr('desconhecido')]));
  return 0;
}

/** Executa o comando. Devolve o código de saída. */
export function run(opts: RunOptions, ctx: RunContext): number {
  if (ctx.platform !== 'linux') {
    ctx.out(tr('✗ Só há suporte ao systemd de usuário no Linux (inclui o WSL com systemd); {0} não é suportado ainda.', [ctx.platform]));
    return 1;
  }
  const file = join(unitDir(ctx.env, ctx.home), SERVICE_NAME);
  const existing = readUnit(file);
  // Instalar de novo sem --port mantém a porta que a unit já tem, em vez de voltar ao padrão.
  const port = opts.port ?? (opts.command === 'install' && existing !== undefined ? portOf(existing) : undefined);
  const wanted = buildUnit({ nodePath: ctx.nodePath, root: ctx.root, serverEntry: ctx.serverEntry, pathEnv: ctx.env.PATH ?? '', port });
  if (opts.command === 'install') return install(opts, ctx, file, existing, wanted);
  if (opts.command === 'uninstall') return uninstall(opts, ctx, file, existing);
  return status(ctx, file, existing);
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const home = process.env.HOME || homedir();
  process.exitCode = run(parsed, {
    platform: process.platform,
    env: process.env,
    home,
    user: process.env.USER?.trim() || userInfo().username,
    nodePath: process.execPath,
    root: ROOT,
    serverEntry: SERVER_ENTRY,
    out: (l) => console.log(l),
    exec: defaultExec,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof FatalError ? tr('[service] Erro: {0}', [err.message]) : tr('[service] Erro inesperado: {0}', [String(err)]));
    process.exitCode = 1;
  }
}
