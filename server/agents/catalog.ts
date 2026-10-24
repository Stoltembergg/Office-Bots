import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentPatch, AgentProfile, Project } from '../../shared/agents/contracts';
import { tr } from '../../shared/i18n';

type Catalog = { schemaVersion: 1; projects: Project[]; agents: AgentProfile[] };
const invalid = () => new Error(tr('Cadastro inválido.'));
const text = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
function object(x: unknown): x is Record<string, unknown> { return typeof x === 'object' && x !== null && !Array.isArray(x); }
function keys(x: Record<string, unknown>, allowed: string[]) { return Object.keys(x).every(k => allowed.includes(k)); }
function policy(x: unknown): boolean {
  if (!object(x)) return false;
  if (x.mode === 'choose-on-start') return keys(x, ['mode']);
  const s = x.selection;
  return x.mode === 'fixed' && keys(x, ['mode', 'selection']) && object(s)
    && keys(s, ['providerId', 'accountId', 'modelId', 'thinkingLevel'])
    && text(s.providerId) && text(s.accountId) && text(s.modelId)
    && (s.thinkingLevel === undefined || text(s.thinkingLevel));
}
function project(x: unknown): x is Project {
  return object(x) && keys(x, ['id', 'name', 'cwd']) && text(x.id) && text(x.name) && text(x.cwd) && path.isAbsolute(x.cwd);
}
function agent(x: unknown): x is AgentProfile {
  return object(x) && keys(x, ['id', 'projectId', 'name', 'instructions', 'appearanceSeed', 'modelPolicy', 'archivedAt'])
    && text(x.id) && text(x.projectId) && text(x.name) && text(x.appearanceSeed) && policy(x.modelPolicy)
    && (x.instructions === undefined || typeof x.instructions === 'string')
    && (x.archivedAt === undefined || (text(x.archivedAt) && Number.isFinite(Date.parse(x.archivedAt))));
}
function validate(x: unknown): asserts x is Catalog {
  if (!object(x) || x.schemaVersion !== 1 || !Array.isArray(x.projects) || !Array.isArray(x.agents)
    || !x.projects.every(project) || !x.agents.every(agent)) throw invalid();
  const ids = new Set(x.projects.map(p => p.id));
  if (ids.size !== x.projects.length || new Set(x.agents.map(a => a.id)).size !== x.agents.length
    || x.agents.some(a => !ids.has(a.projectId))) throw invalid();
}

/** One shared catalog per userData directory; never stored inside a project.
 * A lock collision fails closed. A stale lock must be resolved explicitly after
 * confirming its owner exited; it is never silently stolen from a live process.
 */
export class CatalogStore {
  private readonly file: string;
  private readonly lock: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly directory: string, private readonly isAgentBusy: (id: string) => boolean) {
    this.file = path.join(directory, 'catalog.json');
    this.lock = path.join(directory, 'catalog.lock');
  }
  private async read(): Promise<Catalog> {
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, projects: [], agents: [] }; throw error; }
    const value: unknown = JSON.parse(raw);
    validate(value);
    return value;
  }
  private mutate<T>(change: (data: Catalog) => T | Promise<T>): Promise<T> {
    const task = this.pending.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await mkdir(this.lock);
      const temporary = path.join(this.directory, `catalog-${randomUUID()}.tmp`);
      try {
        const data = await this.read();
        const result = await change(data);
        validate(data);
        await writeFile(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.file);
        return structuredClone(result);
      } finally {
        await rm(temporary, { force: true });
        await rm(this.lock, { recursive: true });
      }
    });
    this.pending = task.catch(() => undefined);
    return task;
  }
  async listProjects(): Promise<Project[]> { return (await this.read()).projects; }
  async getProject(id: string): Promise<Project> {
    const result = (await this.read()).projects.find(p => p.id === id);
    if (!result) throw invalid(); return result;
  }
  createProject(input: Pick<Project, 'name' | 'cwd'>): Promise<Project> {
    const copy = structuredClone(input);
    return this.mutate(async data => {
      if (!text(copy.name) || !text(copy.cwd) || !path.isAbsolute(copy.cwd)) throw invalid();
      const cwd = await realpath(copy.cwd);
      if (!(await stat(cwd)).isDirectory()) throw invalid();
      const result = { id: randomUUID(), name: copy.name.trim(), cwd };
      data.projects.push(result); return result;
    });
  }
  async listAgents(projectId: string): Promise<AgentProfile[]> { return (await this.read()).agents.filter(a => a.projectId === projectId); }
  async getAgent(id: string): Promise<AgentProfile> {
    const result = (await this.read()).agents.find(a => a.id === id);
    if (!result) throw invalid(); return result;
  }
  async requireActiveAgent(id: string): Promise<AgentProfile> {
    const result = await this.getAgent(id);
    if (result.archivedAt) throw invalid(); return result;
  }
  createAgent(input: Omit<AgentProfile, 'id' | 'archivedAt'>): Promise<AgentProfile> {
    const copy = structuredClone(input);
    return this.mutate(data => {
      const result: AgentProfile = { ...copy, id: randomUUID() };
      if (!agent(result) || result.archivedAt !== undefined || !data.projects.some(p => p.id === result.projectId)) throw invalid();
      data.agents.push(result); return result;
    });
  }
  updateAgent(id: string, patch: AgentPatch): Promise<AgentProfile> {
    const copy = structuredClone(patch);
    return this.mutate(data => {
      const index = data.agents.findIndex(a => a.id === id);
      if (index < 0 || this.isAgentBusy(id) || data.agents[index].archivedAt || !object(copy)
        || !keys(copy, ['name', 'instructions', 'appearanceSeed', 'modelPolicy'])) throw invalid();
      const updated = { ...data.agents[index], ...copy };
      if (!agent(updated)) throw invalid();
      data.agents[index] = updated; return updated;
    });
  }
  archiveAgent(id: string): Promise<void> {
    return this.mutate(data => {
      const result = data.agents.find(a => a.id === id);
      if (!result || this.isAgentBusy(id)) throw invalid();
      result.archivedAt ??= new Date().toISOString();
    });
  }
}
