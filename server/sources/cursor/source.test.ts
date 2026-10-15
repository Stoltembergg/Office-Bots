// Fonte do Cursor: os eventos dos hooks põem a conversa no escritório, mudam o status e a tiram de lá.
import { describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { pickEvent, passThrough } from '../../../mod/habblaud-cursor/hook.mjs';
import { withHabblaud } from '../../../scripts/cursor-install';
import { CursorSource, IDLE_CLOSE_MS } from './source';

const CONV = '0c6f1d2e-1111-4222-8333-944455556666';
const KEY = `.cursor:${CONV}`;

function setup() {
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: '/tmp/nada', env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new CursorSource({ accounts, office, configDir: '/home/eu/.cursor', now });
  const ev = (hook_event_name: string, extra: Record<string, unknown> = {}) =>
    source.applyHookEvent({ hook_event_name, conversation_id: CONV, workspace_roots: ['/home/eu/projeto'], ...extra });
  return { accounts, office, source, ev, advance: (ms: number) => (clock += ms) };
}

describe('CursorSource', () => {
  it('sem eventos, não registra conta nenhuma', () => {
    const { accounts, source } = setup();
    expect(accounts.entriesOf('cursor')).toEqual([]);
    expect(source.sources()).toEqual([]);
  });

  it('o primeiro evento põe a conversa no escritório, com a conta do Cursor', () => {
    const { accounts, office, source, ev } = setup();
    expect(ev('beforeSubmitPrompt', { prompt: 'arruma o teste' })).toBe(true);
    const a = office.get(KEY);
    expect(a?.provider).toBe('cursor');
    expect(a?.status).toBe('working');
    expect(accounts.entriesOf('cursor').map((e) => e.id)).toEqual(['.cursor']);
    expect(source.sources()).toMatchObject([{ label: '.cursor', provider: 'cursor', sessions: 1 }]);
    expect(office.detail(KEY)?.history.at(-1)?.kind).toBe('prompt');
  });

  it('comandos e edições viram atividades; stop deixa ocioso', () => {
    const { office, ev } = setup();
    ev('afterShellExecution', { command: 'npm test' });
    ev('afterFileEdit', { file_path: '/home/eu/projeto/src/app.ts' });
    expect(office.detail(KEY)?.history.at(-1)?.text).toContain('app.ts');
    ev('stop', { status: 'completed' });
    expect(office.get(KEY)?.status).toBe('idle');
    ev('beforeSubmitPrompt', { prompt: 'de novo' });
    expect(office.get(KEY)?.status).toBe('working');
  });

  it('sessionEnd e o tempo parado tiram a conversa', () => {
    const { office, source, ev, advance } = setup();
    ev('sessionStart');
    ev('sessionEnd');
    expect(source.sources()[0].sessions).toBe(0);
    ev('beforeSubmitPrompt', { prompt: 'oi' });
    expect(source.sources()[0].sessions).toBe(1);
    advance(IDLE_CLOSE_MS + 1);
    source.sweep();
    expect(source.sources()[0].sessions).toBe(0);
    expect(office.get(KEY)?.status ?? 'offline').not.toBe('working');
  });

  it('recusa evento sem conversa válida', () => {
    const { source } = setup();
    expect(source.applyHookEvent({ hook_event_name: 'stop' })).toBe(false);
    expect(source.applyHookEvent({ hook_event_name: 'stop', conversation_id: '../../etc' })).toBe(false);
  });
});

describe('hook do Cursor', () => {
  it('manda só metadados e deixa o Cursor seguir', () => {
    const picked = pickEvent({ hook_event_name: 'afterShellExecution', conversation_id: CONV, command: 'ls', output: 'segredo' });
    expect(picked).toEqual({ hook_event_name: 'afterShellExecution', conversation_id: CONV, command: 'ls' });
    expect(JSON.parse(passThrough('beforeSubmitPrompt'))).toEqual({ continue: true });
    expect(JSON.parse(passThrough('stop'))).toEqual({});
  });

  it('o instalador mantém os outros hooks e não duplica o do Habblaud', () => {
    const other = { command: 'bun outro.cjs hook cursor summarize' };
    const once = withHabblaud({ version: 1, hooks: { stop: [other] } }, 'node "/x/mod/habblaud-cursor/hook.mjs"');
    const twice = withHabblaud(once, 'node "/y/mod/habblaud-cursor/hook.mjs"');
    expect(twice.hooks?.stop).toEqual([other, { command: 'node "/y/mod/habblaud-cursor/hook.mjs"' }]);
    expect(withHabblaud(twice, undefined).hooks).toEqual({ stop: [other] });
  });
});
