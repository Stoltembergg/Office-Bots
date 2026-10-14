// Amostras de tokens por janela (fontes sem cota: OpenCode e DeepSeek Harness).
import { describe, expect, it } from 'vitest';
import { FIVE_HOURS_MS, pushTokenSample, sumTokenSamples, tokenUsage, WEEK_MS } from './usage';

const NOW = 1_791_800_000_000;

describe('uso em tokens', () => {
  it('pushTokenSample: ignora zeradas e poda as mais velhas que a semana', () => {
    const list = pushTokenSample([], { at: NOW, tokens: 0 }, NOW);
    expect(list).toEqual([]);
    pushTokenSample(list, { at: NOW - WEEK_MS - 1, tokens: 10 }, NOW);
    expect(list).toEqual([]);
    pushTokenSample(list, { at: NOW - 1_000, tokens: 7, costUSD: 0.02 }, NOW);
    pushTokenSample(list, { at: NOW, tokens: 5 }, NOW);
    expect(list).toHaveLength(2);
  });

  it('sumTokenSamples: soma por janela; custo só quando conhecido', () => {
    const list = [
      { at: NOW - FIVE_HOURS_MS - 1, tokens: 100 },
      { at: NOW - 1_000, tokens: 7, costUSD: 0.02 },
      { at: NOW, tokens: 5 },
    ];
    expect(sumTokenSamples(list, NOW - FIVE_HOURS_MS)).toEqual({ tokens: 12, costUSD: 0.02, knownCost: true });
    expect(sumTokenSamples(list, NOW - WEEK_MS)).toEqual({ tokens: 112, costUSD: 0.02, knownCost: true });
    expect(sumTokenSamples([{ at: NOW, tokens: 5 }], NOW - WEEK_MS)).toEqual({ tokens: 5, costUSD: 0, knownCost: false });
  });

  it('tokenUsage: janelas de 5h/7d sempre presentes, sem utilization', () => {
    const u = tokenUsage('opencode', [{ at: NOW - 1_000, tokens: 1500, costUSD: 0.015 }], NOW);
    expect(u.source).toBe('opencode');
    expect(u.fetchedAt).toBe(NOW);
    expect(u.fiveHour).toEqual({ tokens: 1500, costUSD: 0.02 });
    expect(u.sevenDay).toEqual({ tokens: 1500, costUSD: 0.02 });
    expect(u.fiveHour?.utilization).toBeUndefined();
    const empty = tokenUsage('dsh', [], NOW);
    expect(empty.fiveHour).toEqual({ tokens: 0 });
    expect(empty.sevenDay).toEqual({ tokens: 0 });
  });
});
