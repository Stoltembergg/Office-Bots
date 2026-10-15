// Liga o Cursor ao Habblaud: acrescenta o hook do Habblaud (mod/habblaud-cursor/hook.mjs) em ~/.cursor/hooks.json,
// no fim da lista de cada evento observado. Os outros hooks ficam como estão; antes de gravar, uma cópia vai para
// hooks.json.habblaud-bak. O Cursor relê o arquivo sozinho (no editor, às vezes só ao reabrir a janela).
//
//   npm run cursor:install     instala (ou atualiza o caminho do hook)
//   npm run cursor:uninstall   tira só as entradas do Habblaud
//   npm run cursor:status      mostra o que está instalado
//
// Pasta do Cursor: HABBLAUD_CURSOR_DIR, senão ~/.cursor. Porta: HABBLAUD_PORT (padrão 4747), gravada em
// ~/.habblaud/cursor-hook.json para o hook.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, DEFAULT_PORT, OBSERVED } from '../mod/habblaud-cursor/hook.mjs';

type HookEntry = { command: string; [k: string]: unknown };
type HooksFile = { version?: number; hooks?: Record<string, HookEntry[]>; [k: string]: unknown };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hookPath = join(root, 'mod', 'habblaud-cursor', 'hook.mjs');
const home = process.env.HOME || homedir();
const cursorDir = resolve(process.env.HABBLAUD_CURSOR_DIR?.trim() || join(home, '.cursor'));
const hooksFile = join(cursorDir, 'hooks.json');
const command = `"${process.execPath}" "${hookPath}"`;

/** Entrada do Habblaud (de qualquer instalação anterior, mesmo com outro caminho). */
export function isOurs(e: HookEntry): boolean {
  return typeof e?.command === 'string' && /habblaud-cursor[\\/]hook\.mjs/.test(e.command);
}

export function readHooks(path: string): HooksFile {
  if (!existsSync(path)) return { version: 1, hooks: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as HooksFile;
  if (!parsed || typeof parsed !== 'object') throw new Error(`${path}: não é um objeto JSON`);
  return parsed;
}

/** Tira as entradas do Habblaud e, com `add`, põe a atual no fim de cada evento observado. */
export function withHabblaud(file: HooksFile, add: string | undefined): HooksFile {
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, list] of Object.entries(file.hooks ?? {})) {
    const rest = (Array.isArray(list) ? list : []).filter((e) => !isOurs(e));
    if (rest.length) hooks[event] = rest;
  }
  if (add) for (const event of OBSERVED) hooks[event] = [...(hooks[event] ?? []), { command: add }];
  return { ...file, version: file.version ?? 1, hooks };
}

function write(next: HooksFile): void {
  mkdirSync(cursorDir, { recursive: true });
  if (existsSync(hooksFile)) copyFileSync(hooksFile, `${hooksFile}.habblaud-bak`);
  writeFileSync(hooksFile, `${JSON.stringify(next, null, 2)}\n`);
}

function status(): void {
  const file = readHooks(hooksFile);
  const missing = OBSERVED.filter((ev) => !(file.hooks?.[ev] ?? []).some(isOurs));
  const others = Object.values(file.hooks ?? {}).flat().filter((e) => !isOurs(e)).length;
  console.log(`Cursor (${cursorDir}): ${existsSync(hooksFile) ? 'hooks.json encontrado' : 'sem hooks.json'}`);
  if (missing.length === OBSERVED.length) console.log('  hook do Habblaud: não instalado (npm run cursor:install)');
  else if (missing.length) console.log(`  hook do Habblaud: incompleto, faltam ${missing.join(', ')} (rode npm run cursor:install)`);
  else console.log(`  hook do Habblaud: instalado em ${OBSERVED.length} eventos`);
  console.log(`  outros hooks mantidos: ${others}`);
}

function main(): void {
  const action = process.argv[2] ?? 'status';
  if (action === 'install') {
    if (!existsSync(cursorDir)) {
      console.error(`Pasta do Cursor não encontrada: ${cursorDir} (defina HABBLAUD_CURSOR_DIR).`);
      process.exit(1);
    }
    write(withHabblaud(readHooks(hooksFile), command));
    const port = Number.parseInt(process.env.HABBLAUD_PORT ?? '', 10) || DEFAULT_PORT;
    mkdirSync(join(home, '.habblaud'), { recursive: true });
    writeFileSync(join(home, '.habblaud', CONFIG_FILE), `${JSON.stringify({ port })}\n`);
    console.log(`✓ hook do Habblaud em ${hooksFile} (${OBSERVED.length} eventos; cópia em hooks.json.habblaud-bak)`);
    console.log('Conversas novas do Cursor já aparecem no escritório. Se o editor estava aberto e nada chegar, recarregue a janela.');
  } else if (action === 'uninstall') {
    if (!existsSync(hooksFile)) return console.log('Nada a fazer: sem hooks.json.');
    write(withHabblaud(readHooks(hooksFile), undefined));
    console.log(`✓ entradas do Habblaud removidas de ${hooksFile}`);
  } else if (action !== 'status') {
    console.error('uso: cursor-install.ts install | uninstall | status');
    process.exit(1);
  }
  status();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
