// Grade de caminhabilidade do mundo (1 célula por tile), com origem (x0, y0) em tiles, que pode ser negativa.
//   0 = bloqueado, 1 = livre, 2 = livre porém evitado (assentos: o A* só passa se precisar).
// Índice em `cells` = (y − y0)·w + (x − x0): use `key`/`at` em vez de calcular na mão.

export const BLOCKED = 0;
export const FREE = 1;
export const SEAT = 2;

export class WalkGrid {
  readonly cells: Uint8Array;

  constructor(
    readonly w: number,
    readonly h: number,
    readonly version = 0,
    readonly x0 = 0,
    readonly y0 = 0,
  ) {
    this.cells = new Uint8Array(w * h);
  }

  /** Grade que cobre exatamente o retângulo `r` (em tiles). */
  static forRect(r: { x: number; y: number; w: number; h: number }, version = 0): WalkGrid {
    return new WalkGrid(r.w, r.h, version, r.x, r.y);
  }

  /** Índice de (x, y) em `cells`. Não checa limites: fora da caixa o índice não vale (confira `inside` antes). */
  key(x: number, y: number): number {
    return (y - this.y0) * this.w + (x - this.x0);
  }

  /** Tile do índice `i` de `cells` (inverso de `key`). Aloca; nos laços quentes use xOf/yOf. */
  at(i: number): { x: number; y: number } {
    return { x: this.xOf(i), y: this.yOf(i) };
  }

  xOf(i: number): number {
    return (i % this.w) + this.x0;
  }

  yOf(i: number): number {
    return Math.floor(i / this.w) + this.y0;
  }

  inside(x: number, y: number): boolean {
    return x >= this.x0 && y >= this.y0 && x < this.x0 + this.w && y < this.y0 + this.h;
  }

  get(x: number, y: number): number {
    return this.inside(x, y) ? this.cells[this.key(x, y)] : BLOCKED;
  }

  set(x: number, y: number, v: number): void {
    if (this.inside(x, y)) this.cells[this.key(x, y)] = v;
  }

  walkable(x: number, y: number): boolean {
    return this.get(x, y) !== BLOCKED;
  }

  fill(x: number, y: number, w: number, h: number, v: number): void {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, v);
  }

  /**
   * Tile caminhável mais próximo (busca em anel), ou null. Só devolve tiles de dentro da caixa; com `accept`, só os
   * que ele aprova (ex.: a mesma região do prédio, para ninguém "atravessar a rua" num relayout).
   */
  nearestWalkable(x: number, y: number, maxR = 12, accept?: (x: number, y: number) => boolean): { x: number; y: number } | null {
    const ok = (tx: number, ty: number) => this.walkable(tx, ty) && (!accept || accept(tx, ty));
    if (ok(x, y)) return { x, y };
    for (let r = 1; r <= maxR; r++) {
      let best: { x: number; y: number } | null = null;
      let bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (!ok(x + dx, y + dy)) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = { x: x + dx, y: y + dy };
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  /** BFS: conjunto de índices (`key`) alcançáveis a partir de (x, y). */
  reachableFrom(x: number, y: number): Uint8Array {
    const seen = new Uint8Array(this.w * this.h);
    if (!this.walkable(x, y)) return seen;
    const queue = new Int32Array(this.w * this.h);
    let head = 0;
    let tail = 0;
    const start = this.key(x, y);
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const i = queue[head++];
      const cx = this.xOf(i);
      const cy = this.yOf(i);
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const ny = cy + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (!this.walkable(nx, ny)) continue;
        const j = this.key(nx, ny);
        if (seen[j]) continue;
        seen[j] = 1;
        queue[tail++] = j;
      }
    }
    return seen;
  }
}
