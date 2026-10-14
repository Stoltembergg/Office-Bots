// Biblioteca de skills/MCPs/memória: descoberta, cópia e sincronização.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Provider } from '../../shared/types';
import {
  buildInventory,
  installSkill,
  parseHostFacts,
  parseSkillHead,
  parseSkillsRoots,
  readClaudeMcp,
  readCodexMcp,
  readOpencodeMcp,
  stripJsonComments,
  syncMissingSkills,
  validSkillName,
  writableSkillsDirs,
  type SkillAccount,
  type SkillEntry,
} from './inventory';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function mkroot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'habblaud-skills-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function skill(dir: string, name: string, head = ''): string {
  const d = join(dir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), head || `---\nname: ${name}\ndescription: Faz coisas de ${name}.\n---\n\n# ${name}\n`);
  return d;
}

const acc = (provider: SkillAccount['provider'], accountId: string, dir: string): SkillAccount => ({ provider, accountId, accountName: accountId, dir });

describe('skills: descoberta', () => {
  it('lê nome e descrição do frontmatter; sem SKILL.md ignora; nomes inválidos ignora', () => {
    const root = mkroot();
    mkdirSync(join(root, 'skills'));
    skill(join(root, 'skills'), 'boa');
    skill(join(root, 'skills'), 'sem-meta', '# só título\n');
    mkdirSync(join(root, 'skills', 'vazia'));
    mkdirSync(join(root, 'skills', '..evil'));
    const inv = buildInventory([acc('claude', '.claude', root)], { home: root });
    expect(inv.skills.map((s) => [s.name, s.description])).toEqual([
      ['boa', 'Faz coisas de boa.'],
      ['sem-meta', ''],
    ]);
    expect(inv.skills[0]).toMatchObject({ provider: 'claude', accountId: '.claude' });
  });

  it('parseSkillHead: aspas e descrições longas', () => {
    expect(parseSkillHead('---\nname: x\ndescription: "Com aspas."\n---\n')).toEqual({ name: 'x', description: 'Com aspas.' });
    expect(parseSkillHead('sem frontmatter')).toEqual({});
  });

  it('MCPs: nomes sem segredos (Claude JSON, Codex TOML, OpenCode JSONC com comentários)', () => {
    const root = mkroot();
    writeFileSync(join(root, 'claude.json'), JSON.stringify({ mcpServers: { motion: { command: 'x', env: { TOKEN: 'segredo' } }, web: { url: 'https://a/b' } } }));
    const claude = readClaudeMcp(root, { provider: 'claude', accountId: '', accountName: '' });
    // precisa apontar para o arquivo ~/.claude.json: usa o dir como home no teste
    expect(claude).toEqual([]);
    const home = mkroot();
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { motion: { command: 'x', env: { TOKEN: 'segredo' } }, web: { url: 'https://a/b' } } }));
    expect(readClaudeMcp(home, { provider: 'claude', accountId: '', accountName: '' })).toEqual([
      { name: 'motion', kind: 'stdio', provider: 'claude', accountId: '', accountName: '' },
      { name: 'web', kind: 'remote', provider: 'claude', accountId: '', accountName: '' },
    ]);
    writeFileSync(join(root, 'config.toml'), '[mcp_servers.motion]\ncommand = "x"\n[mcp_servers."com-hifen"]\nurl = "https://a"\n[profile]\n');
    expect(readCodexMcp(join(root, 'config.toml'), { provider: 'codex', accountId: '.codex', accountName: '.codex' }).map((m) => m.name)).toEqual(['motion', 'com-hifen']);
    writeFileSync(
      join(root, 'opencode.jsonc'),
      '// comentário\n{ "mcp": { "local": { "type": "local", "command": ["x"] }, /* bloco */ "remoto": { "type": "remote", "url": "https://b", }, }, }',
    );
    expect(readOpencodeMcp(join(root, 'opencode.jsonc'), { provider: 'opencode', accountId: '', accountName: '' })).toEqual([
      { name: 'local', kind: 'stdio', provider: 'opencode', accountId: '', accountName: '' },
      { name: 'remoto', kind: 'remote', provider: 'opencode', accountId: '', accountName: '' },
    ]);
  });

  it('memória: só presença (MEMORY.md, pasta memory/, banco do Codex)', () => {
    const claude = mkroot();
    writeFileSync(join(claude, 'MEMORY.md'), '# eu\n');
    mkdirSync(join(claude, 'memory'));
    writeFileSync(join(claude, 'memory', 'a.md'), 'x');
    const codex = mkroot();
    writeFileSync(join(codex, 'memories_1.sqlite'), 'nada real');
    const inv = buildInventory([acc('claude', '.claude', claude), acc('codex', '.codex', codex)], { home: mkroot() });
    expect(inv.memory.map((m) => [m.kind, m.provider])).toEqual([
      ['file', 'claude'],
      ['dir', 'claude'],
      ['sqlite', 'codex'],
    ]);
    expect(inv.memory[1].detail).toBe('1 nota');
  });

  it('raízes extras com provedor; parseSkillsRoots ignora lixo', () => {
    const extra = mkroot();
    mkdirSync(join(extra, 'skills'));
    skill(join(extra, 'skills'), 'compartilhada');
    const inv = buildInventory([], { home: mkroot(), extraRoots: [{ provider: 'opencode', dir: join(extra, 'skills') }] });
    expect(inv.skills.map((s) => [s.name, s.provider])).toEqual([['compartilhada', 'opencode']]);
    expect(inv.roots).toEqual([join(extra, 'skills')]);
    expect(parseSkillsRoots('opencode:/a/b,lixo,codex:/c')).toEqual([
      { provider: 'opencode', dir: '/a/b' },
      { provider: 'codex', dir: '/c' },
    ]);
    expect(validSkillName('../x')).toBe(false);
    expect(validSkillName('boa-skill.v2')).toBe(true);
  });
});

describe('skills: instalar e sincronizar', () => {
  function twoTools(): { claude: string; codex: string; all: SkillEntry[] } {
    const claude = mkroot();
    const codex = mkroot();
    mkdirSync(join(claude, 'skills'));
    mkdirSync(join(codex, 'skills'));
    const d = skill(join(claude, 'skills'), 'revisao');
    const all: SkillEntry[] = [{ name: 'revisao', description: '', provider: 'claude', accountId: '.claude', accountName: '.claude', dir: d, updatedAt: 0 }];
    return { claude: join(claude, 'skills'), codex: join(codex, 'skills'), all };
  }

  it('installSkill: copia a pasta; existente dá erro; traversal dá erro', () => {
    const { claude, codex, all } = twoTools();
    const r = installSkill(all, { name: 'revisao', fromDir: claude, toDir: codex });
    expect(r.ok).toBe(true);
    expect(() => installSkill(all, { name: 'revisao', fromDir: claude, toDir: codex })).toThrow(/já existe/);
    expect(() => installSkill(all, { name: '../x', fromDir: claude, toDir: codex })).toThrow(/inválido/);
    expect(() => installSkill(all, { name: 'sumida', fromDir: claude, toDir: codex })).toThrow(/desconhecida/);
  });

  it('syncMissingSkills: copia o que falta, nunca sobrescreve', () => {
    const { codex, all } = twoTools();
    const writable = new Map<Provider, string[]>([['codex', [codex]]]);
    const done = syncMissingSkills(all, writable);
    expect(done.filter((d) => !d.error).map((d) => d.name)).toEqual(['revisao']);
    // De novo: já existe, nada a fazer.
    expect(syncMissingSkills(all, writable)).toEqual([]);
  });

  it('writableSkillsDirs: uma pasta por conta do provedor', () => {
    const a = acc('claude', '.claude', '/h/.claude');
    const b = acc('claude', '.claude-2', '/h/.claude-2');
    expect(writableSkillsDirs([a, b], 'claude')).toEqual([join('/h/.claude', 'skills'), join('/h/.claude-2', 'skills')]);
    expect(writableSkillsDirs([a], 'codex')).toEqual([]);
  });

  it('stripJsonComments respeita strings', () => {
    expect(stripJsonComments('{"a": "x // não é comentário", "b": 1} // fim')).toBe('{"a": "x // não é comentário", "b": 1} ');
  });

  it('parseHostFacts: leniente; merge soma sem duplicar', () => {
    expect(parseHostFacts(undefined)).toEqual({});
    expect(parseHostFacts('lixo')).toEqual({});
    expect(parseHostFacts('{"mcp":[{"provider":"codex","name":"a"},{"provider":"x","name":"b"},{"provider":"claude"}],"memory":[{"provider":"codex","kind":"sqlite","detail":"m"}]}')).toEqual({
      mcp: [{ provider: 'codex', name: 'a' }],
      memory: [{ provider: 'codex', kind: 'sqlite', detail: 'm' }],
    });
    const root = mkroot();
    mkdirSync(join(root, 'skills'));
    skill(join(root, 'skills'), 's1');
    writeFileSync(join(root, 'config.toml'), '[mcp_servers.a]\ncommand = "x"\n');
    const inv = buildInventory([acc('codex', '.codex', root)], {
      home: root,
      hostFacts: { mcp: [{ provider: 'codex', name: 'a' }, { provider: 'codex', name: 'b', kind: 'remote' }], memory: [{ provider: 'codex', kind: 'sqlite' }] },
    });
    // 'a' já veio do arquivo (sem duplicar); 'b' veio dos fatos; memória sem detalhe ganha o padrão.
    expect(inv.mcp).toEqual([
      { name: 'a', kind: 'unknown', provider: 'codex', accountId: '.codex', accountName: '.codex' },
      { name: 'b', kind: 'remote', provider: 'codex', accountId: '', accountName: '' },
    ]);
    expect(inv.memory).toEqual([{ kind: 'sqlite', path: '', detail: 'memórias (banco)', provider: 'codex', accountId: '', accountName: '' }]);
  });
});
