// Cartões de USO POR CONTA na barra superior: sessão de 5 horas e semanal, com reinício e origem dos números.
// Regras de apresentação:
// - número velho nunca passa por atual: janela que já renovou depois da leitura mostra "—" e "renovada";
//   números antigos ficam acinzentados com a idade ("há 6 d") no cabeçalho ou, no celular, um selo no chip;
// - o reinício vem com verbo implícito no ícone ↻ e contagem regressiva quando falta menos de um dia;
// - conta sem números diz "sem dados de uso" e oferece "Como ativar" (mod do Habblaud, recomendado).
// Conta do Codex: os números vêm dos arquivos de sessão dele, que só se renovam enquanto alguma sessão roda; por isso
// a idade ("há 12 min") fica sempre à mostra. Sem cota nem créditos ("sem cota") nunca vira 0%. Não há o que
// instalar para o uso: "Como funciona" abre a ajuda na seção do Codex. Sem Opus/Sonnet nem e-mail (só o plano).
// Conta do Cursor: medidores Cursor Models / Other Models (autoPercentUsed / apiPercentUsed) via API do CLI.
import type { AccountInfo } from '../../../shared/types';
import type { UiContext } from './context';
import { h, KeyedList, setAttr, setHidden, setStyleVar, setText, setTitle, setVariant } from './dom';
import {
  BILLING_CYCLE_MS,
  FIVE_HOURS_MS,
  relativeTime,
  usageLevel,
  usageWindowView,
  WEEK_MS,
  type UsageWindowView,
} from './format';
import { ICONS } from './icons';
import { isCodex, isCursor, providerOf } from './provider';
import { createAccountChip, createProviderTag, updateAccountChip, updateProviderTag } from './widgets';

export const SOURCE_LABEL: Record<NonNullable<AccountInfo['usage']>['source'], string> = {
  cache: 'cache do /usage do Claude Code',
  statusline: 'ao vivo (statusline do Claude Code)',
  codex: 'arquivos do Codex',
  cursor: 'API do Cursor (login do CLI)',
};

/** Origem para mostrar: o arquivo ao vivo pode ter sido gravado pelo mod do Habblaud ou pelo tap. */
export function sourceLabel(u: NonNullable<AccountInfo['usage']>): string {
  if (u.source === 'statusline' && u.via === 'mod') return 'ao vivo (mod do Habblaud)';
  return SOURCE_LABEL[u.source] ?? u.source;
}

/**
 * Como ligar o uso de uma conta, em ordem de preferência (dica do cartão e ajuda).
 * Trechos entre crases viram código (sem quebra de linha no meio do comando).
 */
export const USAGE_SETUP_STEPS: readonly [string, string][] = [
  [
    'npm run mod:install',
    'Recomendado: instala o mod do Habblaud no Claude Code (2.1.287 ou mais novo), que passa o uso de 5 h e da semana ao vivo. Rode na pasta do Habblaud, no computador onde o Claude Code roda; nas sessões já abertas, `/reload-plugins`.',
  ],
  [
    'npm run usage:install',
    'No Claude Code anterior ao 2.1.287: liga um tap na linha de status, que passa os mesmos números ao vivo.',
  ],
  ['/usage', 'Sem instalar nada: rode `/usage` no Claude Code desta conta para atualizar o cache (os números envelhecem até a próxima vez).'],
];

/** Como ligar o uso da conta Cursor (dica do cartão). */
export const CURSOR_USAGE_SETUP_STEPS: readonly [string, string][] = [
  [
    'agent login',
    'No host onde o Habblaud roda, autentique o Cursor CLI (`agent login`). O Habblaud lê `~/.config/cursor/auth.json` e consulta o uso do plano (Cursor Models e Other Models).',
  ],
  [
    'HABBLAUD_CURSOR_AUTH',
    'Opcional: caminho alternativo do `auth.json` se o login do CLI não estiver no padrão `~/.config/cursor/auth.json`.',
  ],
];

/** Texto com trechos `assim` como código. */
export function richText(text: string): Node[] {
  return text.split('`').map((part, i) => (i % 2 ? h('code', { class: 'ui-usage-setup__inline', text: part }) : document.createTextNode(part)));
}

interface Meter {
  el: HTMLElement;
  bar: HTMLElement;
  pct: HTMLElement;
  reset: HTMLElement;
  resetLong: HTMLElement;
  resetShort: HTMLElement;
  labelLong: HTMLElement;
  labelShort: HTMLElement;
}

interface CardRefs {
  chip: HTMLElement;
  flag: HTMLElement;
  name: HTMLElement;
  prov: HTMLElement;
  email: HTMLElement;
  state: HTMLElement;
  stateText: HTMLElement;
  meters: HTMLElement;
  five: Meter;
  week: Meter;
  msg: HTMLElement;
  msgLong: HTMLElement;
  msgShort: HTMLElement;
  how: HTMLButtonElement;
  howLong: HTMLElement;
  howShort: HTMLElement;
  tip: HTMLElement;
  tipTitle: HTMLElement;
  tipRows: HTMLElement;
  tipNote: HTMLElement;
  tipSetup: HTMLElement;
}

let tipSeq = 0;

function createMeter(long: string, short: string, title: string): Meter {
  const bar = h('span', { class: 'ui-meter__bar' }, h('span', { class: 'ui-meter__fill' }));
  const pct = h('span', { class: 'ui-meter__pct' });
  const resetLong = h('span', { class: 'ui-meter__reset-long' });
  const resetShort = h('span', { class: 'ui-meter__reset-short' });
  const reset = h('span', { class: 'ui-meter__reset' }, resetLong, resetShort);
  const labelLong = h('span', { class: 'ui-meter__label-long', text: long });
  const labelShort = h('span', { class: 'ui-meter__label-short', text: short, attrs: { 'aria-hidden': 'true' } });
  const label = h('span', { class: 'ui-meter__label' }, labelLong, labelShort);
  const el = h('div', { class: 'ui-meter', role: 'img', attrs: { 'aria-label': title } }, label, bar, pct, reset);
  return { el, bar, pct, reset, resetLong, resetShort, labelLong, labelShort };
}

function setMeterLabels(m: Meter, long: string, short: string): void {
  setText(m.labelLong, long);
  setText(m.labelShort, short);
}

/** Passo a passo Cursor (dica do cartão). */
export function createCursorUsageSetup(): HTMLElement {
  return h(
    'ol',
    { class: 'ui-usage-setup' },
    ...CURSOR_USAGE_SETUP_STEPS.map(([cmd, text]) =>
      h('li', {}, h('code', { class: 'ui-usage-setup__cmd', text: cmd }), h('span', {}, ...richText(text))),
    ),
  );
}

function updateMeter(m: Meter, view: UsageWindowView | null, windowName: string): void {
  if (!view || view.pct === null) {
    setVariant(m.el, 'is-', 'none');
    m.el.classList.remove('is-zero');
    m.el.classList.toggle('is-renewed', !!view?.renewed);
    setStyleVar(m.bar, '--pct', '0');
    setText(m.pct, '—');
    setText(m.resetLong, view?.renewed ? '↻ renovada' : '');
    setText(m.resetShort, '');
    const text = view ? `${windowName}: ${view.summary}` : `${windowName}: sem dados`;
    setAttr(m.el, 'aria-label', text);
    setTitle(m.el, view?.renewed ? `${windowName}: a janela já renovou depois da última leitura; o uso atual é desconhecido.` : text);
    return;
  }
  const p = view.pct;
  m.el.classList.remove('is-renewed');
  setVariant(m.el, 'is-', usageLevel(p));
  m.el.classList.toggle('is-zero', p === 0);
  setStyleVar(m.bar, '--pct', String(p));
  setText(m.pct, `${p}%`);
  setText(m.resetLong, view.reset ? `↻ ${view.reset}` : '');
  setText(m.resetShort, view.resetShort ? `↻${view.resetShort}` : '');
  setAttr(m.el, 'aria-label', `${windowName}: ${view.summary}`);
  setTitle(m.el, `${windowName}: ${view.summary}`);
}

function syncRows(dl: HTMLElement, rows: [string, string][]): void {
  while (dl.children.length > rows.length * 2) dl.lastElementChild!.remove();
  rows.forEach(([k, v], i) => {
    let dt = dl.children[i * 2] as HTMLElement | undefined;
    let dd = dl.children[i * 2 + 1] as HTMLElement | undefined;
    if (!dt || !dd) {
      dt = h('dt');
      dd = h('dd');
      dl.append(dt, dd);
    }
    setText(dt, k);
    setText(dd, v);
  });
}

/** Passo a passo para ligar o uso (dica do cartão e ajuda). */
export function createUsageSetup(): HTMLElement {
  return h(
    'ol',
    { class: 'ui-usage-setup' },
    ...USAGE_SETUP_STEPS.map(([cmd, text]) => h('li', {}, h('code', { class: 'ui-usage-setup__cmd', text: cmd }), h('span', {}, ...richText(text)))),
  );
}

/** ok/stale: números recentes/antigos; empty: sem números; noquota: Codex sem cota nem créditos (nunca 0%). */
export type CardState = 'ok' | 'stale' | 'empty' | 'noquota';

function hasWindows(a: Pick<AccountInfo, 'usage'>): boolean {
  return !!a.usage && !!(a.usage.fiveHour || a.usage.sevenDay);
}

/** Estado efetivo do cartão. */
export function cardState(a: Pick<AccountInfo, 'usage' | 'usageStatus'>): CardState {
  // "Sem cota" vem antes: a leitura não traz janelas, mas não é "sem dados".
  if (a.usage?.noQuota) return 'noquota';
  // Leitura sem nenhuma das janelas (ex.: cache do /usage sem números) vale como "sem dados".
  if (!hasWindows(a)) return 'empty';
  return a.usageStatus === 'ok' ? 'ok' : 'stale';
}

/** A idade dos números fica sempre à mostra? (Codex: só se renovam enquanto alguma sessão roda.) */
export function showsUsageAge(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>): boolean {
  if (!a.usage) return false;
  const state = cardState(a);
  return state === 'stale' || (isCodex(a) && state !== 'empty');
}

/** Linha embaixo do nome: e-mail; no Codex (sem e-mail), o plano; nas outras, a pasta. */
export function usageSubtitle(a: Pick<AccountInfo, 'email' | 'plan' | 'configDir' | 'provider'>): string {
  if (a.email) return a.email;
  if (isCodex(a)) return a.plan ? `plano ${a.plan}` : 'Codex';
  if (isCursor(a)) return a.plan ? `plano ${a.plan}` : 'Cursor';
  return a.configDir;
}

/** Mensagem no lugar das barras (estados sem números): [longa, curta]. */
export function usageMessage(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>): [string, string] {
  const state = cardState(a);
  if (state === 'noquota') return ['sem cota', 'sem cota'];
  if (isCodex(a) || isCursor(a)) return ['sem dados ainda', 'sem dados'];
  return ['sem dados de uso', 'sem dados'];
}

/** Explicação do cartão Cursor (dica); '' nas outras. */
export function cursorUsageNote(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>, now: number): string {
  if (!isCursor(a)) return '';
  const u = a.usage;
  const state = cardState(a);
  if (state === 'empty')
    return 'Faça `agent login` no host do Habblaud. Os números vêm da API do plano (Cursor Models e Other Models).';
  const age = u ? relativeTime(u.fetchedAt, now) : '';
  return `Uso do plano Cursor (última leitura ${age}): Cursor Models e Other Models, como no dashboard Spending.`;
}

/** Explicação do cartão de uma conta do Codex (dica); '' nas outras. */
export function codexUsageNote(a: Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider'>, now: number): string {
  if (!isCodex(a)) return '';
  const u = a.usage;
  const state = cardState(a);
  if (state === 'empty') return 'Não precisa instalar nada: os números chegam com a próxima sessão do Codex.';
  const age = u ? relativeTime(u.fetchedAt, now) : '';
  if (state === 'noquota')
    return `Na última leitura (${age}), a conta estava sem cota nem créditos para usar (ex.: os créditos do workspace acabaram). Não é 0%: o Codex não informou as janelas. Os números voltam com a próxima sessão.`;
  return `O Codex só grava o uso enquanto alguma sessão roda: estes números são da última leitura (${age}).`;
}

export class UsageCards {
  readonly el: HTMLElement;
  private list: KeyedList<AccountInfo>;
  private refs = new WeakMap<HTMLElement, CardRefs>();

  constructor(private ctx: UiContext) {
    this.el = h('div', { class: 'ui-usage', role: 'group', attrs: { 'aria-label': 'Uso por conta' } });
    this.list = new KeyedList<AccountInfo>(this.el, {
      key: (a) => a.id,
      create: () => this.createCard(),
      update: (el, a) => this.updateCard(el, a),
    });
  }

  render(): void {
    const accounts = this.ctx.store.snapshot?.accounts ?? [];
    this.list.sync(accounts);
    this.el.classList.toggle('is-empty', accounts.length === 0);
    setStyleVar(this.el, '--count', String(accounts.length));
  }

  private createCard(): HTMLElement {
    const tipId = `ui-usage-tip-${++tipSeq}`;
    const chip = createAccountChip('lg');
    const flag = h('span', { class: 'ui-usage-card__flag', hidden: true, attrs: { 'aria-hidden': 'true' } });
    flag.innerHTML = ICONS.clock;
    const name = h('span', { class: 'ui-usage-card__name' });
    const prov = createProviderTag('ui-prov--xs');
    const email = h('span', { class: 'ui-usage-card__email' });
    const stateIcon = h('span', { class: 'ui-usage-card__state-icon', attrs: { 'aria-hidden': 'true' } });
    stateIcon.innerHTML = ICONS.clock;
    const stateText = h('span');
    const state = h('span', { class: 'ui-usage-card__state' }, stateIcon, stateText);
    const five = createMeter('5h', '5h', 'Sessão de 5 horas');
    const week = createMeter('Semana', 'Sem.', 'Limite semanal');
    const meters = h('div', { class: 'ui-usage-card__meters' }, five.el, week.el);
    const msgLong = h('span', { class: 'ui-usage-card__msg-long', text: 'sem dados de uso' });
    const msgShort = h('span', { class: 'ui-usage-card__msg-short', text: 'sem dados', attrs: { 'aria-hidden': 'true' } });
    const howLong = h('span', { class: 'ui-usage-card__how-long', text: 'Como ativar' });
    const howShort = h('span', { class: 'ui-usage-card__how-short', text: 'Ativar', attrs: { 'aria-hidden': 'true' } });
    const howBtn = h(
      'button',
      {
        class: 'ui-usage-card__how',
        type: 'button',
        title: 'Como mostrar o uso desta conta (abre a ajuda em “Contas e uso”)',
        on: { click: () => this.ctx.openHelp(howBtn.dataset.help === 'codex' ? 'codex' : 'usage') },
      },
      howLong,
      howShort,
    );
    const msg = h('div', { class: 'ui-usage-card__msg' }, h('span', { class: 'ui-usage-card__msg-text' }, msgLong, msgShort), howBtn);
    const tipTitle = h('div', { class: 'ui-usage-tip__title' });
    const tipRows = h('dl', { class: 'ui-kv' });
    const tipNote = h('p', { class: 'ui-usage-tip__note' });
    const tipSetup = h(
      'div',
      { class: 'ui-usage-tip__setup' },
      h('p', { class: 'ui-usage-tip__setup-title', text: 'Como ter o uso ao vivo' }),
      createUsageSetup(),
    );
    const tip = h('div', { class: 'ui-usage-tip', role: 'tooltip', attrs: { id: tipId } }, tipTitle, tipRows, tipNote, tipSetup);
    const card = h(
      'div',
      { class: 'ui-usage-card', tabIndex: 0, attrs: { 'aria-describedby': tipId } },
      chip,
      flag,
      h('div', { class: 'ui-usage-card__body' }, h('div', { class: 'ui-usage-card__head' }, name, prov, email, state), meters, msg),
      tip,
    );
    this.refs.set(card, {
      chip,
      flag,
      name,
      prov,
      email,
      state,
      stateText,
      meters,
      five,
      week,
      msg,
      msgLong,
      msgShort,
      how: howBtn,
      howLong,
      howShort,
      tip,
      tipTitle,
      tipRows,
      tipNote,
      tipSetup,
    });
    return card;
  }

  private updateCard(card: HTMLElement, a: AccountInfo): void {
    const r = this.refs.get(card)!;
    const now = this.ctx.now();
    const codex = isCodex(a);
    const cursor = isCursor(a);
    const provider = providerOf(a);
    updateAccountChip(r.chip, a);
    setStyleVar(card, '--acc', a.color);
    setText(r.name, a.name);
    updateProviderTag(r.prov, provider, a.name);
    setText(r.email, usageSubtitle(a));
    const provSuffix = codex ? ' (Codex)' : cursor ? ' (Cursor)' : '';
    setAttr(card, 'aria-label', `${a.name}${provSuffix}: uso do plano`);

    const usage = a.usage;
    const state = cardState(a);
    setVariant(card, 'is-', state);
    const firstWindowMs = cursor ? BILLING_CYCLE_MS : FIVE_HOURS_MS;
    const secondWindowMs = cursor ? BILLING_CYCLE_MS : WEEK_MS;
    const five = usage ? usageWindowView(usage.fiveHour, usage.fetchedAt, now, firstWindowMs) : null;
    const week = usage ? usageWindowView(usage.sevenDay, usage.fetchedAt, now, secondWindowMs) : null;
    const firstName = cursor ? 'Cursor' : 'Sessão de 5 horas';
    const secondName = cursor ? 'Others' : 'Semana';
    setMeterLabels(r.five, cursor ? 'Cursor' : '5h', cursor ? 'Cursor' : '5h');
    setMeterLabels(r.week, cursor ? 'Others' : 'Semana', cursor ? 'Others' : 'Sem.');
    const showMeters = hasWindows(a);
    setHidden(r.meters, !showMeters);
    if (usage && showMeters) {
      updateMeter(r.five, five, firstName);
      updateMeter(r.week, week, secondName);
    }
    r.meters.classList.toggle('is-dim', state !== 'ok');

    // Idade dos números antigos no cabeçalho (no celular, um selo no chip faz esse papel). No Codex a idade fica
    // sempre à mostra (os números só se renovam enquanto alguma sessão roda), discreta enquanto são recentes.
    const stale = state === 'stale';
    const showAge = showsUsageAge(a);
    setHidden(r.state, !showAge);
    setHidden(r.flag, !stale);
    r.state.classList.toggle('is-fresh', showAge && a.usageStatus === 'ok');
    if (showAge && usage) {
      const age = relativeTime(usage.fetchedAt, now);
      setText(r.stateText, age);
      setTitle(
        r.state,
        codex
          ? `Atualizado ${age}: o Codex só grava o uso enquanto alguma sessão roda.`
          : cursor
            ? `Atualizado ${age}: uso do plano Cursor (API do CLI).`
            : `Números de ${age}: podem não refletir o uso atual.`,
      );
    }

    // Sem números: "sem dados de uso" + "Como ativar" (no Codex/Cursor, "Como funciona"). Sem cota: mensagem, sem botão.
    const [msgLong, msgShort] = usageMessage(a);
    setText(r.msgLong, msgLong);
    setText(r.msgShort, msgShort);
    setHidden(r.msg, state !== 'empty' && state !== 'noquota');
    setHidden(r.how, state === 'noquota');
    r.msg.classList.toggle('is-noquota', state === 'noquota');
    setTitle(r.msg, state === 'noquota' ? codexUsageNote(a, now) : '');
    const howAlt = codex || cursor;
    setText(r.howLong, howAlt ? 'Como funciona' : 'Como ativar');
    setText(r.howShort, howAlt ? 'Saber' : 'Ativar');
    r.how.dataset.help = codex ? 'codex' : 'usage';
    setTitle(
      r.how,
      codex
        ? 'Como o uso do Codex chega ao Habblaud (abre a ajuda em “Codex”)'
        : cursor
          ? 'Como o uso do Cursor chega ao Habblaud (abre a ajuda em “Contas e uso”)'
          : 'Como mostrar o uso desta conta (abre a ajuda em “Contas e uso”)',
    );
    this.updateTip(r, a, state, five, week, now);
  }

  private updateTip(r: CardRefs, a: AccountInfo, state: CardState, five: UsageWindowView | null, week: UsageWindowView | null, now: number): void {
    const codex = isCodex(a);
    const cursor = isCursor(a);
    setText(
      r.tipTitle,
      `${a.name}${codex && !/codex/i.test(a.name) ? ' · Codex' : ''}${cursor && !/cursor/i.test(a.name) ? ' · Cursor' : ''}${a.plan ? ` · plano ${a.plan}` : ''}`,
    );
    const rows: [string, string][] = [];
    if (codex) rows.push(['Ferramenta', 'Codex']);
    if (cursor) rows.push(['Ferramenta', 'Cursor']);
    if (a.email) rows.push(['E-mail', a.email]);
    if (a.organization) rows.push(['Organização', a.organization]);
    if (a.plan) rows.push(['Plano', a.plan]);
    rows.push(['Pasta', a.configDir]);
    rows.push(['Sessões abertas', String(a.sessions)]);
    const u = a.usage;
    if (u && (u.fiveHour || u.sevenDay)) {
      rows.push([cursor ? 'Cursor' : 'Sessão de 5 h', five?.summary ?? '—']);
      rows.push([cursor ? 'Others' : 'Semana', week?.summary ?? '—']);
      // Opus e Sonnet são janelas do Claude: no Codex/Cursor não existem.
      const opus = codex || cursor ? null : usageWindowView(u.sevenDayOpus, u.fetchedAt, now, WEEK_MS);
      const sonnet = codex || cursor ? null : usageWindowView(u.sevenDaySonnet, u.fetchedAt, now, WEEK_MS);
      if (opus) rows.push(['Opus (semana)', opus.summary]);
      if (sonnet) rows.push(['Sonnet (semana)', sonnet.summary]);
    }
    if (u && state === 'noquota') rows.push(['Cota', 'sem cota nem créditos agora']);
    if (u && (state !== 'empty' || codex || cursor)) {
      rows.push(['Origem', sourceLabel(u)]);
      rows.push(['Atualizado', relativeTime(u.fetchedAt, now)]);
    }
    syncRows(r.tipRows, rows);

    if (codex) {
      const note = codexUsageNote(a, now);
      setText(r.tipNote, note);
      setHidden(r.tipNote, !note);
      setHidden(r.tipSetup, true);
      return;
    }

    if (cursor) {
      const note = cursorUsageNote(a, now);
      setText(r.tipNote, note);
      setHidden(r.tipNote, !note);
      r.tipSetup.replaceChildren(
        h('p', { class: 'ui-usage-tip__setup-title', text: 'Como ter o uso do Cursor' }),
        createCursorUsageSetup(),
      );
      setHidden(r.tipSetup, state === 'ok' && u?.source === 'cursor');
      return;
    }

    let note = '';
    if (state === 'empty')
      note = u ? `A última leitura (${sourceLabel(u)}, ${relativeTime(u.fetchedAt, now)}) não trouxe números de 5 h nem da semana.` : 'Ainda não há números de uso para esta conta.';
    else if (state === 'stale') note = 'Números antigos: refletem a última leitura, não o uso de agora.';
    else if (u?.source === 'cache') note = 'Cache do /usage: atualiza quando alguém roda /usage nesta conta.';
    else if (five?.renewed || week?.renewed) note = 'Uma das janelas já reiniciou depois da última leitura.';
    setText(r.tipNote, note);
    setHidden(r.tipNote, !note);
    r.tipSetup.replaceChildren(
      h('p', { class: 'ui-usage-tip__setup-title', text: 'Como ter o uso ao vivo' }),
      createUsageSetup(),
    );
    const live = u?.source === 'statusline' && state === 'ok';
    setHidden(r.tipSetup, live);
  }
}
