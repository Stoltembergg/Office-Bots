// Diagnóstico do status: passa as linhas do transcript do OpenCode pelo parser REAL e mostra o que ele entende.
import { describe, expect, it } from 'vitest';
import { createTranscriptState, parseLine } from './transcript';

function feed(lines: string[]) {
  const s = createTranscriptState();
  const ctx = { idPrefix: 'k', now: 1_700_000_000_000 };
  for (const l of lines) parseLine(s, l, ctx);
  return s;
}

const PROMPT = JSON.stringify({
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-10-13T07:00:00.000Z',
  message: { role: 'user', content: 'oi' },
});
const ANSWER = JSON.stringify({
  type: 'assistant',
  uuid: 'a1',
  timestamp: '2026-10-13T07:00:02.000Z',
  message: { role: 'assistant', content: [{ type: 'text', text: 'Oi!' }] },
});
const TURN_END = JSON.stringify({
  type: 'assistant',
  uuid: 'turn-end:m1',
  timestamp: '2026-10-13T07:00:05.000Z',
  message: { role: 'assistant', content: [], stop_reason: 'end_turn' },
});

describe('status a partir do transcript do OpenCode', () => {
  it('prompt + resposta => current preenchido, ended falso (still working)', () => {
    const s = feed([PROMPT, ANSWER]);
    expect(s.ended).toBe(false);
  });

  it('acrescentando a linha de fim de turno => ended vira true', () => {
    const s = feed([PROMPT, ANSWER, TURN_END]);
    expect(s.ended).toBe(true);
  });

  it('a linha de fim de turno sozinha tambem encerra', () => {
    const s = feed([PROMPT, ANSWER, TURN_END]);
    // ended precisa continuar valido mesmo com `current` preenchido (e' o que trava o status).
    expect(s.ended && !s.pendingTools.size).toBe(true);
  });
});