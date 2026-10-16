import { afterEach, expect, it } from 'vitest';
import { setLocale } from '../../../shared/i18n';
import { formatCountdown } from './format';
import { waitRows } from './daystats-model';

afterEach(() => setLocale('pt-BR'));

it('traduz a contagem regressiva e o rótulo das maiores esperas em inglês', () => {
  setLocale('en');
  expect(formatCountdown(120_000, 0)).toBe('in 2 min');
  const rows = waitRows([{ agentId: 'a', agentName: 'Marina', roomId: 'r', roomName: 'shop', account: 'c', start: 0, end: 120_000, ms: 120_000, ongoing: true }], () => '14:00');
  expect(rows[0].label).toBe('#1: 2 min, Marina in shop, since 14:00, still waiting');
});
