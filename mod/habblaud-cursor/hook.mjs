#!/usr/bin/env node
// Hook do Habblaud para o Cursor (o agente do editor e o `cursor-agent`, que leem o mesmo ~/.cursor/hooks.json):
// mostra no escritório o que as conversas do Cursor fazem. `npm run cursor:install` acrescenta, em cada evento
// observado, uma entrada que roda:
//
//   "/caminho/do/node" "/caminho/do/habblaud/mod/habblaud-cursor/hook.mjs"
//
// O hook lê do stdin o JSON do evento (conversation_id, hook_event_name, workspace_roots...), manda os campos que o
// escritório usa para POST http://127.0.0.1:<porta>/api/cursor/events (prazo curto) e responde ao Cursor deixando
// tudo seguir. Porta: ~/.habblaud/cursor-hook.json ({port}, gravado pelo instalador); senão HABBLAUD_PORT; senão 4747.
//
// Regras: Node puro (22+), só `node:*`; nunca trava nem bloqueia o Cursor (todo erro = sai com 0 liberando). Manda só
// metadados (nunca a saída dos comandos, o conteúdo dos arquivos ou a resposta do modelo). Só fala com 127.0.0.1.
// HABBLAUD_HOOK_DEBUG=1 escreve o que acontece no stderr.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
export const CONFIG_FILE = 'cursor-hook.json';
/** Eventos que o instalador registra. */
export const OBSERVED = ['sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'afterShellExecution', 'afterMCPExecution', 'afterFileEdit', 'stop'];
/** Campos do evento mandados ao Habblaud (o resto, como output e edits, fica no computador). */
const FIELDS = ['hook_event_name', 'conversation_id', 'session_id', 'generation_id', 'workspace_roots', 'cwd', 'prompt', 'command', 'file_path', 'tool_name', 'server_name', 'status'];
const MAX_STRING = 2_000;
const EVENT_TIMEOUT_MS = 1_500;
const STDIN_TIMEOUT_MS = 5_000;

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-cursor] ${msg}\n`) : () => {};
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65_536;

export function readPort(env = process.env) {
  const home = env.HOME || homedir();
  let file;
  try {
    file = JSON.parse(readFileSync(join(home, '.habblaud', CONFIG_FILE), 'utf8'));
  } catch {
    file = undefined;
  }
  const filePort = Number(file?.port);
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  return validPort(filePort) ? filePort : validPort(envPort) ? envPort : DEFAULT_PORT;
}

/** Só os campos que o escritório usa, com os textos cortados. */
export function pickEvent(input) {
  const out = {};
  for (const k of FIELDS) {
    const v = input?.[k];
    if (typeof v === 'string') out[k] = v.slice(0, MAX_STRING);
    else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string').slice(0, 10).map((x) => x.slice(0, MAX_STRING));
  }
  return out;
}

/** Resposta ao Cursor que deixa tudo seguir (beforeSubmitPrompt pede `continue`). */
export function passThrough(event) {
  return event === 'beforeSubmitPrompt' ? '{"continue":true}' : '{}';
}

function readStdin() {
  return new Promise((done) => {
    const chunks = [];
    const timer = setTimeout(() => done(Buffer.concat(chunks).toString('utf8')), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done('');
    });
  });
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(await readStdin());
  } catch {
    input = {};
  }
  const event = typeof input?.hook_event_name === 'string' ? input.hook_event_name : '';
  process.stdout.write(passThrough(event));
  if (!event) return;
  const home = process.env.HOME || homedir();
  const body = JSON.stringify({ cursorDir: join(home, '.cursor'), event: pickEvent(input) });
  try {
    const res = await fetch(`http://127.0.0.1:${readPort()}/api/cursor/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
    });
    debug(`${event}: HTTP ${res.status}`);
  } catch (err) {
    debug(`${event}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
