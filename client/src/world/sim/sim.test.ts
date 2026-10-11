// Integração da simulação sem DOM: snapshots -> personagens andando, sentando, apagando a luz e indo embora.
import { describe, expect, it } from 'vitest';
import type { AppearanceParts } from '../../../../shared/appearance';
import type { AgentInfo, OfficeSnapshot, RoomInfo, ShellJob } from '../../../../shared/types';
import type { Appearance, ArtModule, RoomTheme } from '../../art/api';
import { DEFAULT_WORLD_OPTIONS } from '../api';
import { CORRIDOR_ID } from '../layout/corridor';
import { PRINCIPAL, standingColumns } from '../layout/geometry';
import type { Character } from './character';
import { cafeSeatAfter, SHELL_DONE_TOOL, Sim } from './sim';

const theme: RoomTheme = {
  carpet: '#4f6d8f',
  carpet2: '#486685',
  wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' },
  accent: '#3f7fd8',
  deskVariant: 'wood',
  chairVariant: 'black',
};

const appearance: Appearance = {
  skin: '#f0c8a0',
  hair: '#3a2a20',
  hairStyle: 'short',
  eyes: '#222',
  top: '#3f7fd8',
  topAccent: '#fff',
  topStyle: 'tshirt',
  bottom: '#333',
  shoes: '#111',
  accessory: 'none',
  accessoryColor: '#000',
  lanyard: null,
  look: 'm',
};

const art = {
  appearanceFromSeed: () => appearance,
  roomTheme: () => theme,
} as unknown as ArtModule;

const T0 = 1_700_000_000_000;

function room(id: string, slot: number): RoomInfo {
  return { id, name: id.replace('/', ''), path: id, slot, seed: slot * 99 + 7, createdAt: T0 };
}

function agent(id: string, roomId: string, status: AgentInfo['status'], extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    kind: 'main',
    roomId,
    name: id,
    look: 'f',
    role: 'Agente principal',
    sessionId: `s-${id}`,
    account: '.claude',
    status,
    recent: [],
    tasks: [],
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: id.length * 1234567,
    ...extra,
  };
}

function snap(rooms: RoomInfo[], agents: AgentInfo[], rev = 1): OfficeSnapshot {
  return {
    rev,
    serverTime: T0,
    rooms,
    agents,
    accounts: [{ id: '.claude', short: 'C', name: 'Conta C', color: '#f08a3c', configDir: '~/.claude', sessions: 1, usageStatus: 'ok' }],
    meta: { demo: true, sources: [], startedAt: T0, version: 't' },
  };
}

/** Avança a simulação em passos de 1/30 s. */
function run(sim: Sim, clock: { now: number }, seconds: number, until?: () => boolean): void {
  const steps = Math.round(seconds * 30);
  for (let i = 0; i < steps; i++) {
    clock.now += 1000 / 30;
    sim.update(1 / 30, clock.now);
    if (until?.()) return;
  }
}

function newSim(): Sim {
  return new Sim(art, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
}

/**
 * Nove salas com um agente trabalhando em cada: o sim dá a cada sala a menor vaga livre (o slot do servidor é só a
 * ordem de chegada), então as oito primeiras ficam no principal e a nona (/i) abre o anexo 1 com a passarela.
 * Os agentes de /a e /i chamam-se 'ana' e 'iza'.
 */
function nineRooms(): [RoomInfo[], AgentInfo[]] {
  const ids = ['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h', '/i'];
  const name = (id: string) => (id === '/a' ? 'ana' : id === '/i' ? 'iza' : `${id}-1`);
  return [ids.map((id, n) => room(id, n)), ids.map((id) => agent(name(id), id, 'working'))];
}

describe('simulação do escritório', () => {
  it('carga inicial: quem trabalha já está sentado digitando, sala acesa', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('bia', '/a', 'waiting', { waitingFor: 'aprovar' })]), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    const bia = sim.chars.get('bia')!;
    expect(ana.atSpot).toBe(ana.homeSpot);
    expect(ana.pose).toBe('type');
    expect(bia.pose).toBe('raise_hand');
    expect(bia.mode).toBe('wait');
    const r = sim.rooms.get('/a')!;
    expect(r.phase).toBe('ready');
    expect(r.lightOn).toBe(true);
  });

  it('chegada: sala nova é construída apagada, o primeiro acende a luz e senta', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    run(sim, clock, 0.2);
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    expect(b.phase).toBe('building');
    expect(b.lightOn).toBe(false);
    const caio = sim.chars.get('caio')!;
    expect(caio.step?.t ?? caio.queue[0]?.t).toBe('elevOut');
    run(sim, clock, 60, () => !!caio.homeSpot && caio.atSpot === caio.homeSpot && !caio.step && !caio.queue.length);
    expect(b.phase).toBe('ready');
    expect(b.lightOn).toBe(true);
    expect(caio.atSpot).toBe(caio.homeSpot);
    run(sim, clock, 0.1);
    expect(caio.pose).toBe('type');
  });

  it('chegada: mudar de status a caminho do interruptor não deixa a sala no escuro', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    run(sim, clock, 0.2);
    const rooms = [room('/a', 0), room('/b', 1)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    const caio = sim.chars.get('caio')!;
    run(sim, clock, 3);
    expect(b.lightOn).toBe(false);
    expect(b.switchClaim).toBe('caio');
    // ainda andando até o interruptor: o status muda duas vezes (o plano é refeito)
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'waiting', { waitingFor: 'aprovar' })], 3), clock.now);
    run(sim, clock, 0.5);
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 4), clock.now);
    run(sim, clock, 60, () => b.lightOn && caio.atSpot === caio.homeSpot && !caio.step && !caio.queue.length);
    expect(b.lightOn).toBe(true);
    expect(caio.atSpot).toBe(caio.homeSpot);
  });

  it('saída: quem acabou de acender a luz e já precisa ir embora apaga de novo ao sair', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    run(sim, clock, 0.2);
    const rooms = [room('/a', 0), room('/b', 1)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    const caio = sim.chars.get('caio')!;
    run(sim, clock, 60, () => caio.step?.t === 'switch');
    expect(caio.step?.t).toBe('switch');
    // a sessão termina bem no meio do clique do interruptor
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'offline')], 3), clock.now);
    run(sim, clock, 20, () => caio.leaving && !b.lightOn);
    expect(b.lightOn).toBe(false);
    // ainda a caminho do elevador quando a luz apaga
    expect(sim.chars.has('caio')).toBe(true);
    run(sim, clock, 90, () => !sim.rooms.has('/b'));
    expect(sim.rooms.has('/b')).toBe(false);
  });

  it('saída: o último apaga a luz, vai ao elevador, some e a sala é desmontada', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0), room('/b', 1)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('caio', '/b', 'working'), agent('davi', '/b', 'idle')]), clock.now);
    run(sim, clock, 0.5);
    // sessões da sala /b encerram: caio fica offline, davi some do snapshot
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'offline')], 2), clock.now);
    const b = sim.rooms.get('/b')!;
    expect(b.listed).toBe(false);
    expect(sim.chars.get('caio')!.mode).toBe('leave');
    // davi só sai depois do debounce de 3 s
    run(sim, clock, 1);
    expect(sim.chars.get('davi')!.leaving).toBe(false);
    run(sim, clock, 3);
    expect(sim.chars.get('davi')!.leaving).toBe(true);
    // exatamente um deles se encarrega do interruptor
    expect(b.switchClaim).not.toBeNull();
    run(sim, clock, 90, () => !b.lightOn);
    expect(b.lightOn).toBe(false);
    run(sim, clock, 90, () => !sim.chars.has('caio') && !sim.chars.has('davi'));
    expect(sim.chars.has('caio')).toBe(false);
    expect(sim.chars.has('davi')).toBe(false);
    run(sim, clock, 10, () => !sim.rooms.has('/b'));
    expect(sim.rooms.has('/b')).toBe(false);
    // a outra sala continua acesa
    expect(sim.rooms.get('/a')!.lightOn).toBe(true);
  });

  it('subagente entrega o resultado ao pai e vai embora', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const main = agent('ana', '/a', 'working');
    sim.applySnapshot(snap(rooms, [main]), clock.now);
    run(sim, clock, 0.2);
    const sub = agent('ana:s1', '/a', 'working', { kind: 'sub', parentId: 'ana', name: 'Beto', title: 'Mapear arquivos' });
    sim.applySnapshot(snap(rooms, [main, sub], 2), clock.now);
    const beto = sim.chars.get('ana:s1')!;
    run(sim, clock, 60, () => beto.atSpot !== null && beto.atSpot === beto.homeSpot && !beto.step && !beto.queue.length);
    expect(beto.homeSpot).not.toBeNull();
    sim.applySnapshot(snap(rooms, [main, { ...sub, status: 'done' }], 3), clock.now);
    expect(beto.mode).toBe('deliver');
    let delivered = false;
    run(sim, clock, 40, () => {
      if (beto.bubbleText?.startsWith('Entregando')) delivered = true;
      return delivered;
    });
    expect(delivered).toBe(true);
    const ana = sim.chars.get('ana')!;
    expect(['check', 'heart']).toContain(ana.icon);
    run(sim, clock, 60, () => !sim.chars.has('ana:s1'));
    expect(sim.chars.has('ana:s1')).toBe(false);
  });

  it('ocioso passeia e volta para a mesa', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'idle', { statusSince: T0 })]), clock.now);
    const ana = sim.chars.get('ana')!;
    ana.nextOutingAt = 1;
    let left = false;
    run(sim, clock, 60, () => {
      if (ana.atSpot !== ana.homeSpot) left = true;
      return left && ana.atSpot === ana.homeSpot;
    });
    expect(left).toBe(true);
    // volta ao trabalho imediatamente quando o status muda
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')], 2), clock.now);
    run(sim, clock, 60, () => !!ana.homeSpot && ana.atSpot === ana.homeSpot && !ana.step && !ana.queue.length);
    run(sim, clock, 0.1);
    expect(ana.pose).toBe('type');
  });

  it('quem cochila na mesa (ocioso há muito tempo) acorda ao levantar: o "zzz" não vai junto', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'idle', { statusSince: T0 - 3_600_000 })]), clock.now);
    const ana = sim.chars.get('ana')!;
    run(sim, clock, 60, () => ana.atSpot === ana.homeSpot && ana.icon === 'zzz');
    expect(ana.pose).toBe('sleep');
    expect(ana.icon).toBe('zzz');
    // Uma roda (ou qualquer plano) tira do lugar sem mudar o modo: segue "ocioso há muito tempo".
    ana.queue.push({ t: 'exit' }, { t: 'act', pose: 'stand', ms: 4000 });
    run(sim, clock, 1.5);
    expect(ana.pose).toBe('stand');
    expect(ana.icon).toBeNull();
    // A verificação de 1 em 1 s não devolve o "zzz" a quem está de pé.
    run(sim, clock, 1.5);
    expect(ana.icon).toBeNull();
  });

  it('avanço rápido (aba oculta) teletransporta para os destinos', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working')]), clock.now);
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], [agent('ana', '/a', 'working'), agent('caio', '/b', 'working')], 2), clock.now);
    clock.now += 20_000;
    sim.fastForward(clock.now);
    const caio = sim.chars.get('caio')!;
    expect(caio.atSpot).toBe(caio.homeSpot);
    expect(caio.alpha).toBe(1);
    expect(sim.rooms.get('/b')!.phase).toBe('ready');
    expect(sim.rooms.get('/b')!.lightOn).toBe(true);
  });

  it('snapshots com falhas não quebram o mundo', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/inexistente', 'working'), agent('bia', '/a', 'working', { parentId: 'ninguem', kind: 'sub' })]), clock.now);
    run(sim, clock, 5);
    expect(sim.chars.size).toBe(2);
    // sala some e volta durante a desmontagem: reconstrói
    sim.applySnapshot(snap([], [], 2), clock.now);
    run(sim, clock, 20);
    sim.applySnapshot(snap([room('/a', 0)], [agent('caio', '/a', 'working')], 3), clock.now);
    run(sim, clock, 5);
    const a = sim.rooms.get('/a');
    expect(a).toBeDefined();
    expect(['building', 'ready']).toContain(a!.phase);
  });

  it('carga inicial: ninguém começa parado em banco de corredor/banheiro e nenhuma sala fica vazia', () => {
    for (const since of [T0, T0 - 5 * 60_000]) {
      const sim = newSim();
      const clock = { now: T0 };
      const agents: AgentInfo[] = [];
      for (let i = 0; i < 12; i++) agents.push(agent(`ocioso-${String.fromCharCode(97 + i)}${'x'.repeat(i)}`, i % 2 ? '/b' : '/a', 'idle', { statusSince: since }));
      sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], agents), clock.now);
      for (const ch of sim.chars.values()) {
        const at = ch.atSpot ? sim.spots.get(ch.atSpot) : undefined;
        expect(at, `${ch.id} sem lugar`).toBeDefined();
        expect(at!.kind).not.toBe('bench');
        // quem acabou de ficar ocioso começa na própria mesa
        if (since === T0) expect(ch.atSpot).toBe(ch.homeSpot);
      }
      for (const id of ['/a', '/b']) expect([...sim.chars.values()].some((c) => c.roomId === id && c.atSpot === c.homeSpot)).toBe(true);
      // e ninguém sai passear nos primeiros segundos
      run(sim, clock, 3);
      if (since === T0) for (const ch of sim.chars.values()) expect(ch.atSpot, ch.id).toBe(ch.homeSpot);
    }
  });

  it('sala lotada: quem sobra trabalha em pé DENTRO da sala (não fica rodando na recepção)', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const agents: AgentInfo[] = [];
    for (let i = 0; i < 26; i++) agents.push(agent(`ag-${i}-${'y'.repeat(i)}`, '/a', 'working'));
    sim.applySnapshot(snap([room('/a', 0)], agents), clock.now);
    run(sim, clock, 25);
    const r = sim.rooms.get('/a')!.layout.rect;
    const inside = (x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
    const homeless = [...sim.chars.values()].filter((c) => !c.homeSpot);
    expect(homeless.length).toBeGreaterThan(0);
    const tiles = new Set<string>();
    for (const c of homeless) {
      expect(c.standTile, c.id).not.toBeNull();
      expect(inside(c.standTile!.x, c.standTile!.y)).toBe(true);
      expect(inside(c.tx, c.ty), `${c.id} fora da sala em ${c.tx},${c.ty}`).toBe(true);
      const key = `${c.standTile!.x},${c.standTile!.y}`;
      expect(tiles.has(key), `dois no mesmo tile ${key}`).toBe(false);
      tiles.add(key);
    }
    // parados (não andando em círculos) e trabalhando com o notebook
    const before = homeless.map((c) => `${c.tx},${c.ty}`);
    run(sim, clock, 15);
    expect(homeless.map((c) => `${c.tx},${c.ty}`)).toEqual(before);
    expect(homeless.every((c) => c.pose === 'read' && c.held === 'laptop')).toBe(true);
    // vagou um lugar: alguém de pé senta
    const seated = [...sim.chars.values()].find((c) => c.homeSpot && c.atSpot === c.homeSpot)!;
    sim.applySnapshot(snap([room('/a', 0)], agents.filter((a) => a.id !== seated.id), 2), clock.now);
    run(sim, clock, 40, () => homeless.some((c) => !!c.homeSpot && c.atSpot === c.homeSpot));
    expect(homeless.some((c) => !!c.homeSpot && c.atSpot === c.homeSpot)).toBe(true);
  });

  it('delegar: conversa virado para a porta com 💬 (a mão levantada é só para "precisa de você")', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const main = agent('ana', '/a', 'working', { activity: { id: 'a1', kind: 'edit', icon: '✏️', text: 'Editando', at: T0 } });
    sim.applySnapshot(snap([room('/a', 0)], [main]), clock.now);
    run(sim, clock, 0.5);
    sim.applySnapshot(snap([room('/a', 0)], [{ ...main, activity: { id: 'a2', kind: 'delegate', icon: '👥', text: 'Delegando', at: T0 } }], 2), clock.now);
    const ana = sim.chars.get('ana')!;
    expect(ana.icon).toBe('chat');
    const poses = new Set<string>();
    run(sim, clock, 3, () => {
      poses.add(ana.pose);
      return false;
    });
    expect(poses.has('talk')).toBe(true);
    expect(poses.has('raise_hand')).toBe(false);
  });

  it('cada personagem tem ritmo e faixa próprios (quem sai junto não anda sobreposto)', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const agents = ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff'].map((id) => agent(id, '/a', 'working', { seed: id.charCodeAt(0) * 7919 + id.length }));
    sim.applySnapshot(snap([room('/a', 0)], agents), clock.now);
    const chars = [...sim.chars.values()];
    for (const c of chars) {
      expect(c.speedK).toBeGreaterThanOrEqual(0.92);
      expect(c.speedK).toBeLessThanOrEqual(1.08);
      expect(Math.abs(c.lane)).toBeLessThanOrEqual(4);
    }
    expect(new Set(chars.map((c) => c.speedK.toFixed(3))).size).toBeGreaterThan(1);
    expect(new Set(chars.map((c) => c.lane)).size).toBeGreaterThan(1);
  });

  it('personagem editado: seed ou peças novas no snapshot trocam a aparência de quem já está no escritório', () => {
    let calls = 0;
    const spyArt = {
      appearanceFromSeed: (seed: number, opts: { parts?: AppearanceParts } = {}) => {
        calls++;
        return { ...appearance, skin: `#${seed.toString(16).padStart(6, '0')}`, ...opts.parts };
      },
      roomTheme: () => theme,
    } as unknown as ArtModule;
    const sim = new Sim(spyArt, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working', { seed: 1 })]), clock.now);
    run(sim, clock, 0.2);
    expect(sim.chars.get('ana')!.appearance.skin).toBe('#000001');

    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working', { seed: 2, parts: { hairStyle: 'bob' } })], 2), clock.now);
    const ana = sim.chars.get('ana')!;
    expect(ana.appearance.skin).toBe('#000002');
    expect(ana.appearance.hairStyle).toBe('bob');

    const before = calls;
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'idle', { seed: 2, parts: { hairStyle: 'bob' } })], 3), clock.now);
    expect(calls).toBe(before);
  });

  it('personagem editado: só as peças ou só o look mudando (mesma seed) também trocam a aparência', () => {
    let calls = 0;
    const spyArt = {
      appearanceFromSeed: (seed: number, opts: { look?: 'm' | 'f'; parts?: AppearanceParts } = {}) => {
        calls++;
        return { ...appearance, skin: `#${seed.toString(16).padStart(6, '0')}`, look: opts.look ?? appearance.look, ...opts.parts };
      },
      roomTheme: () => theme,
    } as unknown as ArtModule;
    const sim = new Sim(spyArt, () => ({ ...DEFAULT_WORLD_OPTIONS, liveliness: 'calm' }));
    const clock = { now: T0 };
    let rev = 1;
    const apply = (extra: Partial<AgentInfo>): Character => {
      sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working', { seed: 1, look: 'f', ...extra })], rev++), clock.now);
      return sim.chars.get('ana')!;
    };

    expect(apply({}).appearance.hairStyle).toBe('short');

    // mesma seed, peças novas
    expect(apply({ parts: { hairStyle: 'buzz' } }).appearance.hairStyle).toBe('buzz');

    // mesma seed, peças diferentes
    expect(apply({ parts: { hairStyle: 'bob' } }).appearance.hairStyle).toBe('bob');

    // mesma seed, peças removidas: volta ao da fixture
    expect(apply({ parts: undefined }).appearance.hairStyle).toBe('short');

    // mesma seed e mesmas peças, só o look diferente: gera de novo
    apply({ parts: { hairStyle: 'bob' } });
    const before = calls;
    expect(apply({ look: 'm', parts: { hairStyle: 'bob' } }).appearance.look).toBe('m');
    expect(calls).toBe(before + 1);
  });
});

describe('salas sem buracos', () => {
  const inside = (r: { layout: { rect: { x: number; y: number; w: number; h: number } } }, c: { tx: number; ty: number }) =>
    c.tx >= r.layout.rect.x && c.tx < r.layout.rect.x + r.layout.rect.w && c.ty >= r.layout.rect.y && c.ty < r.layout.rect.y + r.layout.rect.h;

  it('carga inicial: as salas ocupam as vagas 0, 1, 2... na ordem do servidor, mesmo com buracos nos slots dele', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/c', 8), room('/a', 0), room('/b', 3)], [agent('ana', '/a', 'working'), agent('bia', '/b', 'working'), agent('caio', '/c', 'working')]), clock.now);
    expect(['/a', '/b', '/c'].map((id) => sim.rooms.get(id)!.slot)).toEqual([0, 1, 2]);
    // vagas 0 (4N), 1 (1N) e 2 (4S): colunas 1–4
    expect(sim.building.blocks[0].columns).toEqual({ lo: 1, hi: 4 });
  });

  it('terminal fechou: a sala mais distante se muda para a vaga, o pessoal vai andando e a vaga antiga vira pátio', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0), room('/b', 1), room('/c', 2)];
    const agents = [agent('ana', '/a', 'working'), agent('bia', '/b', 'working'), agent('caio', '/c', 'working'), agent('davi', '/c', 'idle')];
    sim.applySnapshot(snap(rooms, agents), clock.now);
    run(sim, clock, 0.5);
    const c = sim.rooms.get('/c')!;
    const caio = sim.chars.get('caio')!;
    const homeBefore = caio.homeSpot;
    expect(c.slot).toBe(2);
    expect(sim.building.blocks[0].columns).toEqual({ lo: 1, hi: 4 });

    // a sessão da sala /b fecha: bia vai embora e a sala é desmontada
    sim.applySnapshot(snap([room('/a', 0), room('/c', 2)], [agents[0], agent('bia', '/b', 'offline'), agents[2], agents[3]], 2), clock.now);
    run(sim, clock, 200, () => !sim.rooms.has('/b'));
    expect(sim.rooms.has('/b')).toBe(false);
    expect(c.slot).toBe(2);

    // a vaga espera um pouco e então a sala /c se muda para ela (reconstruída, apagada)
    run(sim, clock, 3, () => c.slot === 1);
    expect(c.slot).toBe(1);
    expect(c.phase).toBe('building');
    const ghost = [...sim.rooms.values()].find((r) => r.ghost);
    expect(ghost?.slot).toBe(2);
    expect(ghost?.listed).toBe(false);
    // cada um continua com a sua mesa (agora na sala nova) e vai andando até ela, sem teletransporte
    expect(caio.homeSpot).toBe(homeBefore);
    let maxStep = 0;
    let px = caio.x;
    let py = caio.y;
    run(sim, clock, 60, () => {
      maxStep = Math.max(maxStep, Math.hypot(caio.x - px, caio.y - py));
      px = caio.x;
      py = caio.y;
      return !sim.rooms.has(ghost!.id) && caio.atSpot === caio.homeSpot && !caio.step && !caio.queue.length;
    });
    expect(maxStep).toBeLessThan(12);
    expect(caio.atSpot).toBe(caio.homeSpot);
    expect(inside(c, caio)).toBe(true);
    expect(c.phase).toBe('ready');
    expect(c.lightOn).toBe(true);
    // o endereço antigo esvaziou, apagou e foi desmontado; sobram as vagas 0 (coluna 4) e 1 (coluna 1)
    expect(sim.rooms.has(ghost!.id)).toBe(false);
    run(sim, clock, 10, () => sim.building.rooms.length === 2);
    expect(sim.building.rooms.map((r) => r.id).sort()).toEqual(['/a', '/c']);
    expect(sim.building.blocks[0].columns).toEqual({ lo: 1, hi: 4 });
    expect(sim.building.rooms.some((r) => r.rect.x === 64 && r.rect.y === 17)).toBe(false); // 4S (vaga 2) ficou vazia
    // davi (ocioso, talvez passeando) também tem o lugar dele na sala nova
    expect(c.layout.spots.some((p) => p.id === sim.chars.get('davi')!.homeSpot)).toBe(true);
  });

  it('quem está indo embora não se muda: a vaga fica até a sala dela sumir', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0), room('/b', 1), room('/c', 2)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working'), agent('bia', '/b', 'working'), agent('caio', '/c', 'working')]), clock.now);
    run(sim, clock, 0.5);
    const c = sim.rooms.get('/c')!;
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'working'), agent('bia', '/b', 'offline'), agent('caio', '/c', 'offline')], 2), clock.now);
    let moved = false;
    run(sim, clock, 240, () => {
      if (c.slot !== 2 || [...sim.rooms.values()].some((r) => r.ghost)) moved = true;
      return !sim.rooms.has('/b') && !sim.rooms.has('/c');
    });
    expect(moved).toBe(false);
    expect(sim.rooms.has('/c')).toBe(false);
    // só a vaga 0 (coluna 4): a coluna 1 sai de pé assim que ninguém mais está nela
    run(sim, clock, 5, () => sim.building.blocks[0].columns.lo === 2);
    expect(sim.building.blocks[0].columns).toEqual({ lo: 2, hi: 4 });
  });

  it('abre e fecha ao acaso (inclusive no meio de uma mudança): ninguém se teletransporta e no fim não sobra buraco', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const sim = newSim();
    const clock = { now: T0 };
    const ids = ['/a', '/b', '/c', '/d', '/e', '/f', '/g'];
    const open = new Map<string, number>();
    ids.slice(0, 5).forEach((id, i) => open.set(id, i));
    let nextSlot = 5;
    let rev = 1;
    const agentsOf = (id: string, status: AgentInfo['status']) => [agent(`${id}-1`, id, status), agent(`${id}-2`, id, status === 'offline' ? 'offline' : 'idle')];
    const closed = new Set<string>();
    const push = () => {
      const rs = [...open].map(([id, slot]) => room(id, slot));
      const as = [...open.keys()].flatMap((id) => agentsOf(id, 'working')).concat([...closed].flatMap((id) => agentsOf(id, 'offline')));
      sim.applySnapshot(snap(rs, as, ++rev), clock.now);
    };
    push();
    let maxStep = 0;
    // por personagem (quem volta com o mesmo id é outro personagem, que sai do elevador)
    const last = new WeakMap<object, { x: number; y: number }>();
    const track = () => {
      for (const ch of sim.chars.values()) {
        const p = last.get(ch);
        if (p && ch.visible && !ch.inside && clock.now >= ch.hiddenUntil) maxStep = Math.max(maxStep, Math.hypot(ch.x - p.x, ch.y - p.y));
        last.set(ch, { x: ch.x, y: ch.y });
      }
      return false;
    };
    for (let round = 0; round < 14; round++) {
      const roll = rnd();
      if (roll < 0.55 && open.size > 1) {
        const id = [...open.keys()][Math.floor(rnd() * open.size)];
        open.delete(id);
        closed.add(id);
      } else {
        const id = ids.find((x) => !open.has(x));
        if (id) {
          open.set(id, nextSlot++);
          closed.delete(id);
        }
      }
      push();
      run(sim, clock, 4 + rnd() * 40, track);
    }
    run(sim, clock, 400, () => {
      track();
      const rs = [...sim.rooms.values()];
      const compact = rs.every((r) => r.slot < rs.length);
      return compact && rs.every((r) => r.listed && r.phase === 'ready' && !r.ghost) && [...sim.chars.values()].every((c) => !c.leaving);
    });
    const slots = [...sim.rooms.values()].map((r) => r.slot).sort((a, b) => a - b);
    expect([...sim.rooms.keys()].sort()).toEqual([...open.keys()].sort());
    expect(slots).toEqual(slots.map((_, i) => i));
    expect([...sim.rooms.values()].some((r) => r.ghost)).toBe(false);
    // colunas de pé das salas abertas (quem ainda passeia numa coluna vazia a segura; o housekeeping tenta de novo a cada 1 s)
    const want = standingColumns(PRINCIPAL, slots);
    run(sim, clock, 60, () => sim.building.blocks[0].columns.lo === want.lo && sim.building.blocks[0].columns.hi === want.hi);
    expect(sim.building.blocks[0].columns).toEqual(want);
    expect(maxStep).toBeLessThan(12);
  });

  it('sala que abre depois ocupa a primeira vaga livre', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0), room('/c', 2)], [agent('ana', '/a', 'working'), agent('caio', '/c', 'working')]), clock.now);
    expect(sim.rooms.get('/c')!.slot).toBe(1);
    run(sim, clock, 0.5);
    // o servidor manda a sala nova num slot alto; no prédio ela vai para a vaga 2
    sim.applySnapshot(snap([room('/a', 0), room('/c', 2), room('/d', 7)], [agent('ana', '/a', 'working'), agent('caio', '/c', 'working'), agent('duda', '/d', 'working')], 2), clock.now);
    expect(sim.rooms.get('/d')!.slot).toBe(2);
    expect(sim.rooms.get('/d')!.phase).toBe('building');
  });

  it('trava de encolher: a coluna com alguém fica de pé depois que a sala saiu (a vaga vira pátio); quando a pessoa sai, encolhe sozinho', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], [agent('ana', '/a', 'working'), agent('bia', '/b', 'working')]), clock.now);
    run(sim, clock, 0.5);
    expect(sim.building.blocks[0].columns).toEqual({ lo: 1, hi: 4 });
    // bia está sentada na sala /b (vaga 1 = coluna 1, x 16..32)
    const bia = sim.chars.get('bia')!;
    expect(bia.tx).toBeGreaterThanOrEqual(16);
    expect(bia.tx).toBeLessThan(32);
    // a sala /b some de uma vez (sem o desmonte), com bia ainda parada na coluna 1: a coluna fica de pé e a vaga vira pátio
    sim.rooms.delete('/b');
    sim.relayout();
    expect(sim.building.rooms.map((r) => r.id)).toEqual(['/a']);
    expect(sim.building.blocks[0].columns).toEqual({ lo: 1, hi: 4 });
    expect(sim.building.rect).toEqual({ x: 16, y: 0, w: 64, h: 29 });
    expect(sim.building.areas.find((a) => a.id === CORRIDOR_ID)!.rect).toEqual({ x: 16, y: 12, w: 64, h: 5 });
    // bia vai embora: sem nenhum outro gatilho, a verificação de 1 s (shrinkPending) encolhe o prédio para as colunas 2–4
    sim.spots.releaseAll('bia');
    sim.chars.delete('bia');
    run(sim, clock, 2.5, () => sim.building.blocks[0].columns.lo === 2);
    expect(sim.building.blocks[0].columns).toEqual({ lo: 2, hi: 4 });
    expect(sim.building.rect).toEqual({ x: 32, y: 0, w: 48, h: 29 });
    expect(sim.building.areas.find((a) => a.id === CORRIDOR_ID)!.rect).toEqual({ x: 32, y: 12, w: 48, h: 5 });
  });

  it('compactação na coluna extra: a sala da vaga 16 (coluna 6, transitório 7.5 com k = 2) muda para a vaga 4 (coluna 5) e, quando o fantasma some, hi cai de 6 para 5', () => {
    const sim = newSim();
    const clock = { now: T0 };
    // o sim dá a cada sala nova a menor vaga livre (o slot do servidor é só a ordem de chegada): com k = 2 as vagas
    // 8..15 são do anexo 1, então a primeira sala da coluna extra 6 do principal (vaga 16) é a 17ª
    const ids = ['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h', '/i', '/j', '/k', '/l', '/m', '/n', '/o', '/p', '/q'];
    const rooms = ids.map((id, n) => room(id, n));
    const agents = ids.map((id) => agent(`${id}-1`, id, 'working'));
    sim.applySnapshot(snap(rooms, agents), clock.now);
    run(sim, clock, 0.5);
    // vagas 0..16: principal nas colunas 0–5 mais a coluna extra 6 (transitório 7.5) e o anexo 1 cheio
    expect(sim.building.blocks).toHaveLength(2);
    expect(sim.building.blocks[0].columns).toEqual({ lo: 0, hi: 6 });
    const q = sim.rooms.get('/q')!;
    expect(q.slot).toBe(16);
    expect(q.layout.rect).toEqual({ x: 96, y: 0, w: 16, h: 12 }); // vaga 16 = coluna 6 norte
    // a sessão da sala /e (vaga 4 = coluna 5 norte) fecha: a vaga 4 fica livre antes da última sala
    sim.applySnapshot(snap(rooms.filter((r) => r.id !== '/e'), agents.map((a) => (a.roomId === '/e' ? { ...a, status: 'offline' as const } : a)), 2), clock.now);
    run(sim, clock, 200, () => !sim.rooms.has('/e'));
    expect(sim.rooms.has('/e')).toBe(false);
    // a sala mais distante (/q) se muda para a vaga 4 (reconstruída, apagada); o endereço antigo vira fantasma
    run(sim, clock, 3, () => q.slot === 4);
    expect(q.slot).toBe(4);
    expect(q.layout.rect).toEqual({ x: 80, y: 0, w: 16, h: 12 }); // coluna 5 norte
    const ghost = [...sim.rooms.values()].find((r) => r.ghost);
    expect(ghost?.slot).toBe(16);
    // o fantasma (coluna 6) ainda está presente e quem estava lá vai andando: hi continua 6
    expect(sim.building.blocks[0].columns).toEqual({ lo: 0, hi: 6 });
    // o fantasma esvazia, apaga e é desmontado; sem ninguém na coluna 6, o prédio encolhe para as colunas 0–5
    run(sim, clock, 120, () => sim.building.blocks[0].columns.hi === 5);
    expect(sim.building.blocks[0].columns).toEqual({ lo: 0, hi: 5 });
    expect(sim.building.rect).toEqual({ x: 0, y: 0, w: 96, h: 70 }); // o anexo 1 (vagas 8..15) continua de pé
    expect([...sim.rooms.values()].some((r) => r.ghost)).toBe(false);
    expect(sim.building.rooms.some((r) => r.rect.x === 96)).toBe(false);
  });

  it('relayout(true) ignora a trava: encolhe com alguém na coluna e reposiciona quem ficou fora da grade', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0), room('/b', 1)], [agent('ana', '/a', 'working'), agent('bia', '/b', 'working')]), clock.now);
    run(sim, clock, 0.5);
    expect(sim.building.blocks[0].columns).toEqual({ lo: 1, hi: 4 });
    const bia = sim.chars.get('bia')!;
    bia.tx = 17; // canto oeste da sala da coluna 1: a 16 tiles do primeiro tile caminhável da grade nova (x 33)
    sim.rooms.delete('/b');
    sim.relayout(true);
    expect(sim.building.blocks[0].columns).toEqual({ lo: 2, hi: 4 });
    expect(sim.building.grid.x0).toBe(32);
    // sem trava, quem ficou para fora precisa cair num tile caminhável da grade nova (fallback com raio COL_W + 2)
    expect(sim.building.grid.inside(bia.tx, bia.ty)).toBe(true);
    expect(sim.building.grid.walkable(bia.tx, bia.ty)).toBe(true);
    // shrinkPending ficou desligado: o housekeeping (1 s) não muda nada
    run(sim, clock, 2.5);
    expect(sim.building.blocks[0].columns).toEqual({ lo: 2, hi: 4 });
  });

  it('compactação entre blocos: a 9ª sala (vaga 8, anexo) muda para a vaga 4 do principal e, quando o fantasma some, o anexo e a passarela somem', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const ids = ['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h', '/i'];
    const rooms = ids.map((id, n) => room(id, n));
    const agents = ids.map((id) => agent(`${id}-1`, id, 'working'));
    sim.applySnapshot(snap(rooms, agents), clock.now);
    run(sim, clock, 0.5);
    expect(sim.building.blocks.map((b) => [b.id.bx, b.id.by, b.columns.lo, b.columns.hi])).toEqual([
      [0, 0, 0, 5],
      [0, 1, 2, 3],
    ]);
    expect(sim.building.bridges.map((b) => b.id)).toEqual(['passarela:0,1']);
    expect(sim.building.rect).toEqual({ x: 0, y: 0, w: 96, h: 70 });
    const i = sim.rooms.get('/i')!;
    expect(i.slot).toBe(8);
    expect(i.layout.rect).toEqual({ x: 56, y: 41, w: 16, h: 12 }); // vaga 8 = coluna 3 norte do anexo
    // a sala /e (vaga 4 = coluna 5 norte do principal) fecha
    sim.applySnapshot(snap(rooms.filter((r) => r.id !== '/e'), agents.map((a) => (a.roomId === '/e' ? { ...a, status: 'offline' as const } : a)), 2), clock.now);
    run(sim, clock, 200, () => !sim.rooms.has('/e'));
    expect(sim.rooms.has('/e')).toBe(false);
    // /i se muda para a vaga 4; o endereço antigo (anexo) vira fantasma e segura o anexo
    run(sim, clock, 3, () => i.slot === 4);
    expect(i.slot).toBe(4);
    expect(i.layout.rect).toEqual({ x: 80, y: 0, w: 16, h: 12 });
    expect([...sim.rooms.values()].find((r) => r.ghost)?.slot).toBe(8);
    expect(sim.building.blocks).toHaveLength(2);
    // o fantasma esvazia e é desmontado; sem ninguém no anexo nem na passarela, os dois somem
    run(sim, clock, 300, () => sim.building.blocks.length === 1);
    expect(sim.building.blocks).toHaveLength(1);
    expect(sim.building.bridges).toEqual([]);
    expect(sim.building.rect).toEqual({ x: 0, y: 0, w: 96, h: 29 });
    expect([...sim.rooms.values()].some((r) => r.ghost)).toBe(false);
  });

  it('trava por bloco: o anexo fica de pé (com a coluna da pessoa e o miolo) depois que a sala saiu; quando ela sai, anexo e passarela somem', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap(...nineRooms()), clock.now);
    run(sim, clock, 0.5);
    const iza = sim.chars.get('iza')!;
    expect(iza.ty).toBeGreaterThanOrEqual(41); // sentada na sala /i, no anexo
    sim.rooms.delete('/i');
    sim.relayout();
    expect(sim.building.rooms.map((r) => r.id)).toEqual(['/a', '/b', '/c', '/d', '/e', '/f', '/g', '/h']);
    expect(sim.building.blocks.map((b) => [b.id.bx, b.id.by, b.columns.lo, b.columns.hi])).toEqual([
      [0, 0, 0, 5],
      [0, 1, 2, 3],
    ]);
    expect(sim.building.bridges).toHaveLength(1);
    // iza vai embora: o housekeeping (shrinkPending) derruba o anexo e a passarela sozinho
    sim.spots.releaseAll('iza');
    sim.chars.delete('iza');
    run(sim, clock, 2.5, () => sim.building.blocks.length === 1);
    expect(sim.building.blocks).toHaveLength(1);
    expect(sim.building.bridges).toEqual([]);
    expect(sim.building.rect).toEqual({ x: 0, y: 0, w: 96, h: 29 });
  });

  it('Review Focus 1 — trava por passarela: alguém parado na passarela segura o anexo (só o miolo) e a passarela; quando sai, somem', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap(...nineRooms()), clock.now);
    run(sim, clock, 0.5);
    const iza = sim.chars.get('iza')!;
    // iza larga o lugar e fica parada no meio do primeiro trecho da passarela
    sim.spots.releaseAll('iza');
    iza.atSpot = null;
    iza.homeSpot = null;
    iza.seated = false;
    iza.tx = 56;
    iza.ty = 31;
    sim.rooms.delete('/i');
    sim.relayout();
    expect(sim.building.blocks.map((b) => [b.id.bx, b.id.by, b.columns.lo, b.columns.hi])).toEqual([
      [0, 0, 0, 5],
      [0, 1, 2, 2],
    ]);
    expect(sim.building.blocks[1].rect).toEqual({ x: 40, y: 41, w: 16, h: 29 });
    expect(sim.building.bridges.map((b) => b.id)).toEqual(['passarela:0,1']);
    expect(sim.building.grid.walkable(56, 31)).toBe(true);
    expect([iza.tx, iza.ty]).toEqual([56, 31]); // ninguém foi teletransportado
    sim.chars.delete('iza');
    run(sim, clock, 2.5, () => sim.building.blocks.length === 1);
    expect(sim.building.blocks).toHaveLength(1);
    expect(sim.building.bridges).toEqual([]);
  });

  it('Review Focus 3 — relayout(true) com alguém na rua (fora de toda região) não o leva para o outro lado: fica onde está', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap(...nineRooms()), clock.now);
    run(sim, clock, 0.5);
    const iza = sim.chars.get('iza')!;
    sim.spots.releaseAll('iza');
    iza.atSpot = null;
    iza.homeSpot = null;
    iza.seated = false;
    // iza na passarela; a passarela some com relayout(true) depois que a sala saiu
    iza.tx = 56;
    iza.ty = 31;
    sim.rooms.delete('/i');
    sim.relayout(true);
    expect(sim.building.blocks).toHaveLength(1);
    // sem região própria, o fallback é o de sempre (tile caminhável mais próximo, raio COL_W + 2): a porta sul do lounge, logo acima
    expect(sim.building.grid.walkable(iza.tx, iza.ty)).toBe(true);
    expect(iza.ty).toBeLessThanOrEqual(28);
  });

  it('serviceSpot: café, água, cabine e pia do mesmo bloco primeiro (quem está no anexo usa o saguão e o WC do anexo; quem está no principal, a copa e os banheiros)', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap(...nineRooms()), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    const iza = sim.chars.get('iza')!;
    expect(iza.ty).toBeGreaterThanOrEqual(41);
    // a cabine do banheirinho do saguão e as do WC são do mesmo bloco: vale a mais perto da sala de iza (a do saguão)
    expect(sim.serviceSpot('stall', iza)!.areaId.startsWith('anexo:0,1:')).toBe(true);
    expect(sim.serviceSpot('sink', iza)!.areaId.startsWith('anexo:0,1:')).toBe(true);
    expect(sim.serviceSpot('coffee', iza)!.areaId).toBe('anexo:0,1:saguao');
    expect(sim.serviceSpot('water', iza)!.areaId.startsWith('anexo:0,1:')).toBe(true);
    expect(sim.serviceSpot('stall', ana)!.areaId).toBe('core:banheiros');
    expect(sim.serviceSpot('coffee', ana)!.areaId).toBe('core:copa');
    expect(sim.serviceSpot('water', ana)!.areaId.startsWith('anexo:')).toBe(false);
    // `near` manda na escolha dentro da região: a pia mais perto da cabine escolhida é a da mesma área
    const stall = sim.serviceSpot('stall', iza)!;
    const sink = sim.serviceSpot('sink', iza, { near: { tx: stall.tx, ty: stall.ty } })!;
    expect(sink.areaId).toBe(stall.areaId);
  });

  it('serviceSpot cai para outro bloco quando o seu não tem o serviço livre', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap(...nineRooms()), clock.now);
    run(sim, clock, 0.5);
    const iza = sim.chars.get('iza')!;
    // ocupa todas as cabines do anexo (WC: 3; saguão: 1) com outra pessoa
    for (const s of sim.spots.ofKind('stall')) if (s.areaId.startsWith('anexo:0,1:')) sim.spots.reserve(s.id, 'ana');
    expect(sim.serviceSpot('stall', iza)!.areaId).toBe('core:banheiros');
  });

  it('cafeSeatAfter: sentar na copa só depois do café da copa do principal', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap(...nineRooms()), clock.now);
    run(sim, clock, 0.5);
    const coffees = sim.spots.ofKind('coffee');
    expect(cafeSeatAfter(coffees.find((s) => s.areaId === 'core:copa')!)).toBe(true);
    expect(cafeSeatAfter(coffees.find((s) => s.areaId === 'anexo:0,1:saguao')!)).toBe(false);
  });
});

describe('espera de shell', () => {
  const MIN = 60_000;
  const shell = (ageMs: number, extra: Partial<ShellJob> = {}): ShellJob => ({
    id: `b-${ageMs}`,
    label: 'Rodar a suíte completa',
    startedAt: T0 - ageMs,
    background: true,
    kind: 'shell',
    ...extra,
  });
  const done = (id: string, error = false): AgentInfo['activity'] => ({ id, kind: 'run', icon: error ? '❌' : '✅', text: 'Shell concluído', tool: SHELL_DONE_TOOL, error, at: T0 });

  it('status shell: fica na mesa com o balde de pipoca e não sai para passear', () => {
    const sim = newSim();
    const clock = { now: T0 };
    sim.applySnapshot(snap([room('/a', 0)], [agent('ana', '/a', 'shell', { shells: [shell(20_000)] })]), clock.now);
    const ana = sim.chars.get('ana')!;
    expect(ana.mode).toBe('shell');
    expect(ana.shellCount).toBe(1);
    expect(ana.shellLabel).toBe('Rodar a suíte completa');
    ana.nextOutingAt = 1;
    run(sim, clock, 60, () => ana.atSpot !== ana.homeSpot);
    expect(ana.atSpot).toBe(ana.homeSpot);
    expect(ana.pose).toBe('wait');
    expect(ana.held).toBe('popcorn');
    expect(ana.shellStage).toBe('popcorn');
  });

  it('a escalada segue a idade do shell mais antigo: giros, teia/bocejo e cochilo', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'shell', { shells: [shell(4 * MIN), shell(30_000)] })]), clock.now);
    const ana = sim.chars.get('ana')!;
    expect(ana.shellCount).toBe(2);
    run(sim, clock, 0.2);
    expect(ana.shellStage).toBe('restless');
    expect(ana.held).toBe('none');
    const home = sim.spots.get(ana.homeSpot)!;
    const dirs = new Set<string>();
    run(sim, clock, 30, () => {
      dirs.add(ana.dir);
      return false;
    });
    // pelo menos um giro completo na cadeira
    expect(dirs.size).toBe(4);
    expect(ana.dir).toBe(home.dir);
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'shell', { shells: [shell(12 * MIN + (clock.now - T0))] })], 2), clock.now);
    run(sim, clock, 0.1);
    expect(ana.shellStage).toBe('cobweb');
    let yawned = false;
    run(sim, clock, 40, () => {
      if (ana.chatEmoji === '🥱' && ana.pose === 'sleep') yawned = true;
      return yawned;
    });
    expect(yawned).toBe(true);
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'shell', { shells: [shell(26 * MIN + (clock.now - T0))] })], 3), clock.now);
    run(sim, clock, 0.1);
    expect(ana.shellStage).toBe('nap');
    expect(ana.pose).toBe('sleep');
  });

  it('passeando quando o shell começa: volta para a mesa (sai da cabine normalmente)', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'idle')]), clock.now);
    const ana = sim.chars.get('ana')!;
    ana.nextOutingAt = 1;
    run(sim, clock, 60, () => ana.atSpot !== ana.homeSpot && !!ana.step && ana.step.t !== 'exit');
    expect(ana.atSpot === ana.homeSpot).toBe(false);
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'shell', { shells: [shell(1000)] })], 2), clock.now);
    expect(ana.mode).toBe('shell');
    let ran = false;
    run(sim, clock, 60, () => {
      if (ana.pose === 'run') ran = true;
      return ana.atSpot === ana.homeSpot && !ana.step && !ana.queue.length;
    });
    expect(ana.atSpot).toBe(ana.homeSpot);
    expect(ran).toBe(false);
    run(sim, clock, 0.1);
    expect(ana.pose).toBe('wait');
  });

  it('comando longo em primeiro plano: digitando nos primeiros 10 s, depois a mesma espera', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const fg = shell(0, { id: 'toolu_1', background: false });
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working', { shells: [fg] })]), clock.now);
    const ana = sim.chars.get('ana')!;
    run(sim, clock, 5);
    expect(ana.mode).toBe('work');
    expect(ana.pose).toBe('type');
    run(sim, clock, 7);
    expect(ana.mode).toBe('shell');
    expect(ana.pose).toBe('wait');
    expect(ana.atSpot).toBe(ana.homeSpot);
    // o comando terminou (tool_result): volta a digitar
    sim.applySnapshot(snap(rooms, [agent('ana', '/a', 'working', { shells: [] })], 2), clock.now);
    run(sim, clock, 0.2);
    expect(ana.mode).toBe('work');
    expect(ana.pose).toBe('type');
  });

  it('shell concluído: levanta, comemora com ⭐ e confete e volta a trabalhar', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const base = agent('ana', '/a', 'shell', { shells: [shell(2 * MIN)], activity: { id: 'a0', kind: 'run', icon: '💻', text: 'Rodando', at: T0 } });
    sim.applySnapshot(snap(rooms, [base]), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    // a notificação chega e o agente já volta a trabalhar no mesmo snapshot
    sim.applySnapshot(snap(rooms, [{ ...base, status: 'working', shells: [], activity: done('a1') }], 2), clock.now);
    expect(ana.icon).toBe('star');
    expect(sim.effects.some((e) => e.kind === 'confetti' && e.charId === 'ana')).toBe(true);
    const poses = new Set<string>();
    run(sim, clock, 3, () => {
      poses.add(ana.pose);
      return false;
    });
    expect(poses.has('stretch')).toBe(true);
    run(sim, clock, 5, () => ana.atSpot === ana.homeSpot && ana.pose === 'type');
    expect(ana.atSpot).toBe(ana.homeSpot);
    expect(ana.mode).toBe('work');
    expect(ana.pose).toBe('type');
  });

  it('fim de shell antigo não comemora na carga; um novo atrás de outra atividade comemora', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const old = done('old')!;
    const base = agent('ana', '/a', 'working', { recent: [old], activity: { id: 'a0', kind: 'edit', icon: '✏️', text: 'Editando', at: T0 } });
    sim.applySnapshot(snap(rooms, [base]), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    expect(ana.icon).toBeNull();
    expect(sim.effects.length).toBe(0);
    const fresh = { ...done('new')!, at: T0 + 400 };
    const later = { id: 'a2', kind: 'read' as const, icon: '📖', text: 'Lendo a saída', at: T0 + 450 };
    sim.applySnapshot(snap(rooms, [{ ...base, recent: [old, fresh, later], activity: later }], 2), clock.now);
    expect(ana.icon).toBe('star');
    expect(sim.effects.length).toBe(1);
    // o mesmo snapshot de novo não comemora outra vez
    sim.applySnapshot(snap(rooms, [{ ...base, recent: [old, fresh, later], activity: later }], 3), clock.now);
    expect(sim.effects.length).toBe(1);
  });

  it('shell falhou: nuvenzinha de chuva, cabeça baixa por ~4 s, sem confete', () => {
    const sim = newSim();
    const clock = { now: T0 };
    const rooms = [room('/a', 0)];
    const base = agent('ana', '/a', 'shell', { shells: [shell(2 * MIN), shell(MIN)], activity: { id: 'a0', kind: 'run', icon: '💻', text: 'Rodando', at: T0 } });
    sim.applySnapshot(snap(rooms, [base]), clock.now);
    run(sim, clock, 0.5);
    const ana = sim.chars.get('ana')!;
    sim.effects.length = 0;
    // um dos dois falhou; o outro continua rodando
    sim.applySnapshot(snap(rooms, [{ ...base, shells: [shell(MIN)], activity: done('a1', true) }], 2), clock.now);
    expect(ana.icon).toBe('storm');
    expect(sim.effects.length).toBe(0);
    run(sim, clock, 1);
    expect(ana.pose).toBe('sleep');
    expect(ana.atSpot).toBe(ana.homeSpot);
    run(sim, clock, 4);
    expect(ana.icon).toBeNull();
    expect(ana.mode).toBe('shell');
    expect(ana.shellCount).toBe(1);
    expect(ana.pose).toBe('wait');
  });
});
