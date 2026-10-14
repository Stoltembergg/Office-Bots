// Auxiliar do Habblaud para o OpenCode quando o Habblaud roda no Docker (o servidor não alcança os processos do
// host). Roda no HOST, com tsx:
//
//   npm run opencode:bridge     (opções: --port <n>, --once)
//
// O OpenCode grava as sessões num SQLite (a fonte do escritório só lê), mas responder aprovações e mandar mensagens
// precisa da API local dele (HTTP com a senha de <config>/opencode/service.json, porta dinâmica por processo). Este
// processo, a cada 2 s:
// 1. descobre os servidores do OpenCode desta máquina (portas de escuta de processos "opencode", conferidos pelo
//    endpoint /api/info);
// 2. pergunta a cada um se há um pedido de permissão pendente (GET /api/permission/request), registra o pedido no
//    Habblaud (POST /api/permissions, provider "opencode") e espera a decisão — aprovado vira "once", recusado
//    vira "reject" (POST /api/session/<sid>/permission/<rid>/reply);
// 3. busca as mensagens do escritório para sessões do OpenCode (POST /api/opencode/bridge/poll), entrega cada uma
//    ao servidor da sessão (POST /api/session/<sid>/prompt) e confirma (POST /api/opencode/bridge/ack).
//
// Enquanto ele roda, o escritório deixa mandar mensagens aos agentes do OpenCode. Ctrl+C para parar.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_PORT = 4747;
export const POLL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 8_000;
const PERMISSION_TIMEOUT_MS = 120_000;

const USAGE = `Uso: npm run opencode:bridge [-- opções]

Entrega as mensagens do escritório às sessões do OpenCode e responde as aprovações dele pelo escritório.

Opções:
  --port <n>   porta do Habblaud (padrão: HABBLAUD_PORT ou ${DEFAULT_PORT})
  --once       faz uma rodada só e sai
  -h, --help   mostra esta ajuda`;

class FatalError extends Error {}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): { port: number; once: boolean } | 'help' {
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--once') once = true;
    else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError('--port precisa de um número entre 1 e 65535.');
    } else throw new FatalError(`opção desconhecida: ${a}\n\n${USAGE}`);
  }
  return { port, once };
}

// ------------------------------------------------------------------ config do OpenCode (senha do serviço local)

function configDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'opencode') : join(home, '.config', 'opencode');
}

/** Senha do serviço local do OpenCode (<config>/opencode/service.json). */
export function readServicePassword(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string | undefined {
  try {
    const j = JSON.parse(readFileSync(join(configDir(env, home), 'service.json'), 'utf8')) as unknown;
    return str(rec(j)?.password) ?? undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ descoberta dos servidores

/** PIDs de processos chamados opencode (opencode.exe no Windows). */
function opencodePids(): Set<number> {
  const out = new Set<number>();
  if (process.platform === 'win32') {
    const r = spawnSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    for (const line of (r.stdout ?? '').split(/\r?\n/)) {
      const m = /^"?(opencode(?:\.exe)?)"?,["]?(\d+)["]?,/i.exec(line);
      if (m) out.add(Number(m[2]));
    }
  } else {
    const r = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
    for (const line of (r.stdout ?? '').split(/\n/)) {
      const cols = line.split(/\s+/);
      if (cols[0]?.startsWith('opencode')) out.add(Number(cols[1]));
      else continue;
    }
  }
  return out;
}

/** Portas TCP ouvindo nos PIDs dados. */
function listenPorts(pids: Set<number>): number[] {
  if (!pids.size) return [];
  const ports: number[] = [];
  if (process.platform === 'win32') {
    const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    for (const line of (r.stdout ?? '').split(/\r?\n/)) {
      const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
      if (m && pids.has(Number(m[3]))) ports.push(Number(m[2]));
    }
  } else {
    const r = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
    for (const line of (r.stdout ?? '').split(/\n/)) {
      const cols = line.split(/\s+/);
      if (!/^\d+$/.test(cols[1] ?? '') || !pids.has(Number(cols[1]))) continue;
      const m = /:(\d+)\s+\(LISTEN\)$/.exec(cols[cols.length - 2] ?? '') ?? /:(\d+)\s/.exec(line);
      if (m) ports.push(Number(m[1]));
    }
  }
  return [...new Set(ports)];
}

interface OcServer {
  url: string;
  pid: number;
}

/** Servidores do OpenCode desta máquina que aceitam a senha do serviço (conferidos por /api/info). */
export async function discoverServers(auth: string, timeoutMs = 1_500): Promise<OcServer[]> {
  const out: OcServer[] = [];
  for (const port of listenPorts(opencodePids())) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/info`, { headers: { authorization: auth }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const info = rec(await res.json());
      out.push({ url: `http://127.0.0.1:${port}`, pid: typeof info?.pid === 'number' ? info.pid : 0 });
    } catch {
      // não é um OpenCode com esta senha
    }
  }
  return out;
}

// ------------------------------------------------------------------ chamadas

function authHeader(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

async function call(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ status: number; json: unknown } | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch {
    return null;
  }
}

async function oc(server: OcServer, auth: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown } | null> {
  return call(`${server.url}${path}`, {
    method,
    headers: { authorization: auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function hub(port: number, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown } | null> {
  return call(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, PERMISSION_TIMEOUT_MS);
}

// ------------------------------------------------------------------ permissões

function requestSummary(r: Rec): string {
  const resources = Array.isArray(r.resources) ? r.resources.map((x) => String(x)).join(', ') : '';
  return `${str(r.action) ?? 'açao'}${resources ? ` em ${resources}` : ''}`;
}

/** Decide os pedidos de permissão pendentes de um servidor, um de cada vez. Nunca lança. */
async function servePermissions(port: number, server: OcServer, auth: string, account: string, log: (s: string) => void, pending: Set<string>): Promise<void> {
  const res = await oc(server, auth, 'GET', '/api/permission/request');
  const data = rec(rec(res?.json)?.data !== undefined ? res?.json : undefined);
  const list = Array.isArray(data?.data) ? data!.data : [];
  for (const item of list) {
    const r = rec(item);
    const id = str(r?.id);
    const sessionID = str(r?.sessionID);
    if (!r || !id || !sessionID || pending.has(id)) continue;
    pending.add(id);
    void (async () => {
      try {
        const reg = await hub(port, 'POST', '/api/permissions', {
          provider: 'opencode',
          account,
          session_id: sessionID,
          tool_name: str(r.action) ?? 'permission',
          tool_input: {
            message: str(r.message),
            resources: Array.isArray(r.resources) ? r.resources : [],
            metadata: rec(r.metadata) ?? {},
          },
          timeout_ms: PERMISSION_TIMEOUT_MS,
        });
        const regInfo = rec(reg?.json);
        const pid = str(regInfo?.id);
        if (!reg || reg.status !== 201 || !pid) return; // sem página aberta ou sessão desconhecida: decide o terminal
        log(`✋ pedido do OpenCode registrado: ${requestSummary(r)} (${sessionID.slice(0, 10)}…)`);
        for (;;) {
          const w = await hub(port, 'GET', `/api/permissions/${encodeURIComponent(pid)}/wait?timeout=25`);
          const out = rec(w?.json);
          if (!w || !out || out.status === 'pending') continue;
          if (out.status === 'decided') {
            const allow = out.behavior === 'allow';
            const replied = await oc(server, auth, 'POST', `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(id)}/reply`, {
              decision: allow ? 'once' : 'reject',
              ...(allow ? {} : { message: str(out.message) ?? 'recusado pelo Habblaud' }),
            });
            log(`${allow ? '✓' : '✗'} decidido pelo escritório → ${replied?.status === 204 ? 'respondido ao OpenCode' : `falha ao responder (${replied?.status ?? 'fora do ar'})`}`);
          }
          break;
        }
      } finally {
        pending.delete(id);
      }
    })();
  }
}

// ------------------------------------------------------------------ mensagens

/** O servidor que atende a sessão (cache por sessionID; queda limpa). */
const sessionServer = new Map<string, OcServer>();

async function serverOf(servers: OcServer[], auth: string, sessionID: string): Promise<OcServer | undefined> {
  const hit = sessionServer.get(sessionID);
  if (hit && servers.some((s) => s.url === hit.url)) {
    const ok = await oc(hit, auth, 'GET', `/api/session/${encodeURIComponent(sessionID)}`);
    if (ok?.status === 200) return hit;
    sessionServer.delete(sessionID);
  }
  for (const s of servers) {
    const ok = await oc(s, auth, 'GET', `/api/session/${encodeURIComponent(sessionID)}`);
    if (ok?.status === 200) {
      sessionServer.set(sessionID, s);
      return s;
    }
  }
  return undefined;
}

async function serveMessages(port: number, servers: OcServer[], auth: string, log: (s: string) => void): Promise<void> {
  const polled = await hub(port, 'POST', '/api/opencode/bridge/poll', {});
  const list = rec(polled?.json)?.messages;
  if (!polled || polled.status !== 200 || !Array.isArray(list)) return;
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const raw of list) {
    const m = rec(raw);
    const id = str(m?.id);
    const sessionID = str(m?.sessionID);
    const text = typeof m?.text === 'string' ? m.text : '';
    if (!id || !sessionID || !text.trim()) {
      if (id) results.push({ id, ok: false, error: 'mensagem sem sessão ou vazia' });
      continue;
    }
    const server = await serverOf(servers, auth, sessionID);
    if (!server) {
      results.push({ id, ok: false, error: 'essa sessão do OpenCode não está aberta em nenhum servidor local' });
      continue;
    }
    const sent = await oc(server, auth, 'POST', `/api/session/${encodeURIComponent(sessionID)}/prompt`, { text });
    if (sent && (sent.status === 200 || sent.status === 201 || sent.status === 204)) {
      results.push({ id, ok: true });
      log(`✓ mensagem entregue à sessão ${sessionID.slice(0, 10)}… (OpenCode)`);
    } else {
      results.push({ id, ok: false, error: `o OpenCode recusou a mensagem (${sent?.status ?? 'fora do ar'})` });
    }
  }
  if (results.length) await hub(port, 'POST', '/api/opencode/bridge/ack', { results });
}

// ------------------------------------------------------------------ laço principal

export async function roundOnce(port: number, password: string, account: string, log: (s: string) => void): Promise<number> {
  const servers = await discoverServers(authHeader(password));
  if (!servers.length) return 0;
  const pending = globalPending;
  for (const s of servers) await servePermissions(port, s, authHeader(password), account, log, pending);
  for (const s of servers) await serveMessages(port, [s], authHeader(password), log);
  return servers.length;
}

const globalPending = new Set<string>();

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const password = readServicePassword();
  if (!password) throw new FatalError('não achei a senha do serviço do OpenCode em ~/.config/opencode/service.json.');
  const account = 'opencode';
  const log = (line: string) => console.log(`[opencode-bridge] ${line}`);
  log(`Ligando o escritório (http://127.0.0.1:${parsed.port}) aos servidores do OpenCode desta máquina. Ctrl+C para parar.`);
  let last = '';
  for (;;) {
    let n = 0;
    try {
      n = await roundOnce(parsed.port, password, account, log);
    } catch (err) {
      log(`✗ falha na rodada: ${String(err).slice(0, 120)}`);
    }
    const state = n ? `conectado a ${n} servidor(es) do OpenCode: aprovações e mensagens pelo escritório.` : 'nenhum servidor do OpenCode aberto; tentando de novo a cada 2 s (abra o opencode).';
    if (state !== last) log(state);
    last = state;
    if (parsed.once) {
      process.exitCode = n >= 0 ? 0 : 1;
      return;
    }
    await new Promise((ok) => setTimeout(ok, POLL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? `[opencode-bridge] Erro: ${err.message}` : `[opencode-bridge] Erro inesperado: ${String(err)}`);
    process.exitCode = 1;
  });
}
