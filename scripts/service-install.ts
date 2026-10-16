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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tr } from '../shared/i18n';

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

/** O texto da unit para estes caminhos. */
export function buildUnit(o: UnitOptions): string {
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
