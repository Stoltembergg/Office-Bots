// Serviço da biblioteca de skills: inventário via contas + instalação com trava de escrita.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountsService } from '../accounts/service';
import { HttpError } from '../http/app';
import { SkillsService } from './http';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function mkAccount(provider: 'claude' | 'codex', id: string): { dir: string; entry: { provider: 'claude' | 'codex'; id: string; detected: { name: string }; dir: string } } {
  const dir = mkdtempSync(join(tmpdir(), `habblaud-svc-${id}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'skills', 'revisao'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'revisao', 'SKILL.md'), '---\nname: revisao\ndescription: Revisa textos.\n---\n');
  return { dir, entry: { provider, id, detected: { name: id }, dir } };
}

function svc(home: string, entries: Array<{ provider: 'claude' | 'codex'; id: string; detected: { name: string }; dir: string }>): SkillsService {
  const accounts = { allEntries: () => entries } as unknown as AccountsService;
  return new SkillsService({ accounts, home, env: {} });
}

describe('serviço de skills', () => {
  it('inventário: skills das contas + instalação entre ferramentas', () => {
    const home = mkdtempSync(join(tmpdir(), 'habblaud-svc-home-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const a = mkAccount('claude', '.claude');
    const b = mkAccount('codex', '.codex');
    const s = svc(home, [a.entry, b.entry]);
    const inv = s.inventory();
    expect(inv.skills.map((x) => [x.name, x.provider])).toEqual([
      ['revisao', 'claude'],
      ['revisao', 'codex'],
    ]);
    // A do codex já existe lá: instalar a do claude no codex dá 409.
    expect(() => s.install({ name: 'revisao', from: { provider: 'claude', accountId: '.claude' }, toProvider: 'codex' })).toThrow(HttpError);
    // Nome ruim e destino igual: 400.
    expect(() => s.install({ name: '../x', from: { provider: 'claude', accountId: '.claude' }, toProvider: 'codex' })).toThrow(/esperado/);
    expect(() => s.install({ name: 'revisao', from: { provider: 'claude', accountId: '.claude' }, toProvider: 'claude' })).toThrow(/mesma ferramenta/);
    // Desconhecida: 404.
    expect(() => s.install({ name: 'sumida', from: { provider: 'claude', accountId: '.claude' }, toProvider: 'codex' })).toThrow(/não encontrada/);
  });

  it('instala de verdade quando o destino não tem', () => {
    const home = mkdtempSync(join(tmpdir(), 'habblaud-svc-home-'));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const a = mkAccount('claude', '.claude');
    const dirB = mkdtempSync(join(tmpdir(), 'habblaud-svc-codex-'));
    cleanups.push(() => rmSync(dirB, { recursive: true, force: true }));
    const s = svc(home, [a.entry, { provider: 'codex', id: '.codex', detected: { name: '.codex' }, dir: dirB }]);
    const r = s.install({ name: 'revisao', from: { provider: 'claude', accountId: '.claude' }, toProvider: 'codex' });
    expect(r.ok).toBe(true);
    expect(s.inventory().skills.filter((x) => x.provider === 'codex').map((x) => x.name)).toContain('revisao');
  });
});
