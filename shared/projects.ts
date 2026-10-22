// Cidade dos projetos: as salas do escritório (uma por cwd) agrupadas por projeto. Os worktrees do Claude Code
// (<projeto>/.claude/worktrees/<nome>) entram no prédio do projeto; o distrito é o disco (C:, D:) ou "/" fora do Windows.
import type { AgentStatus, OfficeSnapshot } from './types';

export interface ProjectGroup {
  /** Raiz do projeto (o caminho da sala sem o trecho do worktree). Chave estável do prédio. */
  root: string;
  name: string;
  district: string;
  roomIds: string[];
  /** Status dos agentes principais do projeto, um por sessão (as janelas acesas do prédio). */
  sessions: AgentStatus[];
}

/** Tamanho do projeto medido pelo servidor (GET /api/projects); null = não deu para medir (sem git, sem acesso). */
export interface ProjectSize {
  root: string;
  commits: number | null;
  files: number | null;
}

const WORKTREE = /[\\/]\.(?:claude|codex)[\\/]worktrees[\\/][^\\/]+$/i;

export function projectRoot(path: string): string {
  return path.replace(WORKTREE, '');
}

export function districtOf(path: string): string {
  const drive = /^([a-z]):/i.exec(path);
  return drive ? `${drive[1].toUpperCase()}:` : '/';
}

function basename(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop() ?? path;
}

/** Prédios do escritório, em ordem de chegada da primeira sala de cada projeto. */
export function groupProjects(snap: Pick<OfficeSnapshot, 'rooms' | 'agents'>): ProjectGroup[] {
  const byRoot = new Map<string, ProjectGroup>();
  const byRoom = new Map<string, ProjectGroup>();
  for (const room of [...snap.rooms].sort((a, b) => a.slot - b.slot)) {
    const root = projectRoot(room.path);
    let g = byRoot.get(root.toLowerCase());
    if (!g) {
      g = { root, name: basename(root), district: districtOf(root), roomIds: [], sessions: [] };
      byRoot.set(root.toLowerCase(), g);
    }
    g.roomIds.push(room.id);
    byRoom.set(room.id, g);
  }
  for (const a of snap.agents) if (a.kind === 'main') byRoom.get(a.roomId)?.sessions.push(a.status);
  return [...byRoot.values()];
}

/** Mesmo projeto? Caminhos do Windows não diferenciam maiúsculas. */
export function sameRoot(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** O escritório só com as salas (e os agentes) de um projeto: o "dentro do prédio". */
export function onlyProject(snap: OfficeSnapshot, root: string): OfficeSnapshot {
  const rooms = snap.rooms.filter((r) => sameRoot(projectRoot(r.path), root));
  const ids = new Set(rooms.map((r) => r.id));
  return { ...snap, rooms, agents: snap.agents.filter((a) => ids.has(a.roomId)) };
}
