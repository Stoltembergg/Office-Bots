// Regras puras da camada de texto do mundo (balões e enquadramento).
import { describe, expect, it } from 'vitest';
import { overviewFrame } from '../camera';
import { bridgesFor, existingBlocks } from '../layout/geometry';
import { bubbleAreaKey, rationBubbles, waitBubbleText } from './overlay';

describe('balões', () => {
  it('espera: só o motivo, sem o prefixo redundante', () => {
    expect(waitBubbleText('aprovar uma permissão')).toBe('Aprovar uma permissão');
    expect(waitBubbleText('Precisa de você: escolher uma opção')).toBe('Escolher uma opção');
    expect(waitBubbleText(undefined)).toBe('Responder no terminal');
    expect(waitBubbleText('   ')).toBe('Responder no terminal');
  });

  it('visão geral: no máximo 1 balão com texto por área e 4 na tela (mais recentes primeiro)', () => {
    const items = [
      { room: 'a', prio: 50, changedAt: 10 },
      { room: 'a', prio: 50, changedAt: 30 },
      { room: 'a', prio: 50, changedAt: 20 },
      { room: 'b', prio: 30, changedAt: 99 },
      { room: 'c', prio: 50, changedAt: 1 },
      { room: 'd', prio: 50, changedAt: 2 },
      { room: 'e', prio: 50, changedAt: 3 },
    ];
    const keep = rationBubbles(items, 1, 4);
    expect(keep.size).toBe(4);
    expect(keep.has(1)).toBe(true); // o mais recente da área "a"
    expect(keep.has(0) || keep.has(2)).toBe(false);
    expect(keep.has(3)).toBe(false); // prioridade menor perde para as outras áreas
  });
});

describe('chave de racionamento: (bloco, coluna local, faixa)', () => {
  // principal com as vagas 0 (coluna 4 norte) e 1 (coluna 1 norte): colunas de pé 1..4, rect x 16..80
  const blocks = existingBlocks([0, 1]);

  it('bloco, coluna pelo envelope e faixa pelo y local do bloco', () => {
    expect(bubbleAreaKey(70, 5, blocks)).toBe('0,0:4:n');
    expect(bubbleAreaKey(20, 20, blocks)).toBe('0,0:1:s');
    expect(bubbleAreaKey(40, 13, blocks)).toBe('0,0:2:c');
  });

  it('faixas meio-abertas: norte até y 11, corredor de 12 a 16, sul de 17 em diante', () => {
    expect(bubbleAreaKey(40, 11, blocks)).toBe('0,0:2:n');
    expect(bubbleAreaKey(40, 12, blocks)).toBe('0,0:2:c');
    expect(bubbleAreaKey(40, 16, blocks)).toBe('0,0:2:c');
    expect(bubbleAreaKey(40, 17, blocks)).toBe('0,0:2:s');
  });

  it('fora de qualquer bloco: não lança e conta a coluna a partir do primeiro bloco', () => {
    expect(() => bubbleAreaKey(-50, 5, blocks)).not.toThrow();
    expect(bubbleAreaKey(-50, 5, blocks)).toBe('0,0:-4:n');
    expect(bubbleAreaKey(200, 40, blocks)).toBe('0,0:12:s');
    // sem bloco algum: o envelope do principal
    expect(bubbleAreaKey(40, 13, [])).toBe('0,0:2:c');
  });

  it('dois personagens na mesma coluna e faixa dividem a chave; em colunas ou faixas diferentes, não', () => {
    const a = bubbleAreaKey(65, 3, blocks); // coluna 4, norte
    expect(bubbleAreaKey(78, 10, blocks)).toBe(a); // ainda coluna 4 (x 64..80), norte
    expect(bubbleAreaKey(63, 3, blocks)).not.toBe(a); // coluna 3 (copa)
    expect(bubbleAreaKey(65, 20, blocks)).not.toBe(a); // coluna 4, mas ao sul
  });
});

describe('visão geral', () => {
  const building = { x: 0, y: 0, w: 4 * 16 * 16, h: 29 * 16 };

  it('enquadra o prédio na área livre (fora dos painéis), com folga para as placas acima', () => {
    const free = overviewFrame(building, 1440, 900, { top: 0, right: 0, bottom: 0, left: 0 });
    const ui = overviewFrame(building, 1440, 900, { top: 64, right: 0, bottom: 200, left: 320 });
    expect(ui.zoom).toBeLessThan(free.zoom);
    // a altura do enquadramento (placas + prédio + meio-fio) cabe entre a barra superior e a inferior
    const h = (building.h + 3.5 * 16) * ui.zoom;
    expect(h).toBeLessThanOrEqual(900 - 64 - 200 - 30);
    // começa acima da parede norte (placas) e termina abaixo da fachada sul
    expect(ui.cy).toBeGreaterThan(building.h / 2);
    expect(ui.dy).toBeGreaterThan(0);
  });
});

describe('chave de racionamento com o anexo 1 (fase 2)', () => {
  const blocks = existingBlocks([8]);
  const bridges = bridgesFor(blocks);

  it('sobre a passarela: chave própria da passarela, não do bloco principal', () => {
    expect(bubbleAreaKey(56, 31, blocks, bridges)).toBe('passarela:0,1:bridge');
    expect(bubbleAreaKey(48, 38, blocks, bridges)).toBe('passarela:0,1:bridge');
  });

  it('dentro do anexo: coluna local do anexo e faixa (sala norte da vaga 8 = coluna 3 norte)', () => {
    expect(bubbleAreaKey(60, 45, blocks, bridges)).toBe('0,1:3:n');
  });

  it('na rua, fora de tudo: cai no primeiro bloco (principal), como antes', () => {
    expect(bubbleAreaKey(40, 35, blocks, bridges)).toBe('0,0:2:s');
  });

  it('sem passarelas (compatibilidade): um tile da passarela cai no principal', () => {
    expect(bubbleAreaKey(56, 31, blocks)).toBe('0,0:3:s');
  });
});
