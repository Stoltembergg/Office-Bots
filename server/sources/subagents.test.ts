import { describe, expect, it } from 'vitest';
import { tr } from '../../shared/i18n';
import {
  BOOT_RECENT_MS,
  concludedByIdle,
  END_TURN_QUIET_MS,
  IDLE_TIMEOUT_MS,
  parseJournal,
  parseSubagentMeta,
  PENDING_TOOL_TIMEOUT_MS,
  subagentRole,
  type IdleCheck,
} from './subagents';

const NOW = Date.parse('2026-10-13T12:00:00Z');

/** Monta um IdleCheck com `quiet` ms de silêncio (sem end_turn e sem ferramenta pendente por padrão). */
const idle = (quiet: number, over: Partial<IdleCheck> = {}): IdleCheck => ({
  now: NOW,
  lastWriteAt: NOW - quiet,
  ended: false,
  pendingTool: false,
  ...over,
});

describe('concludedByIdle', () => {
  it('SUBAG-01: com end_turn e sem ferramenta pendente, 5 000 ms de silêncio ou mais concluem', () => {
    expect(concludedByIdle(idle(5_000, { ended: true }))).toBe(true);
    expect(concludedByIdle(idle(60_000, { ended: true }))).toBe(true);
  });

  it('SUBAG-02: com end_turn e sem ferramenta pendente, 4 999 ms ainda não concluem', () => {
    expect(concludedByIdle(idle(4_999, { ended: true }))).toBe(false);
  });

  it('SUBAG-03: sem end_turn e sem ferramenta pendente, entre 5 000 e 119 999 ms não conclui', () => {
    expect(concludedByIdle(idle(5_000))).toBe(false);
    expect(concludedByIdle(idle(119_999))).toBe(false);
  });

  it('SUBAG-04: sem end_turn e sem ferramenta pendente, 120 000 ms concluem', () => {
    expect(concludedByIdle(idle(120_000))).toBe(true);
  });

  it('SUBAG-05: com ferramenta pendente o end_turn não vale: 5 000 a 599 999 ms não concluem', () => {
    const over = { ended: true, pendingTool: true };
    expect(concludedByIdle(idle(5_000, over))).toBe(false);
    expect(concludedByIdle(idle(120_000, over))).toBe(false);
    expect(concludedByIdle(idle(599_999, over))).toBe(false);
  });

  it('SUBAG-06: com ferramenta pendente e sem end_turn, 120 000 e 599 999 ms não concluem', () => {
    const over = { pendingTool: true };
    expect(concludedByIdle(idle(120_000, over))).toBe(false);
    expect(concludedByIdle(idle(599_999, over))).toBe(false);
  });

  it('SUBAG-07: com ferramenta pendente, 600 000 ms concluem com ou sem end_turn', () => {
    expect(concludedByIdle(idle(600_000, { pendingTool: true, ended: true }))).toBe(true);
    expect(concludedByIdle(idle(600_000, { pendingTool: true, ended: false }))).toBe(true);
  });

  it('SUBAG-08: silêncio 0 ou negativo nunca conclui, em qualquer combinação', () => {
    for (const quiet of [0, -1_000]) {
      for (const ended of [false, true]) {
        for (const pendingTool of [false, true]) {
          expect(concludedByIdle(idle(quiet, { ended, pendingTool }))).toBe(false);
        }
      }
    }
  });

  it('SUBAG-09: constantes de tempo exportadas', () => {
    expect(END_TURN_QUIET_MS).toBe(5_000);
    expect(IDLE_TIMEOUT_MS).toBe(120_000);
    expect(PENDING_TOOL_TIMEOUT_MS).toBe(600_000);
    expect(BOOT_RECENT_MS).toBe(90_000);
  });
});

describe('subagentRole', () => {
  it('SUBAG-10: o agentType do meta vence o spawnType', () => {
    expect(subagentRole({ agentType: 'Explore' }, 'general-purpose')).toBe('Explore');
  });

  it('SUBAG-11: sem meta ou sem agentType, usa o spawnType', () => {
    expect(subagentRole(undefined, 'general-purpose')).toBe('general-purpose');
    expect(subagentRole({}, 'general-purpose')).toBe('general-purpose');
  });

  it('SUBAG-12: o tipo workflow-subagent aparece como Workflow, vindo do meta ou do spawnType', () => {
    expect(subagentRole({ agentType: 'workflow-subagent' }, 'general-purpose')).toBe('Workflow');
    expect(subagentRole(undefined, 'workflow-subagent')).toBe('Workflow');
  });

  it('SUBAG-13: sem nenhum tipo, o papel é o Subagente traduzido', () => {
    expect(subagentRole(undefined)).toBe(tr('Subagente'));
    expect(subagentRole({})).toBe(tr('Subagente'));
    expect(subagentRole(undefined, '')).toBe(tr('Subagente'));
  });
});

describe('parseSubagentMeta', () => {
  it('SUBAG-14: objeto com os seis campos válidos devolve exatamente os seis', () => {
    const raw = JSON.stringify({
      agentType: 'Explore',
      description: 'Procurar o bug',
      toolUseId: 'toolu_01',
      spawnDepth: 1,
      requestShape: 'prompt',
      workflowPhase: 'fase-1',
    });
    expect(parseSubagentMeta(raw)).toStrictEqual({
      agentType: 'Explore',
      description: 'Procurar o bug',
      toolUseId: 'toolu_01',
      spawnDepth: 1,
      requestShape: 'prompt',
      workflowPhase: 'fase-1',
    });
  });

  it('SUBAG-15: texto é aparado; vazio, só espaços ou não string omite a chave', () => {
    const meta = parseSubagentMeta(
      JSON.stringify({ agentType: '  Explore ', description: '   ', toolUseId: 3, requestShape: '' }),
    );
    expect(meta).toStrictEqual({ agentType: 'Explore' });
    expect(meta).not.toBeUndefined();
    expect('description' in meta!).toBe(false);
    expect('toolUseId' in meta!).toBe(false);
    expect('requestShape' in meta!).toBe(false);
  });

  it('SUBAG-16: spawnDepth numérico é mantido (0, negativo, fracionário); não numérico é omitido', () => {
    expect(parseSubagentMeta('{"spawnDepth":0}')).toStrictEqual({ spawnDepth: 0 });
    expect(parseSubagentMeta('{"spawnDepth":-1}')).toStrictEqual({ spawnDepth: -1 });
    expect(parseSubagentMeta('{"spawnDepth":1.5}')).toStrictEqual({ spawnDepth: 1.5 });
    const meta = parseSubagentMeta('{"spawnDepth":"2"}');
    expect(meta).toStrictEqual({});
    expect('spawnDepth' in meta!).toBe(false);
  });

  it('SUBAG-17: campos desconhecidos são ignorados', () => {
    expect(parseSubagentMeta('{"agentType":"Explore","foo":1}')).toStrictEqual({ agentType: 'Explore' });
  });

  it('SUBAG-18: objeto vazio devolve objeto vazio, não undefined', () => {
    expect(parseSubagentMeta('{}')).toStrictEqual({});
  });

  it('SUBAG-19: JSON inválido (inclui string vazia) devolve undefined sem lançar', () => {
    expect(parseSubagentMeta('{oops')).toBeUndefined();
    expect(parseSubagentMeta('')).toBeUndefined();
  });

  it('SUBAG-20: JSON válido que não é objeto (null, número, string, booleano) devolve undefined', () => {
    expect(parseSubagentMeta('null')).toBeUndefined();
    expect(parseSubagentMeta('0')).toBeUndefined();
    expect(parseSubagentMeta('"x"')).toBeUndefined();
    expect(parseSubagentMeta('true')).toBeUndefined();
  });
});

describe('parseJournal', () => {
  const jl = (...rows: Record<string, unknown>[]): string => rows.map((r) => JSON.stringify(r)).join('\n');

  it('SUBAG-21: uma entrada por agente, sem misturar, com done false enquanto nada é terminal', () => {
    const map = parseJournal(
      jl({ agentId: 'a', type: 'started', label: 'Revisar' }, { agentId: 'b', type: 'running', label: 'Testar' }),
    );
    expect(map.size).toBe(2);
    expect(map.get('a')).toEqual({ label: 'Revisar', done: false });
    expect(map.get('b')).toEqual({ label: 'Testar', done: false });
  });

  it('SUBAG-22: os tipos terminais marcam done true, sem diferença de maiúsculas e com espaços nas pontas', () => {
    const terminais = [
      'completed',
      'complete',
      'finished',
      'done',
      'failed',
      'errored',
      'error',
      'killed',
      'cancelled',
      'canceled',
      'stopped',
      'succeeded',
      'result',
      'RESULT',
      ' Completed ',
    ];
    for (const type of terminais) {
      expect(parseJournal(jl({ agentId: 'a', type })).get('a'), type).toEqual({ done: true });
    }
  });

  it('SUBAG-23: tipos parecidos mas não terminais mantêm done false', () => {
    const outros = ['started', 'running', 'completing', 'success', 'finish', 'results', 'cancelling'];
    for (const type of outros) {
      expect(parseJournal(jl({ agentId: 'a', type })).get('a'), type).toEqual({ done: false });
    }
  });

  it('SUBAG-24: done não volta atrás quando chega um tipo não terminal depois', () => {
    const map = parseJournal(jl({ agentId: 'a', type: 'completed' }, { agentId: 'a', type: 'running' }));
    expect(map.get('a')).toEqual({ done: true });
  });

  it('SUBAG-25: o último rótulo não vazio vence e uma linha sem rótulo não apaga o anterior', () => {
    const meio = parseJournal(
      jl({ agentId: 'a', type: 'started', label: 'L1' }, { agentId: 'a', type: 'running' }, { agentId: 'a', type: 'running', label: 'L2' }),
    );
    expect(meio.get('a')?.label).toBe('L2');
    const fim = parseJournal(jl({ agentId: 'a', type: 'started', label: 'L1' }, { agentId: 'a', type: 'running' }));
    expect(fim.get('a')?.label).toBe('L1');
  });

  it('SUBAG-26: rótulo é aparado; vazio, só espaços ou não string deixa o rótulo indefinido', () => {
    expect(parseJournal(jl({ agentId: 'a', type: 'started', label: '  Texto  ' })).get('a')).toEqual({
      label: 'Texto',
      done: false,
    });
    for (const label of ['', '   ', 3]) {
      const entry = parseJournal(jl({ agentId: 'a', type: 'started', label })).get('a');
      expect(entry, String(label)).toEqual({ done: false });
      expect('label' in entry!, String(label)).toBe(false);
    }
  });

  it('SUBAG-27: linha sem agentId ou sem type (ou com valor que não é string não vazia) não cria entrada', () => {
    const map = parseJournal(
      jl({ type: 'started' }, { agentId: 'a' }, { agentId: 1, type: 'started' }, { agentId: 'a', type: '' }),
    );
    expect(map.size).toBe(0);
  });

  it('SUBAG-28: linha em branco ou quebrada é pulada e as linhas boas seguintes são lidas', () => {
    const map = parseJournal(`\n   \n{oops\n${jl({ agentId: 'a', type: 'completed', label: 'Boa' })}\n`);
    expect(map.size).toBe(1);
    expect(map.get('a')).toEqual({ label: 'Boa', done: true });
  });

  it('SUBAG-29: linhas terminadas em CRLF dão o mesmo resultado que LF', () => {
    const linhas = [
      { agentId: 'a', type: 'started', label: 'Um' },
      { agentId: 'b', type: 'completed' },
    ];
    const lf = parseJournal(jl(...linhas) + '\n');
    const crlf = parseJournal(linhas.map((r) => JSON.stringify(r)).join('\r\n') + '\r\n');
    expect(crlf.size).toBe(2);
    expect(crlf).toEqual(lf);
    expect(crlf.get('a')).toEqual({ label: 'Um', done: false });
    expect(crlf.get('b')).toEqual({ done: true });
  });

  it('SUBAG-30: texto vazio devolve um Map vazio', () => {
    const map = parseJournal('');
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(0);
  });
});
