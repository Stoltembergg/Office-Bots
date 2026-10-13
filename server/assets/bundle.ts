// Exportar/importar assets como um arquivo só (.habblaud.json; formato em shared/assets.ts): uma sala com os itens
// que ela usa, um item, ou a pasta inteira (com o office.json). A importação nunca sobrescreve: ids repetidos
// ganham sufixo e as referências `item:<id>` das salas importadas acompanham a troca.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLE_FORMAT, bundleProblem, referencedItems, renameItemRefs, slugId, validId, type AssetBundle } from '../../shared/assets';
import { pngSize } from './store';

export class BundleError extends Error {}

/**
 * Campos que cada arquivo aceita (os mesmos que shared/assets.ts lê). Um pacote vem de outra pessoa e o Arquiteto (um
 * agente) lê os arquivos gravados: só esses campos são gravados, e texto livre só no nome e na descrição (curtos, como
 * na validação). Dentro deles (móveis, mesas, pixel art...) só passam valores com cara de valor: números, booleanos e
 * textos sem espaço de até 64 caracteres (ids, kinds, cores, linhas de pixel art); uma frase (instrução disfarçada) cai.
 */
const ITEM_KEYS = ['name', 'description', 'w', 'h', 'mount', 'seat', 'anchor', 'blocks', 'pixels', 'frontPixels'];
const ROOM_KEYS = ['name', 'description', 'floor', 'floorTint', 'wall', 'carpet', 'deskVariant', 'chairVariant', 'desks', 'seats', 'furniture', 'wallItems', 'stands', 'rugs'];
const OFFICE_KEYS = ['defaultRoom', 'projects', 'areas'];
/** Os únicos textos livres: tamanho máximo como na validação (shared/assets.ts). */
const FREE_TEXT_MAX: Record<string, number> = { name: 80, description: 400 };
/** Valor aninhado: sem espaço nem quebra de linha (linhas de pixel art têm até SPRITE_MAX_PX = 96 caracteres). */
const TOKEN = /^\S{0,96}$/;
/** Nome do projeto (chave de office.projects): nome de pasta ou caminho, numa linha só. */
const PROJECT_KEY = /^[^\n\r\t]{1,200}$/;

function cleanValue(v: unknown, depth: number, keyOk: (k: string) => boolean = (k) => TOKEN.test(k)): unknown {
  if (typeof v === 'string') return TOKEN.test(v) ? v : undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean' || v === null) return v;
  if (depth > 6 || typeof v !== 'object') return undefined;
  if (Array.isArray(v)) return v.slice(0, 2000).map((x) => cleanValue(x, depth + 1) ?? null);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 500)) {
    if (!keyOk(k)) continue;
    const c = cleanValue(x, depth + 1);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

/** Pixel art: espaço e "." são o mesmo transparente; com ".", a linha passa como valor (sem espaço). */
function spacesAsDots(v: unknown): unknown {
  if (!v || typeof v !== 'object' || !Array.isArray((v as { rows?: unknown }).rows)) return v;
  const p = v as { rows: unknown[] };
  return { ...p, rows: p.rows.map((r) => (typeof r === 'string' ? r.replace(/ /g, '.') : r)) };
}

/** Só os campos conhecidos do arquivo, com texto livre só no nome e na descrição (ver ITEM_KEYS). */
export function cleanImported(json: unknown, keys: readonly string[]): unknown {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const src = json as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (!(k in src)) continue;
    const v = src[k];
    const free = FREE_TEXT_MAX[k];
    const c = free
      ? typeof v === 'string'
        ? v.replace(/[\r\n]+/g, ' ').slice(0, free)
        : undefined
      : k === 'projects'
        ? cleanValue(v, 0, (p) => PROJECT_KEY.test(p))
        : cleanValue(k === 'pixels' || k === 'frontPixels' ? spacesAsDots(v) : v, 0);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    throw new BundleError(`não consegui ler ${file}`);
  }
}

function readItem(dir: string, id: string): AssetBundle['items'][string] {
  const folder = join(dir, 'items', id);
  if (!validId(id) || !existsSync(join(folder, 'item.json'))) throw new BundleError(`item "${id}" não encontrado`);
  const files: Record<string, string> = {};
  for (const name of readdirSync(folder)) {
    if (/^[a-z0-9_-]+\.png$/i.test(name)) files[name] = readFileSync(join(folder, name)).toString('base64');
  }
  return { json: readJson(join(folder, 'item.json')), files };
}

function listIds(dir: string, kind: 'items' | 'rooms'): string[] {
  try {
    return readdirSync(join(dir, kind))
      .map((n) => (kind === 'rooms' ? (n.endsWith('.json') ? n.slice(0, -5) : '') : n))
      .filter((id) => validId(id) && (kind === 'rooms' || existsSync(join(dir, 'items', id, 'item.json'))));
  } catch {
    return [];
  }
}

export function exportBundle(dir: string, what: { room?: string; item?: string; all?: boolean }): AssetBundle {
  const bundle: AssetBundle = { format: BUNDLE_FORMAT, version: 1, name: '', exportedAt: new Date().toISOString(), items: {}, rooms: {} };
  const addItems = (json: unknown) => {
    for (const id of referencedItems(json)) if (!bundle.items[id] && existsSync(join(dir, 'items', id, 'item.json'))) bundle.items[id] = readItem(dir, id);
  };
  if (what.all) {
    bundle.name = 'tudo';
    for (const id of listIds(dir, 'rooms')) bundle.rooms[id] = readJson(join(dir, 'rooms', `${id}.json`));
    for (const id of listIds(dir, 'items')) bundle.items[id] = readItem(dir, id);
    if (existsSync(join(dir, 'office.json'))) bundle.office = readJson(join(dir, 'office.json'));
  } else if (what.room) {
    const id = what.room;
    const file = join(dir, 'rooms', `${id}.json`);
    if (!validId(id) || !existsSync(file)) throw new BundleError(`sala "${id}" não encontrada`);
    bundle.name = id;
    bundle.rooms[id] = readJson(file);
    addItems(bundle.rooms[id]);
  } else if (what.item) {
    bundle.name = what.item;
    bundle.items[what.item] = readItem(dir, what.item);
  } else throw new BundleError('diga o que exportar: room=<id>, item=<id> ou all=1');
  return bundle;
}

export interface ImportResult {
  rooms: string[];
  items: string[];
  office?: string;
  renamed: Record<string, string>;
}

/** Primeiro id livre: o próprio, ou com -2, -3... */
function freeId(base: string, taken: (id: string) => boolean): string {
  const id = validId(base) ? base : slugId(base);
  if (!taken(id)) return id;
  for (let n = 2; ; n++) {
    const c = `${id.slice(0, 44)}-${n}`;
    if (!taken(c)) return c;
  }
}

export function importBundle(dir: string, raw: unknown): ImportResult {
  const problem = bundleProblem(raw);
  if (problem) throw new BundleError(problem);
  const bundle = raw as AssetBundle;
  const result: ImportResult = { rooms: [], items: [], renamed: {} };
  // valida as imagens antes de gravar qualquer coisa
  for (const [id, it] of Object.entries(bundle.items)) {
    for (const [name, b64] of Object.entries(it.files)) {
      if (!pngSize(Buffer.from(b64, 'base64'))) throw new BundleError(`"${name}" do item "${id}" não é um PNG`);
    }
  }
  const itemMap = new Map<string, string>();
  for (const [from, it] of Object.entries(bundle.items)) {
    const id = freeId(from, (c) => existsSync(join(dir, 'items', c)));
    if (id !== from) {
      itemMap.set(from, id);
      result.renamed[`item:${from}`] = `item:${id}`;
    }
    const folder = join(dir, 'items', id);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'item.json'), `${JSON.stringify(cleanImported(it.json, ITEM_KEYS), null, 2)}\n`);
    for (const [name, b64] of Object.entries(it.files)) writeFileSync(join(folder, name), Buffer.from(b64, 'base64'));
    result.items.push(id);
  }
  const roomMap = new Map<string, string>();
  mkdirSync(join(dir, 'rooms'), { recursive: true });
  for (const [from, json] of Object.entries(bundle.rooms)) {
    const id = freeId(from, (c) => existsSync(join(dir, 'rooms', `${c}.json`)));
    if (id !== from) {
      roomMap.set(from, id);
      result.renamed[from] = id;
    }
    writeFileSync(join(dir, 'rooms', `${id}.json`), `${JSON.stringify(renameItemRefs(cleanImported(json, ROOM_KEYS), itemMap), null, 2)}\n`);
    result.rooms.push(id);
  }
  if (bundle.office !== undefined) {
    // office.json existente fica: o importado vai ao lado (o usuário ou o Arquiteto juntam os dois)
    let office = renameItemRefs(cleanImported(bundle.office, OFFICE_KEYS), itemMap) as Record<string, unknown>;
    if (office && typeof office === 'object' && !Array.isArray(office)) {
      office = { ...office };
      const swap = (v: unknown) => (typeof v === 'string' ? (roomMap.get(v) ?? v) : v);
      if ('defaultRoom' in office) office.defaultRoom = swap(office.defaultRoom);
      if (office.projects && typeof office.projects === 'object') {
        office.projects = Object.fromEntries(Object.entries(office.projects as Record<string, unknown>).map(([k, v]) => [k, swap(v)]));
      }
    }
    const name = existsSync(join(dir, 'office.json')) ? freeId(`office-importado`, (c) => existsSync(join(dir, `${c}.json`))) + '.json' : 'office.json';
    writeFileSync(join(dir, name), `${JSON.stringify(office, null, 2)}\n`);
    result.office = name;
  }
  return result;
}
