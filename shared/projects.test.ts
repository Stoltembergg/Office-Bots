import { describe, expect, it } from 'vitest';
import { districtOf, groupProjects, projectRoot } from './projects';
import type { AgentInfo, RoomInfo } from './types';

const room = (id: string, path: string, slot: number) => ({ id, path, slot }) as RoomInfo;
const agent = (roomId: string, status: AgentInfo['status'], kind: AgentInfo['kind'] = 'main') => ({ roomId, status, kind }) as AgentInfo;

describe('projectRoot', () => {
  it('tira o trecho do worktree (Windows e Unix)', () => {
    expect(projectRoot('D:\\JM\\.claude\\worktrees\\pix-032500')).toBe('D:\\JM');
    expect(projectRoot('/home/eu/app/.claude/worktrees/x')).toBe('/home/eu/app');
    expect(projectRoot('/home/eu/app')).toBe('/home/eu/app');
  });
});

describe('districtOf', () => {
  it('é a letra do disco, ou "/"', () => {
    expect(districtOf('d:\\JM')).toBe('D:');
    expect(districtOf('C:/Users/eu')).toBe('C:');
    expect(districtOf('/home/eu')).toBe('/');
  });
});

describe('groupProjects', () => {
  it('junta os worktrees no prédio do projeto e conta só as sessões principais', () => {
    const groups = groupProjects({
      rooms: [room('b', 'D:\\JM\\.claude\\worktrees\\x', 1), room('a', 'D:\\JM', 0), room('c', 'C:\\BF\\pmo', 2), room('d', 'd:\\jm\\.claude\\worktrees\\y', 3)],
      agents: [agent('a', 'working'), agent('b', 'waiting'), agent('b', 'working', 'sub'), agent('c', 'idle')],
    });
    expect(groups.map((g) => [g.name, g.district, g.roomIds, g.sessions])).toEqual([
      ['JM', 'D:', ['a', 'b', 'd'], ['working', 'waiting']],
      ['pmo', 'C:', ['c'], ['idle']],
    ]);
  });
});
