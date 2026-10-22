// Rua da cidade dos projetos (painel Cidade, ui/project-city.ts): um prédio em pixel art por projeto. Andares pelos
// commits (escala log; sem git, pelos arquivos), largura pelos arquivos, uma janela por sessão principal. O modelo
// (streetBuildings) é puro e testado em street.test.ts; drawStreet só pinta no canvas.
import { hash32 } from '../../../../shared/hash';
import type { ProjectGroup, ProjectSize } from '../../../../shared/projects';
import type { AgentStatus } from '../../../../shared/types';

export type FacadeStyle = 'brick' | 'concrete' | 'glass' | 'deco';

export interface StreetBuilding {
  root: string;
  name: string;
  floors: number;
  cols: number;
  style: FacadeStyle;
  /** Uma janela acesa por sessão, a partir do térreo. */
  windows: AgentStatus[];
  commits: number | null;
  files: number | null;
}

export interface StreetHit {
  root: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const STREET_H = 240;
const GROUND = 192;
const FLOOR_H = 9;
const BASE_H = 14;
const MIN_GAP = 18;
const MIN_W = 480;
const STYLES: FacadeStyle[] = ['brick', 'concrete', 'glass', 'deco'];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 10 commits ≈ 5 andares, 100 ≈ 10, 1000+ ≈ 15 (máx. 16); sempre cabe uma janela por sessão. */
export function floorsOf(size: number | null, cols: number, sessions: number): number {
  const byGit = clamp(Math.round(Math.log2((size ?? 0) + 1) * 1.5), 3, 16);
  return Math.max(byGit, Math.ceil(sessions / cols));
}

export function colsOf(files: number | null): number {
  return clamp(Math.round(Math.log10((files ?? 0) + 1) * 2), 3, 7);
}

export function streetBuildings(groups: readonly ProjectGroup[], sizes: readonly ProjectSize[]): StreetBuilding[] {
  const byRoot = new Map(sizes.map((s) => [s.root.toLowerCase(), s]));
  return groups.map((g) => {
    const s = byRoot.get(g.root.toLowerCase());
    const commits = s?.commits ?? null;
    const files = s?.files ?? null;
    const cols = colsOf(files);
    return {
      root: g.root,
      name: g.name,
      cols,
      floors: floorsOf(commits ?? files, cols, g.sessions.length),
      style: STYLES[hash32(g.root.toLowerCase()) % STYLES.length],
      windows: g.sessions,
      commits,
      files,
    };
  });
}

const widthOf = (b: StreetBuilding) => b.cols * 8 + 6;

/** Largura da rua em pixels do canvas: cabe todo mundo com folga, nunca menos que `min` (a largura da janela). */
export function streetWidth(buildings: readonly StreetBuilding[], min = MIN_W): number {
  return Math.max(MIN_W, min, buildings.reduce((n, b) => n + widthOf(b) + MIN_GAP, MIN_GAP));
}

const FACADE: Record<FacadeStyle, { wall: string; shade: string; trim: string; frame: string; mortar: string }> = {
  brick: { wall: '#9a4f3c', shade: '#73392c', trim: '#d8c3a0', frame: '#5a2d22', mortar: '#86442f' },
  concrete: { wall: '#8b93a8', shade: '#666d82', trim: '#c9ced9', frame: '#4d5366', mortar: '#7a8297' },
  glass: { wall: '#35587a', shade: '#263f59', trim: '#9cc3e0', frame: '#203449', mortar: '#2d4b69' },
  deco: { wall: '#c4a464', shade: '#97793f', trim: '#f0e1b6', frame: '#6e5529', mortar: '#b29353' },
};

/** Cores das janelas: as do status no resto da interface (styles.css, --st-*), mais claras para acender. */
function windowColor(st: AgentStatus | undefined, k: number, tick: number): string {
  if (st === undefined) return hash32(`w${k}`) % 5 === 0 ? '#2b3350' : '#1c2238';
  if (st === 'working') return '#ffd77a';
  if (st === 'waiting') return (tick >> 2) % 2 ? '#ffb547' : '#8a5a2a';
  if (st === 'shell') return '#3cd8d2';
  return '#8fa6d6';
}

export interface StreetView {
  tick: number;
  hover: string | null;
  selected: string | null;
  /** Cor do toldo (o distrito). */
  accent: string;
}

/** Pinta a rua no canvas (largura = streetWidth, altura = STREET_H) e devolve onde está cada prédio. */
export function drawStreet(ctx: CanvasRenderingContext2D, buildings: readonly StreetBuilding[], view: StreetView): StreetHit[] {
  const W = ctx.canvas.width;
  const { tick } = view;
  const px = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };

  // céu do entardecer em faixas pontilhadas, estrelas e lua
  const bands = ['#151735', '#1d1d45', '#2a2352', '#3d2b5c', '#5a3463', '#7f4366', '#a55a62', '#c97a5e'];
  const bh = GROUND / bands.length;
  bands.forEach((c, i) => {
    px(0, Math.floor(i * bh), W, Math.ceil(bh) + 1, c);
    const next = bands[i + 1];
    if (next) for (let x = (i % 2) * 2; x < W; x += 4) px(x, Math.floor((i + 1) * bh) - 1, 2, 1, next);
  });
  for (let i = 0; i < W / 10; i++) {
    const r = hash32(`st${i}`);
    if ((r >> 10) % 90 > 48) continue;
    px(r % W, (r >> 8) % 80, 1, 1, (r + tick) % 61 < 2 ? '#ffffff' : '#8d8fc9');
  }
  px(W - 80, 22, 10, 10, '#f3e3b0');
  px(W - 82, 24, 14, 6, '#f3e3b0');

  // prédios de fundo
  const skyline = (seed: string, color: string, lit: string, minH: number, maxH: number, step: number) => {
    for (let x = -4; x < W; x += step) {
      const r = hash32(seed + x);
      const w = step - 2 - (r % 4);
      const h = minH + (r % (maxH - minH));
      px(x, GROUND - h, w, h, color);
      for (let wy = GROUND - h + 4; wy < GROUND - 4; wy += 6)
        for (let wx = x + 2; wx < x + w - 2; wx += 4) if (hash32(`${seed}${wx}:${wy}`) % 7 === 0) px(wx, wy, 1, 2, lit);
    }
  };
  skyline('far', '#3a2c5c', '#5d4a7e', 40, 110, 22);
  skyline('mid', '#2a2448', '#c79a5e', 25, 75, 30);

  // calçada, rua e carros
  px(0, GROUND, W, 8, '#5d607c');
  for (let x = 0; x < W; x += 12) px(x, GROUND, 1, 8, '#4c4f69');
  px(0, GROUND + 8, W, 2, '#9296b0');
  px(0, GROUND + 10, W, 26, '#2a2c42');
  for (let x = 0; x < W; x += 24) px(x, GROUND + 22, 12, 2, '#cfc77d');
  px(0, GROUND + 36, W, 2, '#9296b0');
  px(0, GROUND + 38, W, STREET_H - GROUND - 38, '#5d607c');
  for (const car of [{ y: GROUND + 13, dir: 1, c: '#d65a5a', off: 0 }, { y: GROUND + 25, dir: -1, c: '#e3c45a', off: 260 }]) {
    const span = W + 60;
    const x = car.dir > 0 ? ((tick * 2 + car.off) % span) - 30 : W - ((tick * 2 + car.off) % span) + 8;
    px(x, car.y + 2, 22, 5, car.c);
    px(x + 5, car.y, 11, 3, car.c);
    px(x + 7, car.y + 1, 7, 2, '#a9d4f2');
    px(x + 3, car.y + 7, 4, 2, '#15162a');
    px(x + 15, car.y + 7, 4, 2, '#15162a');
    px(car.dir > 0 ? x + 21 : x, car.y + 3, 1, 2, '#fff3b0');
  }

  const lamp = (x: number) => {
    px(x, GROUND - 24, 1, 24, '#3c3f58');
    px(x - 2, GROUND - 25, 5, 2, '#3c3f58');
    px(x - 1, GROUND - 23, 3, 1, '#ffe6a0');
    ctx.globalAlpha *= 0.12;
    px(x - 6, GROUND - 22, 13, 22, '#ffe6a0');
    ctx.globalAlpha /= 0.12;
  };
  const tree = (x: number) => {
    px(x, GROUND - 8, 2, 8, '#5a3b2a');
    px(x - 4, GROUND - 16, 10, 8, '#2f6b4c');
    px(x - 3, GROUND - 19, 8, 3, '#3c8560');
    px(x - 2, GROUND - 14, 3, 2, '#4f9e73');
  };

  const building = (b: StreetBuilding, x: number): StreetHit => {
    const s = FACADE[b.style];
    const w = widthOf(b);
    const h = BASE_H + b.floors * FLOOR_H;
    const top = GROUND - h;
    px(x, top, w, h, s.wall);
    px(x + w - 3, top, 3, h, s.shade);
    if (b.style === 'brick')
      for (let y = top + 2; y < GROUND - BASE_H; y += 3) for (let bx = x + ((y >> 1) % 2) * 3; bx < x + w - 3; bx += 6) px(bx, y, 3, 1, s.mortar);
    if (b.style === 'glass') for (let bx = x + 3; bx < x + w - 3; bx += 8) px(bx, top + 3, 1, h - BASE_H - 3, s.mortar);
    if (b.style === 'deco') {
      px(x + 2, top + 3, 1, h - BASE_H - 3, s.trim);
      px(x + w - 5, top + 3, 1, h - BASE_H - 3, s.trim);
    }

    let k = 0;
    for (let f = 0; f < b.floors; f++) {
      const wy = GROUND - BASE_H - (f + 1) * FLOOR_H + 2;
      if (b.style === 'concrete') px(x, wy + 6, w - 3, 1, s.mortar);
      for (let c = 0; c < b.cols; c++) {
        const wx = x + 4 + c * 8;
        const st = b.windows[k];
        px(wx - 1, wy - 1, 6, 7, s.frame);
        px(wx, wy, 4, 5, windowColor(st, hash32(b.root) + k, tick));
        if (st === undefined) px(wx, wy, 1, 1, '#3a4568');
        if (b.style !== 'glass') px(wx - 1, wy + 5, 6, 1, s.trim);
        k++;
      }
    }

    // térreo: vitrine, porta e toldo na cor do distrito
    const by = GROUND - BASE_H;
    px(x, by, w, BASE_H, s.shade);
    px(x + 3, by + 6, w - 6, 7, '#1d2a40');
    px(x + 4, by + 7, w - 8, 2, '#ffd9a0');
    const door = x + Math.floor(w / 2) - 3;
    px(door, by + 5, 6, 9, s.frame);
    px(door + 1, by + 6, 4, 8, '#3a2a22');
    px(door + 4, by + 10, 1, 1, '#ffd77a');
    for (let ax = x + 1; ax < x + w - 1; ax += 4) {
      px(ax, by + 1, 2, 3, view.accent);
      px(ax + 2, by + 1, 2, 3, '#f2f0f8');
    }

    // cornija e telhado
    px(x - 1, top - 2, w + 2, 3, s.trim);
    px(x - 1, top + 1, w + 2, 1, s.shade);
    if (b.style === 'brick') {
      px(x + 4, top - 11, 8, 7, '#7a5a40');
      px(x + 3, top - 12, 10, 2, '#5c4330');
      px(x + 5, top - 4, 1, 2, '#5c4330');
      px(x + 10, top - 4, 1, 2, '#5c4330');
    } else if (b.style === 'glass') {
      const ax = x + Math.floor(w / 2);
      px(ax, top - 16, 1, 14, '#9aa3c0');
      px(ax - 2, top - 8, 5, 1, '#9aa3c0');
      px(ax, top - 17, 1, 1, (tick >> 2) % 2 ? '#ff4d4d' : '#6b2a2a');
    } else if (b.style === 'concrete') {
      px(x + 3, top - 6, 7, 4, '#a7adbf');
      px(x + 4, top - 5, 5, 1, '#6c7286');
      px(x + w - 12, top - 5, 6, 3, '#a7adbf');
    } else {
      px(x + 3, top - 9, w - 6, 7, s.frame);
      px(x + 4, top - 8, w - 8, 5, view.accent);
    }

    const sel = b.root === view.selected;
    if (sel || b.root === view.hover) {
      const c = sel ? '#ffc857' : '#ffffff';
      const y0 = top - 18;
      px(x - 3, y0, w + 6, 1, c);
      px(x - 3, GROUND, w + 6, 1, c);
      px(x - 3, y0, 1, GROUND - y0, c);
      px(x + w + 2, y0, 1, GROUND - y0, c);
    }
    return { root: b.root, x: x - 3, y: top - 18, w: w + 6, h: h + 18 };
  };

  const total = buildings.reduce((n, b) => n + widthOf(b), 0);
  const gap = (W - total) / (buildings.length + 1);
  let x = gap;
  const hits: StreetHit[] = [];
  buildings.forEach((b, i) => {
    if (i > 0) {
      const mid = Math.round(x - gap / 2);
      if (i % 2) lamp(mid);
      else tree(mid);
    }
    hits.push(building(b, Math.round(x)));
    x += widthOf(b) + gap;
  });
  return hits;
}
