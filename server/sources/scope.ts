// Escopo por pasta (HABBLAUD_PROJECT_ROOTS) de um arquivo inteiro: transcript do Claude Code ou rollout do Codex.
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { cwdsInText } from '../model/rooms';

/** O que o arquivo inteiro diz sobre o escopo por pasta (fileScope). */
export type FileScope = { status: 'in' } | { status: 'out'; cwd: string } | { status: 'unknown' };

const SCAN_CHUNK = 4 * 1024 * 1024;
/** Sobra do bloco anterior relida no seguinte: um "cwd" cortado na divisa ainda é achado. */
const SCAN_OVERLAP = 8 * 1024;
/** ponytail: cache simples por caminho, zerado inteiro ao passar do teto (LRU se um dia fizer falta). */
const SCAN_CACHE_MAX = 2_000;
const scanCache = new Map<string, { size: number; mtimeMs: number; scope: (cwd: string) => boolean; result: FileScope }>();

/**
 * Escopo por pasta do arquivo inteiro: 'in' só se ele cita alguma pasta e todas estão no escopo; 'out' com a
 * primeira de fora; 'unknown' sem nenhuma (ainda sem linha com cwd, ou ilegível). Lê o arquivo todo em blocos (só o
 * que mudou de tamanho ou de mtime é relido), para nada de outra pasta escapar por estar fora da janela lida.
 */
export function fileScope(path: string, scope: (cwd: string) => boolean): FileScope {
  let size: number;
  let mtimeMs: number;
  try {
    ({ size, mtimeMs } = statSync(path));
  } catch {
    return { status: 'unknown' };
  }
  const hit = scanCache.get(path);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs && hit.scope === scope) return hit.result;
  let result: FileScope = { status: 'unknown' };
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(SCAN_CHUNK);
      let carry = '';
      for (let pos = 0; pos < size; ) {
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        pos += n;
        const text = carry + buf.toString('utf8', 0, n);
        for (const cwd of cwdsInText(text)) {
          if (!scope(cwd)) {
            result = { status: 'out', cwd };
            break;
          }
          result = { status: 'in' };
        }
        if (result.status === 'out') break;
        carry = text.slice(-SCAN_OVERLAP);
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return { status: 'unknown' };
  }
  if (scanCache.size >= SCAN_CACHE_MAX) scanCache.clear();
  scanCache.set(path, { size, mtimeMs, scope, result });
  return result;
}
