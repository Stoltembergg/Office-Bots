// Biblioteca de skills, MCPs e memória das ferramentas no escritório: o Habblaud DESCOBRE sozinho
// onde cada conta guarda as suas e mostra tudo junto (Ajuda › "Skills, MCPs e memória"), para todas
// as pessoas que olham o escritório usarem. Instalar uma skill noutra ferramenta é copiar a pasta
// (SKILL.md + referências): sem segredos — MCPs e memórias nunca têm o conteúdo lido nem copiado,
// só nomes e presença.
//
// Onde cada ferramenta guarda (só o que estiver visível para este processo é listado):
// - Claude Code: <conta>/skills/*/SKILL.md, MCPs em ~/.claude.json (`mcpServers`), memória em
//   <conta>/MEMORY.md e <conta>/memory/;
// - Codex: <conta>/skills/*/SKILL.md, MCPs em <conta>/config.toml (`[mcp_servers.*]`), memória em
//   <conta>/memories_1.sqlite (só a existência);
// - OpenCode: skills em <dados>/skills ou nas raízes extras (HABBLAUD_SKILLS_DIRS), MCPs no
//   opencode.jsonc (`mcp`) ao lado delas;
// - DeepSeek Harness: não expõe skills, MCPs nem memória em arquivos conhecidos.
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { McpInfo, MemoryInfo, Provider, SkillInfo } from '../../shared/types';

export interface SkillAccount {
  provider: Provider;
  accountId: string;
  accountName: string;
  /** Pasta da conta visível para este processo (no Docker, a montada). */
  dir: string;
}

/** Skill com a pasta de origem (interno; no protocolo vai sem `dir`). */
export interface SkillEntry extends SkillInfo {
  /** Pasta da skill (SKILL.md dentro). */
  dir: string;
}

/** Inventário interno (com pastas, para instalar e sincronizar). */
export interface SkillsScan {
  skills: SkillEntry[];
  mcp: McpInfo[];
  memory: MemoryInfo[];
  /** Raízes extras de skills (HABBLAUD_SKILLS_DIRS) que existiram. */
  roots: string[];
  generatedAt: number;
}

/** Raiz extra no formato "provider:/caminho" (HABBLAUD_SKILLS_DIRS, separado por vírgula). */
export interface SkillsRoot {
  provider: Provider;
  dir: string;
}

/**
 * Fatos coletados no host (só nomes e presença, nunca segredos): no Docker vão em HABBLAUD_HOST_FACTS
 * (o container não enxerga ~/.claude.json nem config.toml, onde ficam credenciais).
 */
export interface HostFacts {
  mcp?: Array<{ provider: Provider; name: string; kind?: McpInfo['kind'] }>;
  memory?: Array<{ provider: Provider; kind: MemoryInfo['kind']; detail?: string }>;
}

/** HABBLAUD_HOST_FACTS (JSON do docker-up): leniente — lixo vira vazio. */
export function parseHostFacts(raw: string | undefined): HostFacts {
  if (!raw || !raw.trim()) return {};
  let j: { mcp?: unknown; memory?: unknown };
  try {
    j = JSON.parse(raw) as typeof j;
  } catch {
    return {};
  }
  const out: HostFacts = {};
  if (Array.isArray(j.mcp)) {
    const mcp = j.mcp
      .filter(
        (m): m is { provider: Provider; name: string; kind?: McpInfo['kind'] } =>
          !!m && typeof m === 'object' && isProvider((m as { provider?: unknown }).provider) && typeof (m as { name?: unknown }).name === 'string' && !!(m as { name: string }).name.trim(),
      )
      .slice(0, 200)
      .map((m) => ({ provider: m.provider, name: m.name.trim(), ...(m.kind === 'stdio' || m.kind === 'remote' ? { kind: m.kind } : {}) }));
    if (mcp.length) out.mcp = mcp;
  }
  if (Array.isArray(j.memory)) {
    const kinds = ['file', 'dir', 'sqlite'];
    const memory = j.memory
      .filter(
        (m): m is { provider: Provider; kind: MemoryInfo['kind']; detail?: string } =>
          !!m && typeof m === 'object' && isProvider((m as { provider?: unknown }).provider) && kinds.includes((m as { kind?: unknown }).kind as string),
      )
      .slice(0, 50)
      .map((m) => ({
        provider: m.provider,
        kind: m.kind,
        ...(typeof m.detail === 'string' && m.detail.trim() ? { detail: m.detail.trim().slice(0, 120) } : {}),
      }));
    if (memory.length) out.memory = memory;
  }
  return out;
}

const PROVIDERS: Provider[] = ['claude', 'codex', 'opencode', 'dsh'];

function isProvider(v: unknown): v is Provider {
  return typeof v === 'string' && (PROVIDERS as string[]).includes(v);
}

export function parseSkillsRoots(raw: string | undefined): SkillsRoot[] {
  const out: SkillsRoot[] = [];
  for (const part of (raw ?? '').split(',')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const provider = part.slice(0, i).trim();
    const dir = part.slice(i + 1).trim();
    if (isProvider(provider) && dir) out.push({ provider, dir });
  }
  return out;
}

/** Nome de skill válido (também barra traversal): letras, números, `_.-`, até 64. */
export function validSkillName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function readHead(p: string, maxBytes: number): string | undefined {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size <= 0) return undefined;
    const fd = readFileSync(p);
    return fd.subarray(0, Math.min(maxBytes, fd.length)).toString('utf8');
  } catch {
    return undefined;
  }
}

/** `name:`/`description:` do frontmatter do SKILL.md (primeiro bloco `---`, uma linha cada). */
export function parseSkillHead(text: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const head = m ? m[1] : text.split('\n').slice(0, 12).join('\n');
  const out: { name?: string; description?: string } = {};
  for (const line of head.split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if ((key === 'name' || key === 'description') && out[key] === undefined) {
      out[key] = kv[2].replace(/^['"]|['"]$/g, '');
    }
  }
  return out;
}

function trunc(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Skills de uma pasta `<raiz>/skills` (uma subpasta por skill, com SKILL.md dentro). */
export function readSkillsDir(skillsDir: string, owner: Pick<SkillEntry, 'provider' | 'accountId' | 'accountName'>): SkillEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  const out: SkillEntry[] = [];
  for (const name of entries.slice(0, 500)) {
    if (!validSkillName(name) || name.startsWith('.')) continue;
    const dir = join(skillsDir, name);
    const skillFile = join(dir, 'SKILL.md');
    if (!isDir(dir) || !isFile(skillFile)) continue;
    const head = readHead(skillFile, 8192);
    const meta = head ? parseSkillHead(head) : {};
    let updatedAt = 0;
    try {
      updatedAt = Math.round(statSync(skillFile).mtimeMs);
    } catch {
      // sem mtime: fica 0
    }
    out.push({
      name: meta.name || name,
      description: trunc(meta.description || '', 280),
      dir,
      updatedAt,
      ...owner,
    });
    if (out.length >= 200) break;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Servidores MCP do Claude Code em ~/.claude.json: SÓ nomes e o tipo (comando ou URL); `env` e segredos, nunca. */
export function readClaudeMcp(home: string, owner: Pick<McpInfo, 'provider' | 'accountId' | 'accountName'>): McpInfo[] {
  const raw = readHead(join(home, '.claude.json'), 512 * 1024);
  if (!raw) return [];
  let json: { mcpServers?: Record<string, { command?: unknown; url?: unknown }> };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    return [];
  }
  const servers = json?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  return Object.keys(servers)
    .slice(0, 200)
    .map((name) => {
      const s = servers[name] ?? {};
      const kind = typeof s.url === 'string' && s.url ? 'remote' : typeof s.command === 'string' && s.command ? 'stdio' : 'unknown';
      return { name, kind, ...owner };
    });
}

/** Servidores MCP do Codex em <conta>/config.toml: SÓ os nomes em `[mcp_servers.*]` (valores, nunca). */
export function readCodexMcp(configToml: string, owner: Pick<McpInfo, 'provider' | 'accountId' | 'accountName'>): McpInfo[] {
  const raw = readHead(configToml, 64 * 1024);
  if (!raw) return [];
  const out: McpInfo[] = [];
  const re = /^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_.-]+))\]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null && out.length < 200) {
    out.push({ name: m[1] ?? m[2], kind: 'unknown', ...owner });
  }
  return out;
}

/** Tira comentários `//` e `/*…*\/` respeitando strings (para o opencode.jsonc). */
export function stripJsonComments(src: string): string {
  let out = '';
  let i = 0;
  let str: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (str) {
      out += c;
      if (c === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === str) str = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      str = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Servidores MCP do OpenCode no opencode.jsonc ao lado das skills: SÓ nomes e o tipo. */
export function readOpencodeMcp(jsoncPath: string, owner: Pick<McpInfo, 'provider' | 'accountId' | 'accountName'>): McpInfo[] {
  const raw = readHead(jsoncPath, 128 * 1024);
  if (!raw) return [];
  let json: { mcp?: Record<string, { type?: unknown; url?: unknown; command?: unknown }> };
  try {
    // JSONC tolerante: sem comentários e sem vírgulas sobrando antes de `}`/`]`.
    const clean = stripJsonComments(raw).replace(/,(\s*[}\]])/g, '$1');
    json = JSON.parse(clean) as typeof json;
  } catch {
    return [];
  }
  const mcp = json?.mcp;
  if (!mcp || typeof mcp !== 'object') return [];
  return Object.keys(mcp)
    .slice(0, 200)
    .map((name) => {
      const s = mcp[name] ?? {};
      const kind = s.type === 'remote' || (typeof s.url === 'string' && s.url) ? 'remote' : s.type === 'local' || s.command !== undefined ? 'stdio' : 'unknown';
      return { name, kind, ...owner };
    });
}

/** Memória visível de uma conta (só presença e caminhos; o conteúdo, nunca). */
export function readMemory(account: SkillAccount): MemoryInfo[] {
  const out: MemoryInfo[] = [];
  const base = { provider: account.provider, accountId: account.accountId, accountName: account.accountName };
  if (account.provider === 'claude') {
    const file = join(account.dir, 'MEMORY.md');
    if (isFile(file)) out.push({ kind: 'file', path: file, detail: 'memória do usuário', ...base });
    const dir = join(account.dir, 'memory');
    if (isDir(dir)) {
      let n = 0;
      try {
        for (const f of readdirSync(dir)) if (f.endsWith('.md')) n++;
      } catch {
        // ilegível: conta 0
      }
      out.push({ kind: 'dir', path: dir, detail: n === 1 ? '1 nota' : `${n} notas`, ...base });
    }
  } else if (account.provider === 'codex') {
    const db = join(account.dir, 'memories_1.sqlite');
    if (isFile(db)) out.push({ kind: 'sqlite', path: db, detail: 'memórias do Codex (banco)', ...base });
  }
  return out;
}

export interface InventoryOptions {
  home?: string;
  extraRoots?: SkillsRoot[];
  /** Fatos do host (HABBLAUD_HOST_FACTS): somados sem duplicar o que os arquivos mostram. */
  hostFacts?: HostFacts;
  now?: () => number;
}

/**
 * Inventário completo: skills de cada conta (`<dir>/skills`) e das raízes extras, MCPs (nomes)
 * e memória (presença). Deduplica skills pela pasta de origem.
 */
export function buildInventory(accounts: SkillAccount[], opts: InventoryOptions = {}): SkillsScan {
  const now = opts.now ?? Date.now;
  const home = opts.home ?? homedir();
  const skills: SkillEntry[] = [];
  const mcp: McpInfo[] = [];
  const memory: MemoryInfo[] = [];
  const seen = new Set<string>();
  const roots: string[] = [];
  const addSkills = (skillsDir: string, owner: Pick<SkillEntry, 'provider' | 'accountId' | 'accountName'>) => {
    for (const s of readSkillsDir(skillsDir, owner)) {
      if (seen.has(s.dir)) continue;
      seen.add(s.dir);
      skills.push(s);
    }
  };
  for (const a of accounts) {
    const owner = { provider: a.provider, accountId: a.accountId, accountName: a.accountName };
    if (a.provider === 'claude' || a.provider === 'codex' || a.provider === 'opencode') addSkills(join(a.dir, 'skills'), owner);
    if (a.provider === 'codex') mcp.push(...readCodexMcp(join(a.dir, 'config.toml'), owner));
    memory.push(...readMemory(a));
  }
  // MCPs globais do Claude Code (valem para todas as contas dele).
  const claude = accounts.find((a) => a.provider === 'claude');
  if (claude) mcp.push(...readClaudeMcp(home, { provider: 'claude', accountId: '', accountName: '' }));
  // Raízes extras (ex.: skills do OpenCode fora da pasta de dados).
  for (const r of opts.extraRoots ?? []) {
    if (!isDir(r.dir)) continue;
    roots.push(r.dir);
    const owner = { provider: r.provider, accountId: '', accountName: '' };
    addSkills(r.dir, owner);
    // opencode.jsonc ao lado (ou um nível acima) das skills.
    if (r.provider === 'opencode') {
      for (const cand of [join(r.dir, 'opencode.jsonc'), join(dirname(r.dir), 'opencode.jsonc')]) {
        const found = readOpencodeMcp(cand, owner);
        if (found.length) {
          mcp.push(...found);
          break;
        }
      }
    }
  }
  // Padrões do OpenCode no modo Node (no Docker só valem se montados).
  if (!opts.extraRoots?.length) {
    for (const cand of [join(home, '.config', 'opencode', 'skills'), join(home, '.opencode', 'skills')]) {
      if (!isDir(cand)) continue;
      roots.push(cand);
      const owner = { provider: 'opencode' as const, accountId: '', accountName: '' };
      addSkills(cand, owner);
      for (const jsonc of [join(cand, 'opencode.jsonc'), join(dirname(cand), 'opencode.jsonc')]) {
        const found = readOpencodeMcp(jsonc, owner);
        if (found.length) {
          mcp.push(...found);
          break;
        }
      }
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  // Fatos do host (Docker): completam o que os arquivos montados não mostram, sem duplicar.
  for (const m of opts.hostFacts?.mcp ?? []) {
    if (!mcp.some((e) => e.provider === m.provider && e.name === m.name)) {
      mcp.push({ name: m.name, kind: m.kind ?? 'unknown', provider: m.provider, accountId: '', accountName: '' });
    }
  }
  for (const m of opts.hostFacts?.memory ?? []) {
    if (!memory.some((e) => e.provider === m.provider && e.kind === m.kind && (e.detail || '') === (m.detail || ''))) {
      memory.push({ kind: m.kind, path: '', detail: m.detail || defaultMemoryDetail(m.kind), provider: m.provider, accountId: '', accountName: '' });
    }
  }
  return { skills, mcp, memory, roots, generatedAt: now() };
}

function defaultMemoryDetail(kind: MemoryInfo['kind']): string {
  return kind === 'sqlite' ? 'memórias (banco)' : kind === 'dir' ? 'notas' : 'memória';
}

/** Pastas de skills com escrita (para instalar): `<dir>/skills` de cada conta do provedor. */
export function writableSkillsDirs(accounts: SkillAccount[], provider: Provider): string[] {
  return accounts.filter((a) => a.provider === provider).map((a) => join(a.dir, 'skills'));
}

export interface InstallResult {
  ok: true;
  name: string;
  from: string;
  to: string;
}

/**
 * Instala uma skill noutra ferramenta: copia a pasta inteira (SKILL.md + referências). Nunca
 * sobrescreve (destino existente = erro) e nunca sai das pastas de skills (barra traversal = erro).
 */
export function installSkill(allSkills: SkillEntry[], args: { name: string; fromDir: string; toDir: string }): InstallResult {
  const { name, fromDir, toDir } = args;
  if (!validSkillName(name)) throw new Error('nome de skill inválido');
  const src = resolve(fromDir, name);
  const dst = resolve(toDir, name);
  if (src !== resolve(fromDir) && !src.startsWith(resolve(fromDir) + sep)) throw new Error('origem fora das skills');
  if (dst !== resolve(toDir) && !dst.startsWith(resolve(toDir) + sep)) throw new Error('destino fora das skills');
  const known = allSkills.some((s) => s.name === name && resolve(s.dir) === src);
  if (!known) throw new Error('skill desconhecida no inventário');
  if (!isDir(src) || !isFile(join(src, 'SKILL.md'))) throw new Error('skill sem SKILL.md na origem');
  if (isDir(dst) || isFile(dst)) throw new Error('a skill já existe no destino');
  mkdirSync(toDir, { recursive: true });
  cpSync(src, dst, { recursive: true, errorOnExist: true });
  return { ok: true, name, from: src, to: dst };
}

/** Cópia automática das skills que faltam entre provedores (HABBLAUD_SKILLS_SYNC=1): nunca sobrescreve. */
export function syncMissingSkills(allSkills: SkillEntry[], writableByProvider: Map<Provider, string[]>): Array<{ name: string; to: string; error?: string }> {
  const out: Array<{ name: string; to: string; error?: string }> = [];
  const byName = new Map<string, SkillEntry[]>();
  for (const s of allSkills) {
    const list = byName.get(s.name) ?? [];
    list.push(s);
    byName.set(s.name, list);
  }
  for (const [name, entries] of byName) {
    const have = new Set(entries.map((e) => e.provider));
    for (const [provider, dirs] of writableByProvider) {
      if (have.has(provider)) continue;
      const toDir = dirs[0];
      if (!toDir) continue;
      if (!validSkillName(name)) continue;
      const dst = resolve(toDir, name);
      if (isDir(dst) || isFile(dst)) continue;
      try {
        mkdirSync(toDir, { recursive: true });
        cpSync(resolve(entries[0].dir), dst, { recursive: true, errorOnExist: true });
        out.push({ name, to: dst });
      } catch (err) {
        out.push({ name, to: dst, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return out;
}
