// Leitor das sessões do DeepSeek Harness (DSH): <dshHome>/sessions/--<cwd-normalizado>--/<id>/session.v4.jsonl.zstd
// (ou session.v4.jsonl sem compressão). O arquivo é uma sequência de frames Zstandard (um por evento, com checksum),
// cada um contendo uma linha JSON. Leitura incremental: cada ciclo só decodifica os frames novos (os frames são
// adicionados inteiros; um frame cortado no fim — escrita em andamento — falha na decodificação e é tentado de novo
// no ciclo seguinte). Node 22.12+ tem zlib.zstd*; nada de dependências.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

export const DSH_SESSIONS_DIR = 'sessions';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); // 0xFD2FB528 little-endian

/** Evento normalizado de uma linha do log do DSH. */
export interface DshEvent {
  type: string;
  /** epoch ms (campo `time`; o cabeçalho da sessão usa `createdAt`). */
  time: number;
  data?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

/** Cabeçalho (primeira linha, `type: "session"`). */
export interface DshSessionHeader {
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  origin?: string;
  delegationDepth?: number;
  agentPreset?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Interpreta uma linha decodificada; undefined = não é um evento válido. */
export function parseDshLine(line: string): DshEvent | undefined {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object') return undefined;
  const type = str(j.type);
  if (!type) return undefined;
  const time = num(j.time) ?? num(j.createdAt) ?? 0;
  const data = j.data && typeof j.data === 'object' && !Array.isArray(j.data) ? (j.data as Record<string, unknown>) : undefined;
  return { type, time, data, raw: j };
}

/** Cabeçalho do evento `type: "session"`. */
export function dshHeader(ev: DshEvent): DshSessionHeader | undefined {
  if (ev.type !== 'session') return undefined;
  const id = str(ev.raw.id);
  if (!id) return undefined;
  return {
    id,
    createdAt: num(ev.raw.createdAt) ?? ev.time,
    cwd: str(ev.raw.cwd),
    parentSession: str(ev.raw.parentSession),
    origin: str(ev.raw.origin),
    delegationDepth: num(ev.raw.delegationDepth),
    agentPreset: str(ev.raw.agentPreset),
  };
}

/** Nome da pasta do projeto: "--<cwd normalizado>--" (ou "_no-cwd_"): o cwd original, se der para ler. */
export function cwdFromSessionDir(projectDirName: string): string | undefined {
  const m = /^--(.+)--$/.exec(projectDirName);
  if (!m) return undefined;
  // O normalizador troca / ? : \ por "-" — não é reversível com certeza; no Windows o padrão é "C-Users-...".
  let s = m[1];
  if (/^[A-Za-z]-/.test(s)) s = `${s[0]}:/${s.slice(2)}`;
  if (!s.includes('/') && !s.includes('\\')) s = s.replace(/-/g, '/');
  if (/^[A-Za-z]:\//.test(s)) s = s.replace(/\//g, sep === '\\' ? '\\' : '/');
  return s;
}

/** Arquivo de sessão dentro da pasta da sessão (comprimido, senão texto puro). */
export function sessionFileOf(dir: string): string | undefined {
  for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']) {
    const p = join(dir, name);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // segue
    }
  }
  return undefined;
}

export interface DshSessionFile {
  /** Id da sessão (nome da pasta). */
  sessionId: string;
  /** Caminho do arquivo de log. */
  path: string;
  projectDirName: string;
  /** mtime do arquivo (última escrita). */
  mtimeMs: number;
  size: number;
}

/** Sessões de uma pasta do DSH: sessions/<projeto>/<sessão>/<arquivo>. */
export function listDshSessions(dshHome: string): DshSessionFile[] {
  const out: DshSessionFile[] = [];
  const root = join(dshHome, DSH_SESSIONS_DIR);
  let projects: string[];
  try {
    projects = readdirSync(root);
  } catch {
    return out;
  }
  for (const proj of projects) {
    const pdir = join(root, proj);
    let sessions: string[];
    try {
      if (!statSync(pdir).isDirectory()) continue;
      sessions = readdirSync(pdir);
    } catch {
      continue;
    }
    for (const sid of sessions) {
      const sdir = join(pdir, sid);
      const file = sessionFileOf(sdir);
      if (!file) continue;
      try {
        const st = statSync(file);
        out.push({ sessionId: sid, path: resolve(file), projectDirName: proj, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // sumiu
      }
    }
  }
  return out;
}

/**
 * Leitor incremental de um arquivo de sessão zstd-jsonl. `read()` devolve SÓ os eventos novos desde a última
 * chamada (e o header, na primeira leitura boa). Um frame cortado no fim é ignorado até o arquivo crescer.
 */
export class DshLogReader {
  private size = -1;
  private nextScan = 0;
  private lastGoodSize = 0;

  constructor(readonly path: string) {}

  /** Eventos novos; `changed` = o arquivo cresceu desde a última leitura. Releituras completas não acontecem. */
  read(): { events: DshEvent[]; changed: boolean; mtimeMs: number; size: number } {
    let st;
    try {
      st = statSync(this.path);
    } catch {
      return { events: [], changed: false, mtimeMs: 0, size: 0 };
    }
    if (st.size === this.size) return { events: [], changed: false, mtimeMs: st.mtimeMs, size: st.size };
    const shrunk = this.size >= 0 && st.size < this.lastGoodSize;
    let raw: Buffer;
    try {
      raw = readFileSync(this.path);
    } catch {
      return { events: [], changed: false, mtimeMs: st.mtimeMs, size: st.size };
    }
    if (shrunk || this.nextScan > raw.length) {
      // Arquivo truncado/substituído: recomeça.
      this.nextScan = 0;
    }
    const events: DshEvent[] = [];
    if (this.path.endsWith('.zstd')) {
      // Procura o próximo frame a partir de nextScan; o decoder para sozinho no fim do frame.
      let lastFail = -1;
      for (let o = this.nextScan; o !== -1 && o <= raw.length - 4; ) {
        const next = raw.indexOf(ZSTD_MAGIC, o);
        if (next === -1) break;
        o = next + 1; // continua a busca depois deste magic (falso positivo = payload)
        let line: string;
        try {
          line = zstdDecompressSync(raw.subarray(next)).toString('utf8');
        } catch {
          lastFail = next; // frame cortado na escrita ou magic dentro do payload
          continue;
        }
        const ev = parseDshLine(line.trim());
        if (ev) events.push(ev);
      }
      // Retenta o último magic que falhou no próximo ciclo (pode ser o frame ainda sendo escrito).
      this.nextScan = lastFail >= 0 ? lastFail : raw.length;
    } else {
      const text = raw.toString('utf8', this.nextScan);
      const endNl = text.lastIndexOf('\n');
      const complete = endNl >= 0 ? text.slice(0, endNl) : '';
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        const ev = parseDshLine(line);
        if (ev) events.push(ev);
      }
      this.nextScan = this.nextScan + (endNl >= 0 ? endNl + 1 : 0);
    }
    this.size = st.size;
    this.lastGoodSize = raw.length;
    return { events, changed: true, mtimeMs: st.mtimeMs, size: st.size };
  }
}
