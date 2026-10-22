// Cidade dos projetos (botão da barra superior): uma rua por disco (distrito) com um prédio por projeto aberto no
// escritório (shared/projects.ts agrupa as salas; os worktrees entram no prédio do projeto). Clicar num prédio mostra
// no escritório só as salas daquele projeto (WorldApi.setProject); o selo na barra volta a mostrar todas. O tamanho
// dos prédios vem de GET /api/projects (commits e arquivos do git); sem resposta, todos ficam com o tamanho mínimo.
import { groupProjects, sameRoot, type ProjectSize } from '../../../shared/projects';
import { plural } from './format';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, prefersReducedMotion, setAttr, setHidden, setText } from './dom';
import { ICONS, pixelIcon } from './icons';
import { drawStreet, STREET_H, streetBuildings, streetWidth, type StreetBuilding, type StreetHit } from '../world/projects/street';
import { tr } from '../../../shared/i18n';

/** Prédios lado a lado, de alturas diferentes. */
const STREET_ICON = pixelIcon(['.......##.', '.##....##.', '.##.#####.', '.##.#.#.#.', '####.....#', '#..##.#.##', '####.....#', '#..##.#.##', '##########']);
const SIZES_URL = '/api/projects';
const SIZES_TTL_MS = 60_000;
const DISTRICT_COLORS: Record<string, string> = { 'C:': '#5fb3ff', 'D:': '#7be0a4', '/': '#7be0a4' };

/** Resposta de GET /api/projects (o resto é ignorado). */
export function parseProjectSizes(raw: unknown): ProjectSize[] {
  const list = raw && typeof raw === 'object' ? (raw as { projects?: unknown }).projects : undefined;
  if (!Array.isArray(list)) return [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return list.flatMap((o) => (o && typeof o === 'object' && typeof o.root === 'string' ? [{ root: o.root, commits: num(o.commits), files: num(o.files) }] : []));
}

export class ProjectCity implements UiComponent {
  readonly button: HTMLButtonElement;
  readonly el: HTMLElement;
  /** Selo da barra com o prédio aberto (clicar volta ao escritório com todos). */
  readonly chip: HTMLButtonElement;
  private readonly chipName: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly list: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly empty: HTMLElement;
  private district: string | null = null;
  private sizes: ProjectSize[] = [];
  private sizesAt = -Infinity;
  private buildings: StreetBuilding[] = [];
  private hits: StreetHit[] = [];
  private hover: string | null = null;
  private tick = 0;
  private timer = 0;
  private drawn = '';

  constructor(private readonly ctx: UiContext) {
    this.button = iconButton(STREET_ICON, tr('Cidade dos projetos'), () => this.toggle(), 'ui-pcity-btn');
    setAttr(this.button, 'aria-haspopup', 'dialog');
    setAttr(this.button, 'aria-expanded', 'false');

    this.chipName = h('span', { class: 'ui-pcity-chip__name' });
    const chipClose = h('span', { class: 'ui-pcity-chip__x', attrs: { 'aria-hidden': 'true' } });
    chipClose.innerHTML = ICONS.close;
    this.chip = h('button', { class: 'ui-pcity-chip', type: 'button', hidden: true, on: { click: () => this.enter(null) } }, this.chipName, chipClose);

    this.tabs = h('div', { class: 'ui-pcity__tabs', role: 'group', attrs: { 'aria-label': tr('Distritos (discos)') } });
    this.canvas = h('canvas', { class: 'ui-pcity__canvas', attrs: { height: STREET_H, 'aria-hidden': 'true' } });
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    this.canvas.addEventListener('mouseleave', () => this.setHover(null));
    this.canvas.addEventListener('click', (e) => {
      const hit = this.hitAt(e);
      if (hit) this.enter(hit.root);
    });
    this.tip = h('div', { class: 'ui-pcity__tip', hidden: true });
    this.empty = h('p', { class: 'ui-pcity__empty', hidden: true, text: tr('Nenhum projeto aberto agora. Cada pasta onde você abre o Claude Code ou o Codex vira um prédio.') });
    this.list = h('div', { class: 'ui-pcity__list', attrs: { 'aria-label': tr('Prédios do distrito') } });

    const close = iconButton(ICONS.close, tr('Fechar cidade dos projetos'), () => this.hide(), 'ui-icon-btn--sm');
    this.el = h(
      'div',
      { class: 'ui-popover ui-pcity', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Cidade dos projetos'), id: 'ui-project-city', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: tr('Cidade dos projetos') }), close),
      h('p', { class: 'ui-pcity__hint', text: tr('Um prédio por projeto: mais commits, mais andares. Cada janela acesa é uma sessão. Clique num prédio para ver só as salas dele.') }),
      this.tabs,
      h('div', { class: 'ui-pcity__street' }, this.canvas, this.tip),
      this.empty,
      this.list,
    );
    this.el.addEventListener('toggle', () => {
      const open = this.isOpen;
      setAttr(this.button, 'aria-expanded', String(open));
      this.button.classList.toggle('is-on', open);
      this.ctx.root.classList.toggle('has-popover', open);
      if (!open) this.stopAnimation();
    });
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  toggle(): void {
    if (this.isOpen) this.hide();
    else this.show();
  }

  show(): void {
    const r = this.button.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    this.drawn = '';
    this.render();
    void this.loadSizes();
    if (!prefersReducedMotion() && !this.timer)
      this.timer = window.setInterval(() => {
        this.tick++;
        this.draw();
      }, 200);
  }

  hide(): void {
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    this.stopAnimation();
  }

  private stopAnimation(): void {
    clearInterval(this.timer);
    this.timer = 0;
  }

  /** Abre o prédio no escritório (null = todos). */
  private enter(root: string | null): void {
    this.ctx.world.setProject?.(root);
    this.hide();
    const b = root && this.buildings.find((x) => sameRoot(x.root, root));
    this.ctx.announce(b ? tr('Escritório mostrando só o projeto {0}.', [b.name]) : tr('Escritório mostrando todos os projetos.'));
    this.render();
  }

  private async loadSizes(): Promise<void> {
    if (this.ctx.store.mock || performance.now() - this.sizesAt < SIZES_TTL_MS) return;
    this.sizesAt = performance.now();
    try {
      const res = await fetch(SIZES_URL);
      if (!res.ok) throw new Error(String(res.status));
      this.sizes = parseProjectSizes(await res.json());
      this.drawn = '';
      this.render();
    } catch {
      // sem números: os prédios ficam no tamanho mínimo; tenta de novo na próxima abertura
      this.sizesAt = -Infinity;
    }
  }

  render(): void {
    const current = this.ctx.world.getProject?.() ?? null;
    const groups = groupProjects(this.ctx.store.snapshot ?? { rooms: [], agents: [] });
    const open = current ? groups.find((g) => sameRoot(g.root, current)) : undefined;
    setHidden(this.chip, !current);
    if (current) {
      const name = open?.name ?? current.split(/[\\/]+/).filter(Boolean).pop() ?? current;
      setText(this.chipName, tr('Prédio: {0}', [name]));
      this.chip.title = tr('Mostrando só {0}. Clique para ver todos os projetos.', [current]);
    }
    if (!this.isOpen) return;

    const districts = [...new Set(groups.map((g) => g.district))].sort();
    if (!this.district || !districts.includes(this.district)) this.district = (open?.district ?? districts[0]) || null;
    const key = JSON.stringify([districts, this.district, current, groups.map((g) => [g.root, g.sessions]), this.sizes]);
    if (key === this.drawn) return;
    this.drawn = key;

    this.tabs.replaceChildren(
      ...districts.map((d) =>
        h('button', {
          class: 'ui-pcity__tab',
          type: 'button',
          text: d === '/' ? tr('Este computador') : tr('Disco {0}', [d]),
          attrs: { 'aria-pressed': String(d === this.district) },
          on: { click: () => ((this.district = d), (this.drawn = ''), this.render()) },
        }),
      ),
    );
    setHidden(this.tabs, districts.length < 2);

    this.buildings = streetBuildings(groups.filter((g) => g.district === this.district), this.sizes);
    setHidden(this.empty, this.buildings.length > 0);
    setHidden(this.canvas, !this.buildings.length);
    // a rua preenche a janela sem esticar os pixels: a altura é fixa no CSS e a largura acompanha a proporção
    const box = this.canvas.parentElement!;
    const cssH = this.canvas.clientHeight || STREET_H;
    this.canvas.width = streetWidth(this.buildings, Math.floor((box.clientWidth * STREET_H) / cssH));
    this.list.replaceChildren(
      ...this.buildings.map((b) =>
        h('button', {
          class: 'ui-pcity__item',
          type: 'button',
          text: b.name,
          title: b.root,
          attrs: { 'aria-pressed': String(!!current && sameRoot(b.root, current)) },
          on: { click: () => this.enter(b.root) },
        }),
      ),
    );
    this.draw();
  }

  private draw(): void {
    if (!this.buildings.length) return;
    const g = this.canvas.getContext('2d');
    if (!g) return;
    this.hits = drawStreet(g, this.buildings, {
      tick: this.tick,
      hover: this.hover,
      selected: this.ctx.world.getProject?.() ?? null,
      accent: DISTRICT_COLORS[this.district ?? ''] ?? '#c79aff',
    });
  }

  private hitAt(e: MouseEvent): StreetHit | undefined {
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) * this.canvas.width) / r.width;
    const y = ((e.clientY - r.top) * this.canvas.height) / r.height;
    return this.hits.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  }

  private setHover(root: string | null): void {
    if (root === this.hover) return;
    this.hover = root;
    this.canvas.classList.toggle('is-pointer', !!root);
    setHidden(this.tip, !root);
    this.draw();
  }

  private onMove(e: MouseEvent): void {
    const hit = this.hitAt(e);
    this.setHover(hit?.root ?? null);
    const b = hit && this.buildings.find((x) => x.root === hit.root);
    if (!hit || !b) return;
    const size = b.commits !== null ? plural(b.commits, tr('commit'), tr('commits')) : b.files !== null ? plural(b.files, tr('arquivo'), tr('arquivos')) : tr('sem git');
    setText(this.tip, `${b.name} · ${tr('{0} andares', [String(b.floors)])} · ${size} · ${plural(b.windows.length, tr('sessão'), tr('sessões'))}`);
    const r = this.canvas.getBoundingClientRect();
    const box = this.canvas.parentElement!.getBoundingClientRect();
    this.tip.style.left = `${e.clientX - box.left + this.canvas.parentElement!.scrollLeft}px`;
    this.tip.style.top = `${(hit.y * r.height) / this.canvas.height}px`;
  }
}
