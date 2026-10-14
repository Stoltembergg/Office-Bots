// Ajuda ("?"): legenda de status e ícones, controles, o que o escritório mostra, contas e uso, e o Codex.
import type { AgentStatus, Provider, SkillsInventory } from '../../../shared/types';
import type { HelpSection, UiContext } from './context';
import { h, iconButton, prefersReducedMotion } from './dom';
import { ICONS } from './icons';
import { SHELL_STAGES, STATUS_LABEL } from './model';
import { CODEX_LIVE_HINT, PROVIDER_NAME } from './provider';
import { createUsageSetup, richText } from './usage';
import { createAccountChip, updateAccountChip } from './widgets';

const STATUS_HELP: [AgentStatus, string][] = [
  ['working', 'Na mesa, digitando: está processando um pedido.'],
  ['waiting', 'Mão levantada: espera uma resposta sua no terminal (permissão, pergunta ou escolha).'],
  ['shell', 'Ampulheta sobre a cabeça: terminou o turno e fica na mesa esperando um shell terminar.'],
  ['idle', 'Terminou o turno e circula pelo escritório até a próxima instrução.'],
  ['done', 'Subagente que concluiu: entrega o resultado e vai embora.'],
  ['offline', 'A sessão foi fechada: o personagem vai até o elevador e sai.'],
];

const ICON_HELP: [string, string][] = [
  ['📨', 'Recebeu um pedido'],
  ['💭', 'Pensando'],
  ['📖', 'Lendo arquivo'],
  ['🔎', 'Buscando no código'],
  ['✏️', 'Editando'],
  ['📝', 'Escrevendo arquivo'],
  ['💻', 'Comando no terminal'],
  ['⏳', 'Esperando um shell'],
  ['🧪', 'Rodando testes'],
  ['🌐', 'Pesquisando na web'],
  ['🗒️', 'Organizando tarefas'],
  ['👥', 'Chamando subagentes'],
  ['✋', 'Precisa de você'],
  ['✅', 'Concluiu'],
  ['❌', 'Shell falhou'],
  ['🛑', 'Shell interrompido'],
  ['⚠️', 'Algo deu errado'],
];

/** Rodas da vida social (quem está à toa se junta com os colegas). */
const SOCIAL_HELP: [string, string][] = [
  ['📺', 'TV no lounge: futebol (comemoram o gol junto com a tela), novela ou desenho, com pipoca.'],
  ['🎮', 'Videogame no sofá (melhor de 3) ou duelo nos fliperamas, com torcida.'],
  ['🏓', 'Pingue-pongue até 5 pontos, com placar e torcida atrás da mesa.'],
  ['☕', 'Papo na copa: pegam café e sentam para fofocar, contar piada e falar de trabalho.'],
  ['✊', 'Jokenpô valendo moedinhas: jo-ken-pô, revelação, quem ganha leva o 🪙 (e quem perde pede revanche).'],
  ['💄', 'Espelho do banheiro: se arrumam (batom, pente) e aparecem refletidos no vidro.'],
  ['🪙', 'Carteira: entram com 🪙100 (subagentes 🪙30), ganham 🪙10 por tarefa concluída, 🪙5 por pedido atendido e 🪙15 por entrega de subagente.'],
];

/** Eventos do GitHub vistos ao vivo nas sessões (gh, git push, MCP do GitHub). */
const GITHUB_HELP: [string, string][] = [
  ['🎉', 'Festa: PR aberto ou mergeado, release publicada (ou CI verde depois de um alarme). Confete cai na sala, todos comemoram e uma faixa diz o motivo (~12 s).'],
  ['🚨', 'Alarme: o CI ficou vermelho. Giroflex nos cantos da sala, chão avermelhado e um balão “!” sobre quem viu a falha, até um CI verde na sala (ou 10 min).'],
  ['🚀', 'Push: só o aviso e o feed, sem mexer na sala.'],
];

/** O Codex no escritório: o que muda em relação ao Claude Code (trechos `assim` viram código). */
const CODEX_HELP: string[] = [
  'Cada projeto aberto no Codex (no terminal ou no app) vira uma sala: a mesma das outras ferramentas naquela pasta, e todas dividem a sala.',
  'Os agentes do Codex têm o chip da conta vazado (só a borda na cor da conta) e o selo CODEX na etiqueta e nos detalhes.',
  `${CODEX_LIVE_HINT} Sem os hooks, o escritório lê os arquivos de sessão do Codex: cada passo aparece quando termina.`,
  'Aprovar pelo escritório: no Codex, a aprovação só aparece no terminal depois que você responder aqui ou o prazo acabar (alguns segundos). Não há “não perguntar de novo” nem “interromper”, e recusar pede um motivo.',
  'Mensagens: entram na fila da sessão e viram o próximo prompt quando o Codex terminar o que está fazendo (até ~10 s). Com o Habblaud no Docker, deixe `npm run codex:bridge` rodando; no modo Node funciona sozinho.',
  'Perguntas do Codex são respondidas no próprio Codex.',
  'Uso: vem dos arquivos de sessão do Codex, sem instalar nada, e só se renova enquanto alguma sessão roda (por isso o cartão mostra a idade, ex.: “há 12 min”). “sem cota” quer dizer sem cota nem créditos para usar agora.',
  'Meu dia: o Codex conta tokens, mas não grava custo.',
];

/** O fim da espera (o servidor marca com uma atividade ✅ ou ❌). */
const SHELL_END_HELP: [string, string][] = [
  ['🎉', 'Terminou bem: levanta, comemora com confete e uma estrela.'],
  ['🌧️', 'Falhou ou foi interrompido: nuvenzinha de chuva sobre a cabeça e ombros caídos.'],
];

const INTRO =
  'Cada projeto aberto no Claude Code, no Codex, no OpenCode ou no DeepSeek Harness vira uma sala (ferramentas diferentes no mesmo projeto dividem a sala), e cada sessão aberta é um personagem com nome próprio. ' +
  'Subagentes chegam como colegas novos, trabalham na mesma sala e vão embora quando terminam. ' +
  'Quando a última sessão de uma sala é fechada, quem sai apaga a luz e a sala é desmontada.';

const SHORTCUTS: [string[], string][] = [
  [['/'], 'Buscar agente, projeto ou conta'],
  [['F'], 'Seguir o agente selecionado'],
  [['T'], 'Abrir ou fechar o terminal do agente selecionado'],
  [['Ctrl+F'], 'Com o terminal em foco: buscar na conversa (⌘F no Mac); Enter e Shift+Enter navegam'],
  [['L'], 'Abrir ou fechar o timelapse do dia'],
  [['P'], 'Ir até o próximo pedido de permissão ou pergunta para responder pelo escritório'],
  [['M'], 'Meu dia: para onde foi o tempo (trabalhando, esperando você...)'],
  [['O', '0'], 'Visão geral do prédio'],
  [['Esc'], 'Fechar a busca do terminal, depois o terminal; depois, a gaveta e a seleção'],
  [['['], 'Mostrar ou ocultar o painel lateral'],
  [[']'], 'Mostrar ou ocultar o feed de atividade'],
  [['?'], 'Abrir esta ajuda'],
  [['←', '↑', '→', '↓'], 'Mover a câmera (também W A S D)'],
  [['+', '−'], 'Aproximar e afastar'],
];

function keys(list: string[]): HTMLElement {
  return h('span', { class: 'ui-keys' }, ...list.map((k) => h('kbd', { class: 'ui-kbd', text: k })));
}

export class HelpDialog {
  readonly el: HTMLDialogElement;
  private sections = new Map<HelpSection, HTMLElement>();
  private skillsBody!: HTMLElement;
  private skillsLoading = false;

  constructor(private ctx: UiContext) {
    const close = iconButton(ICONS.close, 'Fechar ajuda', () => this.el.close(), 'ui-icon-btn--sm');
    const statusList = h(
      'ul',
      { class: 'ui-legend' },
      ...STATUS_HELP.map(([s, text]) =>
        h('li', {}, h('span', { class: `ui-status-dot is-${s}`, attrs: { 'aria-hidden': 'true' } }), h('strong', { text: STATUS_LABEL[s] }), h('span', { text })),
      ),
    );
    const iconList = h(
      'ul',
      { class: 'ui-icon-legend' },
      ...ICON_HELP.map(([icon, text]) => h('li', {}, h('span', { class: 'ui-icon-legend__icon', text: icon, attrs: { 'aria-hidden': 'true' } }), h('span', { text }))),
    );
    const shortcuts = h('dl', { class: 'ui-shortcuts' }, ...SHORTCUTS.flatMap(([k, text]) => [h('dt', {}, keys(k)), h('dd', { text })]));

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-help', attrs: { 'aria-labelledby': 'ui-help-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: 'Como ler o escritório', attrs: { id: 'ui-help-title' } }), close),
      h(
        'div',
        { class: 'ui-dialog__body' },
        h('section', { class: 'ui-help__intro' }, h('p', { text: INTRO })),
        h('section', {}, h('h3', { text: 'Status' }), statusList),
        h('section', {}, h('h3', { text: 'Atividades' }), iconList),
        this.shellSection(),
        this.socialSection(),
        this.githubSection(),
        h(
          'section',
          {},
          h('h3', { text: 'Controles' }),
          h(
            'ul',
            { class: 'ui-help__list' },
            h('li', { text: 'Arraste o escritório para mover a câmera e use a rolagem do mouse (ou pinça) para dar zoom.' }),
            h('li', { text: 'Clique em um personagem ou sala para ver os detalhes; duplo clique aproxima a câmera.' }),
            h('li', { text: 'Passe o mouse sobre um personagem para ver o que ele está fazendo.' }),
            h('li', {
              text: 'Nos detalhes de um agente, “Abrir terminal” mostra a conversa da sessão como na ferramenta dela (Claude Code, Codex, OpenCode ou DeepSeek Harness), ao vivo (precisa do acesso local, bind 127.0.0.1).',
            }),
            h('li', {
              text: 'Com o plugin habblaud-mensagens (npm run mod:install), dá para mandar mensagens ao agente principal pelos detalhes dele ou pela caixa no rodapé do terminal: o texto entra na sessão como se você o tivesse digitado. Enter manda, Shift+Enter quebra a linha.',
            }),
            h('li', {
              text: 'No terminal: busca (lupa ou Ctrl/⌘+F), filtro “Tudo / Só prompts / Sem ferramentas” e um botão de copiar em cada entrada. O relógio da barra superior abre o histórico das sessões dos últimos 7 dias, inclusive as já encerradas.',
            }),
            h('li', {
              text: 'Com o mod do Habblaud instalado (npm run mod:install, que inclui o plugin de permissões), quem “pede permissão” mostra nos detalhes o comando ou a edição e os botões Aprovar, Recusar e Responder no terminal; quem faz uma pergunta mostra as opções (e um “Outro” para escrever) para responder por aqui. O diálogo continua no terminal: vale o que você responder primeiro.',
            }),
          ),
          shortcuts,
        ),
        this.usageSection(),
        this.codexSection(),
        this.toolsSection(),
        this.skillsSection(),
      ),
    );
    // Clique no fundo (fora do conteúdo) fecha.
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.el.close();
    });
  }

  open(section?: HelpSection): void {
    if (!this.el.open) this.el.showModal();
    void this.refreshSkills();
    const target = section ? this.sections.get(section) : undefined;
    if (!target) return;
    // Rola até a seção pedida e a destaca por um instante.
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      target.classList.remove('is-highlight');
      void target.offsetWidth;
      target.classList.add('is-highlight');
      const heading = target.querySelector<HTMLElement>('h3');
      heading?.focus({ preventScroll: true });
    });
  }

  /** Legenda da espera por shell: a "escalada cômica" do personagem conforme o shell demora. */
  private shellSection(): HTMLElement {
    const item = (emoji: string, text: string) =>
      h('li', {}, h('span', { class: 'ui-icon-legend__icon', text: emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { text }));
    return h(
      'section',
      { class: 'ui-help__shell' },
      h('h3', { text: 'Esperando o shell' }),
      h('p', {
        class: 'ui-help__lead',
        text:
          'Quando o agente termina o turno com um comando rodando em segundo plano (ou fica mais de 10 s parado num comando), ele não sai para passear: ' +
          'fica na mesa com a ampulheta virando, o monitor mostra o progresso e um balão diz qual shell ele espera e há quanto tempo. Quanto mais demora…',
      }),
      h('ul', { class: 'ui-shell-legend' }, ...SHELL_STAGES.map((s) => item(s.emoji, s.help)), ...SHELL_END_HELP.map(([e, t]) => item(e, t))),
    );
  }

  /** Legenda da vida social: as rodas dos ociosos, as personalidades e as moedinhas. */
  private socialSection(): HTMLElement {
    const item = (emoji: string, text: string) =>
      h('li', {}, h('span', { class: 'ui-icon-legend__icon', text: emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { text }));
    return h(
      'section',
      { class: 'ui-help__shell' },
      h('h3', { text: 'Vida social' }),
      h('p', {
        class: 'ui-help__lead',
        text:
          'Quando dois ou mais agentes estão à toa (ociosos, ou esperando um shell há mais de 40 s), eles se juntam. Cada um tem 2 ou 3 traços de personalidade ' +
          '(competição, fofoca, vaidade, sonecas…), amizades e rivalidades, e isso decide o que preferem fazer, com quem e o que falam. ' +
          'Os detalhes do agente mostram a personalidade, a carteira e o extrato; as partidas e apostas aparecem no feed.',
      }),
      h('ul', { class: 'ui-shell-legend' }, ...SOCIAL_HELP.map(([e, t]) => item(e, t))),
    );
  }

  /** Legenda do GitHub no escritório: festa e alarme nas salas. */
  private githubSection(): HTMLElement {
    const item = (emoji: string, text: string) =>
      h('li', {}, h('span', { class: 'ui-icon-legend__icon', text: emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { text }));
    return h(
      'section',
      { class: 'ui-help__shell' },
      h('h3', { text: 'GitHub no escritório' }),
      h('p', {
        class: 'ui-help__lead',
        text:
          'O que os agentes fazem no GitHub (gh pr create/merge, git push, gh run watch, gh pr checks, gh release create e o MCP do GitHub) vira aviso, ' +
          'entra no feed e anima a sala do projeto. Só o que acontece ao vivo: o que já estava nos transcripts quando o Habblaud abriu fica só no histórico.',
      }),
      h('ul', { class: 'ui-shell-legend' }, ...GITHUB_HELP.map(([e, t]) => item(e, t))),
    );
  }

  private usageSection(): HTMLElement {
    const el = h(
      'section',
      { class: 'ui-help__usage', attrs: { 'aria-labelledby': 'ui-help-usage' } },
      h('h3', { text: 'Contas e uso', tabIndex: -1, attrs: { id: 'ui-help-usage' } }),
      h(
        'ul',
        { class: 'ui-help__list' },
        h('li', { text: 'O chip com a logo mostra de qual ferramenta é cada agente (Claude Code, Codex, OpenCode ou DeepSeek Harness); a letra e a cor dizem a conta: cada atalho de terminal usa uma pasta de configuração diferente.' }),
        h('li', {}, accountSample('C', '#f08a3c'), ' Conta do Claude Code · ', accountSample('X', '#a77bf3', true), ' Conta do Codex (chip vazado, com o selo CODEX onde há espaço).'),
        h('li', {
          text: 'No topo, cada conta mostra o uso da sessão de 5 horas e da semana. O ↻ indica quando cada limite reinicia (contagem regressiva se faltar menos de um dia). Verde abaixo de 50%, âmbar até 80% e vermelho a partir daí.',
        }),
        h('li', {
          text: 'OpenCode e DeepSeek Harness não têm cota do plano: o cartão mostra os tokens somados das sessões (e o custo, quando conhecido), sem barra nem reinício.',
        }),
        h('li', { text: 'Números antigos ficam acinzentados com a idade ao lado (ex.: “há 3 h”); uma janela que já reiniciou desde a leitura mostra “—” e “renovada”.' }),
      ),
      h('p', { class: 'ui-help__lead', text: 'Para ver o uso de uma conta (“sem dados de uso”), em ordem de preferência:' }),
      createUsageSetup(),
    );
    this.sections.set('usage', el);
    return el;
  }

  /** O Codex no escritório (o "Como funciona" do cartão de uso de uma conta do Codex abre aqui). */
  private codexSection(): HTMLElement {
    const el = h(
      'section',
      { class: 'ui-help__usage', attrs: { 'aria-labelledby': 'ui-help-codex' } },
      h('h3', { text: 'Codex', tabIndex: -1, attrs: { id: 'ui-help-codex' } }),
      h('ul', { class: 'ui-help__list' }, ...CODEX_HELP.map((text) => h('li', {}, ...richText(text)))),
    );
    this.sections.set('codex', el);
    return el;
  }

  /** Biblioteca de skills, MCPs e memória: o servidor descobre sozinho onde cada ferramenta guarda as suas. */
  private skillsSection(): HTMLElement {
    this.skillsBody = h('div', { class: 'ui-skills__body' }, h('p', { class: 'ui-muted', text: 'Carregando…' }));
    return h(
      'section',
      { class: 'ui-help__usage' },
      h('h3', { text: 'Skills, MCPs e memória' }),
      h('p', {
        class: 'ui-help__lead',
        text: 'O Habblaud descobre sozinho onde cada ferramenta guarda skills, MCPs e memória, e mostra tudo junto aqui — para todo mundo do escritório usar. Instalar copia a pasta da skill para a ferramenta (MCPs e memórias não são copiados: segredos nunca saem da ferramenta).',
      }),
      this.skillsBody,
    );
  }

  private async refreshSkills(): Promise<void> {
    if (this.skillsLoading || !this.skillsBody) return;
    this.skillsLoading = true;
    try {
      const inv = await this.ctx.store.fetchSkills();
      this.skillsBody.replaceChildren(...(inv ? this.renderSkills(inv) : [h('p', { class: 'ui-muted', text: 'Não deu para carregar agora.' })]));
    } catch {
      this.skillsBody.replaceChildren(h('p', { class: 'ui-muted', text: 'Não deu para carregar agora.' }));
    } finally {
      this.skillsLoading = false;
    }
  }

  private renderSkills(inv: SkillsInventory): Node[] {
    const out: Node[] = [];
    const byName = new Map<string, { description: string; have: Map<Provider, string> }>();
    for (const s of inv.skills) {
      let e = byName.get(s.name);
      if (!e) {
        e = { description: s.description, have: new Map() };
        byName.set(s.name, e);
      }
      if (!e.description && s.description) e.description = s.description;
      if (!e.have.has(s.provider)) e.have.set(s.provider, s.accountName || s.accountId);
    }
    const providers = [...new Set(inv.skills.map((s) => s.provider))];
    if (!byName.size) {
      out.push(h('p', { class: 'ui-muted', text: 'Nenhuma skill nas pastas visíveis para o servidor.' }));
    } else {
      const items: HTMLElement[] = [];
      for (const [name, e] of [...byName].sort(([a], [b]) => a.localeCompare(b))) {
        const missing = providers.filter((p) => !e.have.has(p));
        const haveText = [...e.have].map(([p, acc]) => `${PROVIDER_NAME[p]}${acc ? ` (${acc})` : ''}`).join(', ');
        items.push(
          h(
            'li',
            {},
            h('div', { class: 'ui-skills__head' }, h('code', { class: 'ui-usage-setup__cmd', text: name }), h('span', { class: 'ui-skills__have', text: `em: ${haveText}` })),
            e.description ? h('p', { class: 'ui-skills__desc', text: e.description }) : null,
            missing.length
              ? h(
                  'div',
                  { class: 'ui-skills__install' },
                  ...missing.map((p) =>
                    h('button', {
                      class: 'ui-btn ui-btn--sm',
                      type: 'button',
                      text: `Instalar no ${PROVIDER_NAME[p]}`,
                      title: `Copia a pasta da skill para ${PROVIDER_NAME[p]}`,
                      on: { click: (ev) => void this.installSkill(name, e.have, p, ev.target as HTMLElement) },
                    }),
                  ),
                )
              : null,
          ),
        );
      }
      out.push(h('ul', { class: 'ui-help__list ui-skills__list' }, ...items));
    }
    if (inv.mcp.length) {
      const byProv = new Map<Provider, string[]>();
      for (const m of inv.mcp) {
        const list = byProv.get(m.provider) ?? [];
        if (!list.includes(m.name)) list.push(m.name);
        byProv.set(m.provider, list);
      }
      out.push(h('h4', { class: 'ui-skills__sub', text: 'MCPs (só nomes — segredos nunca saem da ferramenta)' }));
      out.push(
        h(
          'ul',
          { class: 'ui-help__list' },
          ...[...byProv].map(([p, names]) => h('li', {}, h('strong', { text: `${PROVIDER_NAME[p]}: ` }), h('span', { text: names.join(', ') || '—' }))),
        ),
      );
    }
    if (inv.memory.length) {
      out.push(h('h4', { class: 'ui-skills__sub', text: 'Memória (só presença — o conteúdo nunca é lido)' }));
      out.push(
        h(
          'ul',
          { class: 'ui-help__list' },
          ...inv.memory.map((m) => h('li', {}, h('strong', { text: `${PROVIDER_NAME[m.provider]}${m.accountName ? ` (${m.accountName})` : ''}: ` }), h('span', { text: m.detail }))),
        ),
      );
    }
    return out;
  }

  private async installSkill(name: string, have: Map<Provider, string>, to: Provider, btn: HTMLElement): Promise<void> {
    const from = [...have.keys()][0];
    const fromEntry = { provider: from, accountId: '' };
    btn.setAttribute('disabled', '');
    try {
      const r = await this.ctx.store.installSkill(name, fromEntry, to);
      this.ctx.announce(r.ok ? `Skill ${name} instalada no ${PROVIDER_NAME[to]}.` : `Não instalou: ${r.error}`);
      if (r.ok) await this.refreshSkills();
    } finally {
      btn.removeAttribute('disabled');
    }
  }

  /** Como cada ferramenta entra no escritório (o Habblaud observa: ele não abre terminais nem cria sessões). */
  private toolsSection(): HTMLElement {
    return h(
      'section',
      { class: 'ui-help__usage' },
      h('h3', { text: 'Ligando cada ferramenta' }),
      h(
        'ul',
        { class: 'ui-help__list' },
        h('li', {
          text: 'O escritório não abre programas: abra a ferramenta na pasta do projeto e a sala aparece sozinha. Várias empresas ao mesmo tempo: cada pasta vira uma sala — use a visão geral (O), a busca (/) e os filtros de conta na lateral para navegar e focar.',
        }),
        h('li', {}, ...richText('Claude Code: `npm run mod:install` liga o uso ao vivo, as mensagens pelo escritório e as permissões com Aprovar/Recusar por aqui.')),
        h('li', {}, ...richText('Codex: `npm run codex:install` liga os hooks (ao vivo e aprovações); com o Habblaud no Docker, deixe `npm run codex:bridge` rodando para mensagens e aprovações.')),
        h('li', {}, ...richText('OpenCode: deixe `npm run opencode:bridge` rodando neste computador para mensagens e aprovações; o uso em tokens aparece sozinho.')),
        h('li', {
          text: 'DeepSeek Harness: só leitura (agentes, terminal e uso em tokens aparecem sozinhos); permissões e mensagens se resolvem no próprio aplicativo.',
        }),
      ),
    );
  }

  get isOpen(): boolean {
    return this.el.open;
  }
}

/** Um chip de conta de exemplo (legenda). */
function accountSample(short: string, color: string, codex = false): HTMLElement {
  const chip = createAccountChip('sm');
  updateAccountChip(chip, { id: short, short, name: codex ? 'Codex' : `Conta ${short}`, color, configDir: '', sessions: 0, usageStatus: 'disabled', ...(codex ? { provider: 'codex' as const } : {}) });
  chip.setAttribute('aria-hidden', 'true');
  return chip;
}
