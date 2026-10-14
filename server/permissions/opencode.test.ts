// Pedidos de aprovação do OpenCode no registro de permissões: a ação e os recursos do Permission.Request dele chegam
// pelo mesmo corpo do hook do Claude (provider "opencode", tool_name = ação, tool_input.resources), com o resumo pela
// ferramenta equivalente do Claude e o TÍTULO pelo nome real do OpenCode (shell, edit...); caminhos do Windows no
// título; sem sugestões; as perguntas (`Question`, com tool_input.questions) viram cartão de resposta como o
// AskUserQuestion — o plugin envolve o execute da ferramenta e devolve a resposta como tool_result, porque a API do
// plugin não expõe form.reply; sem a busca da resposta no transcript (quem responde é o app, pela API); recusa com
// motivo e interromper valem — o OpenCode aceita os dois pelo reply. Dados sintéticos.
import { describe, expect, it } from 'vitest';
import { describeTool } from '../../shared/activity';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { openCodeToolView } from './opencode';
import { parseDecision, PermissionRegistry, type WaitResult } from './registry';

setQuiet(true);

const SESSION = 'ses_ecc2996d6ffeYo3j53aJF2bbqJ';
const CHILD = 'ses_filho000000000000000000';
const MAIN = `habblaud:${SESSION}`;
const SUB = `habblaud:${CHILD}`;
const CLAUDE = 'acc:1';
/** Raiz de trabalho do plugin: Windows, porque é lá que ele roda. */
const CWD = 'C:\\Users\\Teste\\proj';

function setup() {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  let permissions: PermissionRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    permissions: () => permissions?.snapshot() ?? new Map(),
    now: clock.now,
  });
  office.addMain({ id: MAIN, provider: 'opencode', account: 'habblaud', sessionId: SESSION, cwd: CWD, role: 'Agente principal', startedAt: 0, status: 'working' });
  office.addSub({ id: SUB, parentId: MAIN, sessionId: CHILD, role: 'worker', background: false, startedAt: 0 });
  office.addMain({ id: CLAUDE, account: 'acc', sessionId: 'sess-1', cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
  const scans: string[] = [];
  permissions = new PermissionRegistry({
    office,
    viewers: () => 1,
    transcriptPathOf: (id) => {
      scans.push(id);
      return undefined;
    },
    now: clock.now,
  });
  return { office, registry: permissions, clock, scans };
}

function openCodeInput(over: Record<string, unknown> = {}) {
  return {
    provider: 'opencode',
    session_id: SESSION,
    cwd: CWD,
    tool_name: 'shell',
    tool_input: { resources: ['npm test'] },
    timeout_ms: 25_000,
    ...over,
  };
}

function registered(r: ReturnType<PermissionRegistry['register']>): string {
  if ('skip' in r) throw new Error(`pulou: ${r.skip}`);
  return r.id;
}

/** O snapshot é reconstruído no commit(): office.list() ainda serve o estado anterior ao pedido. */
const snapAgent = (office: Office, id: string) => office.commit().snapshot.agents.find((a) => a.id === id);

describe('PermissionRegistry: pedidos do OpenCode', () => {
  it('publica no agente do OpenCode: provider opencode, "aprovar uma permissão", sem sugestões nem perguntas', () => {
    const { office, registry } = setup();
    const id = registered(registry.register(openCodeInput({ permission_suggestions: [{ type: 'addRules' }] })));
    const a = snapAgent(office, MAIN)!;
    expect(a).toMatchObject({ status: 'waiting', waitingFor: 'aprovar uma permissão' });
    expect(a.permission).toMatchObject({ id, provider: 'opencode', tool: 'shell', title: 'shell(npm test)', expiresAt: 1_025_000 });
    // Sem sugestão montada: o cartão não oferece "sempre permitir" (o `always` do OpenCode aprova os padrões do
    // próprio pedido e ainda não é traduzido aqui).
    expect(a.permission!.suggestions).toBeUndefined();
    expect(a.permission!.questions).toBeUndefined();
    expect(registry.detail(id)).toMatchObject({ input: 'npm test', inputKind: 'command' });
    // O agente do Claude Code não é tocado.
    expect(snapAgent(office, CLAUDE)!.permission).toBeUndefined();
  });

  it('casa pela sessão: subagente (herda o provider do principal) recebe; sessão desconhecida e payload do Claude não acham', () => {
    const { office, registry } = setup();
    registered(registry.register(openCodeInput({ session_id: CHILD })));
    expect(snapAgent(office, SUB)!.permission).toMatchObject({ provider: 'opencode', tool: 'shell' });
    // Sessão que não está no escritório: o pedido não é desviado — o próprio app do OpenCode mostra o prompt dele.
    expect(registry.register(openCodeInput({ session_id: 'ses_inexistente' }))).toEqual({ skip: 'unknown-session' });
    // Payload do Claude Code (sem provider) com a sessão do OpenCode: o resolvedor do Claude não encosta em outro
    // provedor, senão o cartão sairia no agente errado.
    expect(registry.register({ session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({ skip: 'unknown-session' });
  });

  it('decisões: allow, deny com motivo e interromper valem; "sempre permitir" não é montado; answer = invalid-answer; terminal libera', async () => {
    const { registry } = setup();
    const id = registered(registry.register(openCodeInput()));
    expect(registry.decide(id, { behavior: 'allow', suggestion: 0 })).toBe('invalid');
    expect(registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [0] }] })).toBe('invalid-answer');
    const w = registry.wait(id, 10_000)!;
    expect(registry.decide(id, { behavior: 'deny', message: 'use pnpm', interrupt: true })).toBe('ok');
    expect(await w.result).toEqual({ status: 'decided', behavior: 'deny', message: 'use pnpm', interrupt: true } satisfies WaitResult);

    // Sem escritório: libera na hora (o hook nem espera).
    expect(registry.register(openCodeInput({ session_id: 'ses_inexistente' }))).toEqual({ skip: 'unknown-session' });
    const id2 = registered(registry.register(openCodeInput()));
    const w2 = registry.wait(id2, 10_000)!;
    expect(registry.decide(id2, { behavior: 'terminal' })).toBe('ok');
    expect(await w2.result).toEqual({ status: 'released', reason: 'terminal' });
  });

  it('sem a busca da resposta no transcript: o arquivo nunca é lido e o pedido não é solto quando o agente volta a trabalhar', () => {
    const { office, registry, clock, scans } = setup();
    const id = registered(registry.register(openCodeInput()));
    const w = registry.wait(id, 25_000)!;
    office.setStatus(MAIN, 'waiting', 'aprovar uma permissão');
    for (let i = 0; i < 20; i++) {
      clock.advance(500);
      // Quem responde é o app do OpenCode (pela API), não o terminal: se o agente voltar a trabalhar, o pedido
      // continua pendurado esperando a resposta certa.
      if (i === 5) office.setStatus(MAIN, 'working');
      registry.tick();
    }
    expect(scans).toEqual([]);
    expect(registry.size).toBe(1);
    w.cancel();
  });
});

describe('PermissionRegistry: perguntas do OpenCode (Question)', () => {
  const questionInput = (over: Record<string, unknown> = {}) =>
    openCodeInput({
      tool_name: 'Question',
      tool_input: {
        questions: [
          { question: 'Qual?', header: 'Q', multiple: false, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] },
          { question: 'Quais?', multiple: true, options: [{ label: 'X', value: 'x' }, { label: 'Y', value: 'y' }] },
        ],
      },
      ...over,
    });

  it('publica o cartão de pergunta (não de permissão) e a espera recebe as respostas por posição', async () => {
    const { office, registry } = setup();
    const id = registered(registry.register(questionInput()));
    const a = snapAgent(office, MAIN)!;
    expect(a).toMatchObject({ status: 'waiting', waitingFor: 'responder uma pergunta' });
    expect(a.permission).toMatchObject({ tool: 'Question', icon: '❓' });
    expect(a.permission!.questions).toHaveLength(2);
    expect(a.permission!.questions![1]).toMatchObject({ question: 'Quais?', multiSelect: true });
    const w = registry.wait(id, 10_000)!;
    const d = parseDecision({ behavior: 'answer', answers: [{ question: 0, options: [1] }, { question: 1, options: [1, 0] }] })!;
    expect(registry.decide(id, d)).toBe('ok');
    await expect(w.result).resolves.toMatchObject({ status: 'decided', behavior: 'answer' });
  });

  it('Question sem perguntas para mostrar ou resposta fora do formato: não desvia / inválida', () => {
    const { registry } = setup();
    expect(registry.register(openCodeInput({ tool_name: 'Question', tool_input: {} }))).toEqual({ skip: 'unsupported-tool' });
    const id = registered(registry.register(questionInput()));
    // Escolha única com duas opções: inválida (o pedido segue aberto).
    expect(registry.decide(id, parseDecision({ behavior: 'answer', answers: [{ question: 0, options: [0, 1] }, { question: 1, options: [0] }] })!)).toBe('invalid-answer');
    // Aprovar uma pergunta: inválido.
    expect(registry.decide(id, { behavior: 'allow' })).toBe('invalid-answer');
    // Recusar vale (o plugin sintetiza a dispensa).
    expect(registry.decide(id, { behavior: 'deny', message: 'decida você' })).toBe('ok');
  });
});

describe('openCodeToolView: ações do OpenCode', () => {
  it('título com a ação REAL do OpenCode e resumo pela ferramenta equivalente do Claude', () => {
    const bash = describeTool('Bash', { command: 'npm test' });
    expect(openCodeToolView('shell', { resources: ['npm test'] }, CWD)).toMatchObject({
      title: 'shell(npm test)',
      input: 'npm test',
      inputKind: 'command',
      text: bash.text,
      icon: bash.icon,
    });
    // Caminho do Windows: o título sai relativo, e o basename do resumo funciona com barra invertida.
    expect(openCodeToolView('read', { resources: ['C:\\Users\\Teste\\proj\\src\\app.ts'] }, CWD)).toMatchObject({
      title: 'read(src\\app.ts)',
      text: 'Lendo app.ts',
      icon: '📖',
    });
    expect(openCodeToolView('webfetch', { resources: ['https://api.exemplo.dev/v1'] })).toMatchObject({
      title: 'webfetch(https://api.exemplo.dev/v1)',
      text: 'Lendo api.exemplo.dev',
      icon: '🌐',
    });
    expect(openCodeToolView('glob', { resources: ['src/**/*.ts'] })).toMatchObject({
      title: 'glob(src/**/*.ts)',
      text: 'Procurando src/**/*.ts',
      icon: '🔎',
    });
  });

  it('vários recursos no mesmo pedido: o título soma e o resumo não esconde o resto', () => {
    expect(openCodeToolView('shell', { resources: ['git status', 'git diff'] }, CWD)).toMatchObject({
      title: 'shell(git status) +1',
      text: 'Rodando 2 comandos',
    });
    const edit = openCodeToolView('edit', { resources: ['C:\\p\\a.ts', 'C:\\p\\b.ts', 'C:\\p\\c.ts'] }, 'C:\\p');
    expect(edit).toMatchObject({ title: 'edit(a.ts) +2', text: 'Editando 3 arquivos' });
    // `truncate` colapsa quebra de linha, então os recursos vão com separador visível.
    expect(edit.input).toBe('C:\\p\\a.ts · C:\\p\\b.ts · C:\\p\\c.ts');
    expect(edit.inputKind).toBe('text');
  });

  it('ações sem ferramenta equivalente têm resumo próprio, e "question"/"execute" não mostram o "*"', () => {
    expect(openCodeToolView('question', { resources: ['*'] }, CWD)).toMatchObject({ title: 'question', text: 'Pedindo para perguntar', icon: '❓' });
    expect(openCodeToolView('execute', { resources: ['*'] }, CWD)).toMatchObject({ title: 'execute', text: 'Pedindo para executar em Code Mode', icon: '🧰' });
    expect(openCodeToolView('external_directory', { resources: ['C:\\outro'] }, CWD)).toMatchObject({
      title: 'external_directory(C:\\outro)',
      text: 'Acessando uma pasta fora do projeto',
      icon: '📁',
    });
  });

  it('Question (com Q maiúsculo, do embrulho da ferramenta): o cartão mostra as opções', () => {
    const v = openCodeToolView(
      'Question',
      { questions: [{ question: 'Qual?', header: 'Q', multiple: false, options: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }] }] },
      CWD,
    );
    expect(v).toMatchObject({ title: 'Question', icon: '❓' });
    expect(v.questions).toHaveLength(1);
    expect(v.questions![0]).toMatchObject({ question: 'Qual?', options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }] });
  });

  it('Question sem perguntas válidas: sem cartão de resposta', () => {
    expect(openCodeToolView('Question', {}, CWD).questions).toBeUndefined();
    expect(openCodeToolView('Question', { questions: [] }, CWD).questions).toBeUndefined();
  });

  it('argumento longo demais para o título aparece no detalhe; segredo sai mascarado dos dois', () => {
    const longo = `C:\\Users\\Teste\\proj\\${'a'.repeat(140)}.ts`;
    const v = openCodeToolView('edit', { resources: [longo] }, CWD);
    expect(v.title.length).toBeLessThanOrEqual(`edit(${'a'.repeat(100)}…)` .length + 2);
    expect(v.title.endsWith('…)')).toBe(true);
    expect(v.input).toContain('.ts');
    expect(v.inputKind).toBe('text');

    const cmd = 'curl -H "Authorization: Bearer abcdef1234567890abcdef" https://api.exemplo.dev';
    const segredo = openCodeToolView('shell', { resources: [cmd] }, CWD);
    expect(segredo.title).not.toContain('abcdef1234567890abcdef');
    expect(segredo.input).not.toContain('abcdef1234567890abcdef');
  });
});
