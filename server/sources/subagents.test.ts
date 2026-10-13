import { describe, expect, it } from 'vitest';
import { tr } from '../../shared/i18n';
import {
  BOOT_RECENT_MS,
  concludedByIdle,
  END_TURN_QUIET_MS,
  IDLE_TIMEOUT_MS,
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
