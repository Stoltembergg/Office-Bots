// Salas do escritório: identidade (cwd normalizado), nome exibido e posição (slot) no prédio.
import { posix } from 'node:path';

/** cwd normalizado: sem barras repetidas nem barra final. */
export function normalizeCwd(cwd: string): string {
  const p = cwd.trim().replace(/\/{2,}/g, '/');
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * O cwd está numa das raízes (a própria pasta ou algo dentro dela)? Sem raízes, tudo vale. Compara só o texto
 * (normalizado): no Docker os caminhos são do host e não existem no container, então não dá para usar realpath.
 */
export function inRoots(cwd: string, roots: readonly string[]): boolean {
  if (!roots.length) return true;
  // posix.normalize resolve `.` e `..` pelo texto (o destino é o que conta); symlinks ficam como estão.
  const c = normalizeCwd(posix.normalize(cwd));
  return roots.some((root) => {
    const r = normalizeCwd(posix.normalize(root));
    return c === r || c.startsWith(r === '/' ? r : `${r}/`);
  });
}

/** Todo `"cwd"` de uma linha crua de JSONL (Claude Code: em cada linha; Codex: session_meta e turn_context). */
const CWD_RE = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/g;

/**
 * A primeira pasta fora do escopo citada na linha, ou undefined. Busca no texto cru (sem parse da linha inteira):
 * barato o bastante para rodar em toda linha. Um valor ilegível conta como fora.
 */
export function cwdOutOfScope(line: string, scope: (cwd: string) => boolean): string | undefined {
  if (!line.includes('"cwd"')) return undefined;
  for (const m of line.matchAll(CWD_RE)) {
    let cwd: unknown;
    try {
      cwd = JSON.parse(m[1]);
    } catch {
      return '?';
    }
    if (typeof cwd !== 'string' || !scope(cwd)) return String(cwd);
  }
  return undefined;
}

function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/**
 * Nome de cada sala: o basename do caminho; salas com o mesmo basename ganham o(s) diretório(s)
 * pai até ficarem distintas (ex.: "applications/app" e "outro/app").
 */
export function roomDisplayNames(rooms: ReadonlyMap<string, string>): Map<string, string> {
  const segs = new Map([...rooms].map(([id, path]) => [id, segments(path)]));
  const depth = new Map([...rooms.keys()].map((id) => [id, 1]));
  const nameOf = (id: string) => {
    const s = segs.get(id)!;
    return s.length ? s.slice(-depth.get(id)!).join('/') : rooms.get(id) || '/';
  };
  for (let guard = 0; guard < 16; guard++) {
    const groups = new Map<string, string[]>();
    for (const id of rooms.keys()) {
      const n = nameOf(id);
      groups.set(n, [...(groups.get(n) ?? []), id]);
    }
    let grew = false;
    for (const ids of groups.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) {
        if (depth.get(id)! < segs.get(id)!.length) {
          depth.set(id, depth.get(id)! + 1);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  return new Map([...rooms.keys()].map((id) => [id, nameOf(id)]));
}

/**
 * Distribui slots: a sala nova pega o menor slot livre que não esteja em espera.
 * Um slot liberado só volta a ser usado após `cooldownMs` (tempo da animação de saída).
 */
export class SlotAllocator {
  private slots = new Map<string, number>();
  private freedAt = new Map<number, number>();

  constructor(private readonly cooldownMs = 30_000) {}

  /** Ajusta as alocações ao conjunto atual de salas. Devolve true se algo mudou. */
  sync(ids: Iterable<string>, now: number): boolean {
    const live = new Set(ids);
    let changed = false;
    for (const [id, slot] of [...this.slots]) {
      if (live.has(id)) continue;
      this.slots.delete(id);
      this.freedAt.set(slot, now);
      changed = true;
    }
    for (const id of live) {
      if (this.slots.has(id)) continue;
      this.slots.set(id, this.firstFree(now));
      changed = true;
    }
    return changed;
  }

  slotOf(id: string): number | undefined {
    return this.slots.get(id);
  }

  private firstFree(now: number): number {
    const used = new Set(this.slots.values());
    for (let slot = 0; ; slot++) {
      if (used.has(slot)) continue;
      const freed = this.freedAt.get(slot);
      if (freed !== undefined && now - freed < this.cooldownMs) continue;
      this.freedAt.delete(slot);
      return slot;
    }
  }
}
