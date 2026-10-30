import '@fontsource/pixelify-sans/400.css';
import * as art from './art';
import { pixelText, pixelTextWidth } from './art/pixelfont';
import { TILE, type FurnitureKind, type Sprite } from './art/api';
import { getLocale, registerDictionary, tr, type Locale } from '../../shared/i18n';
import './office.css';

const LOADERS: Partial<Record<Locale, () => Promise<Readonly<Record<string, string>>>>> = {
  en: () => import('../../shared/locales/en').then((module) => module.EN),
  es: () => import('../../shared/locales/es').then((module) => module.ES),
  fr: () => import('../../shared/locales/fr').then((module) => module.FR),
};

interface ReviewArea {
  readonly title: () => string;
  readonly description: () => string;
  readonly seed: number;
  readonly tone: string;
}

const WIDTH = 28 * TILE;
const HEIGHT = 17 * TILE;
const REVIEW_AREA_DEFS: readonly ReviewArea[] = [
  { title: () => tr('Segurança'), description: () => tr('Riscos e práticas inseguras.'), seed: 11, tone: 'mint' },
  { title: () => tr('Performance'), description: () => tr('Gargalos e eficiência.'), seed: 29, tone: 'coral' },
  { title: () => tr('Testes'), description: () => tr('Cobertura e casos-limite.'), seed: 47, tone: 'yellow' },
  { title: () => tr('Design'), description: () => tr('Usabilidade e consistência.'), seed: 63, tone: 'blue' },
];

function renderPage(): void {
  const areas = REVIEW_AREA_DEFS.map((area) => ({ ...area, title: area.title(), description: area.description() }));
  const areaRows = areas.map((area) => `
    <li class="agent-row ${area.tone}">
      <canvas class="agent-avatar" data-avatar-seed="${area.seed}" width="40" height="40" aria-hidden="true"></canvas>
      <div class="agent-copy"><h3>${area.title}</h3><p>${area.description}</p></div>
      <span class="agent-waiting" role="img" aria-label="${tr('Aguardando repositório')}"></span>
    </li>`).join('');

  document.title = tr('Office Bots — escritório de revisão de código');
  document.documentElement.lang = getLocale();
  document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute(
    'content',
    tr('Office Bots: escritório para acompanhar revisões GitHub por segurança, performance, testes e design.'),
  );
  document.querySelector<HTMLDivElement>('#office-app')!.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <a class="brand" href="/" aria-label="${tr('Office Bots, início')}"><span class="brand-mark" aria-hidden="true">▦</span><span>office<span class="brand-accent">bots</span></span></a>
        <div class="topbar-context"><span>${tr('Espaço de trabalho')}</span><b aria-hidden="true">/</b><strong>${tr('Escritório')}</strong></div>
        <div class="topbar-actions">
          <button class="repo-picker" id="repo-picker" type="button" disabled title="${tr('A instalação do GitHub App ainda está em construção.')}">
            <span class="github-mark" aria-hidden="true">GH</span><span id="repo-picker-label">${tr('Nenhum repositório conectado')}</span><span class="picker-chevron" aria-hidden="true">⌄</span>
          </button>
          <a class="auth-button" id="auth-action" href="/api/auth/github/start">${tr('Entrar com GitHub')}</a>
          <button class="auth-button logout-button" id="logout-action" type="button" hidden>${tr('Sair')}</button>
        </div>
      </header>

      <p class="auth-notice" id="auth-notice" role="status" aria-live="polite" hidden></p>

      <main class="workspace">
        <section class="page-heading" aria-labelledby="page-title">
          <div>
            <p class="eyebrow"><span class="eyebrow-mark" aria-hidden="true">✳</span>${tr('ESCRITÓRIO DE REVISÃO')}</p>
            <h1 id="page-title">${tr('Seu escritório')}</h1>
            <p class="page-description">${tr('Quatro perspectivas para entender melhor cada mudança no seu repositório.')}</p>
          </div>
          <div class="status-card"><span class="status-indicator" aria-hidden="true"></span><div><strong>${tr('Aguardando repositório')}</strong><span>${tr('Nenhuma revisão está em andamento.')}</span></div></div>
        </section>

        <div class="dashboard-grid">
          <section class="panel room-panel" aria-labelledby="room-title">
            <header class="panel-heading room-heading">
              <div><p class="section-kicker">${tr('SALA 01')} <span>—</span> ${tr('Office Bots')}</p><h2 id="room-title">${tr('Sala de revisão')}</h2><p>${tr('Os agentes aguardam um repositório para começar.')}</p></div>
              <span class="room-status"><i aria-hidden="true"></i>${tr('Em espera')}</span>
            </header>
            <div class="scene-frame">
              <canvas id="office-scene" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="${tr('Ilustração do escritório do Office Bots com quatro personagens em suas estações; nenhuma revisão está ativa.')}"></canvas>
              <span class="scene-caption"><i aria-hidden="true"></i>${tr('SEU ESCRITÓRIO')}</span>
            </div>
            <footer class="room-footer">
              <span class="room-footer-label">${tr('ÁREAS DE REVISÃO')}</span>
              <div class="area-legend">${areas.map((area) => `<span class="legend-item ${area.tone}"><i aria-hidden="true"></i>${area.title}</span>`).join('')}</div>
            </footer>
          </section>

          <aside class="side-column">
            <section class="panel team-panel" aria-labelledby="team-title">
              <header class="panel-heading compact-heading"><div><p class="section-kicker">${tr('QUATRO PERSPECTIVAS')}</p><h2 id="team-title">${tr('Equipe de revisão')}</h2></div><span class="team-count">04</span></header>
              <ul class="agent-list">${areaRows}</ul>
            </section>

            <section class="panel activity-panel" aria-labelledby="activity-title">
              <header class="panel-heading compact-heading"><div><p class="section-kicker">${tr('SEU HISTÓRICO')}</p><h2 id="activity-title">${tr('Atividade recente')}</h2></div><span class="activity-mark" aria-hidden="true">↗</span></header>
              <div class="empty-state"><span class="empty-glyph" aria-hidden="true">✳</span><strong>${tr('Seu histórico começa aqui.')}</strong><p>${tr('Quando uma revisão estiver disponível, o progresso e o relatório aparecerão neste espaço.')}</p></div>
              <div class="setup-note"><span class="setup-number">01</span><p>${tr('Conecte o GitHub para preparar seu espaço de revisão.')}</p><span class="setup-arrow" aria-hidden="true">↗</span></div>
            </section>
          </aside>
        </div>

        <footer class="workspace-note"><span class="note-icon" aria-hidden="true">i</span><p>${tr('A instalação do GitHub App, a seleção de repositórios e as revisões estão em desenvolvimento.')}</p></footer>
      </main>
      <footer class="app-footer"><span>${tr('Office Bots')}</span><span>${tr('Seu código, suas escolhas.')}</span><span class="footer-spark" aria-hidden="true">✳</span></footer>
    </div>`;

  drawOfficeScene(document.querySelector<HTMLCanvasElement>('#office-scene')!);
  drawAgentAvatars();
  wireAuthentication();
}

function blit(ctx: CanvasRenderingContext2D, sprite: Sprite, x: number, y: number): void {
  ctx.drawImage(sprite.canvas, Math.round(x - sprite.ax), Math.round(y - sprite.ay));
}

function drawFloorFurniture(
  ctx: CanvasRenderingContext2D,
  kind: FurnitureKind,
  tileX: number,
  tileY: number,
  variant?: string,
  seed = 0,
): { x: number; y: number } {
  const definition = art.FURNITURE[kind];
  const sprites = art.furnitureSprites(kind, variant, 0, { seed });
  const x = tileX * TILE + (definition.footprint.w * TILE) / 2;
  const y = (tileY + definition.footprint.h) * TILE;
  blit(ctx, sprites.base, x, y);
  if (sprites.front) blit(ctx, sprites.front, x, y);
  return { x, y };
}

function drawWallFurniture(ctx: CanvasRenderingContext2D, kind: FurnitureKind, tileX: number, seed = 0): Sprite {
  const definition = art.FURNITURE[kind];
  const sprite = art.furnitureSprites(kind, undefined, 0, { seed }).base;
  const x = tileX * TILE + (definition.footprint.w * TILE) / 2;
  blit(ctx, sprite, x, 2 * TILE);
  return sprite;
}

function drawOfficeScene(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  const theme = art.roomTheme(0);
  art.drawFloor(ctx, 'carpet', 0, 2 * TILE, WIDTH, HEIGHT - 2 * TILE, { seed: 8, tint: theme.carpet, tint2: theme.carpet2 });
  art.drawRug(ctx, 2 * TILE, 9 * TILE, 24 * TILE, 5 * TILE, '#b6d4c2', 14);
  art.drawWallFace(ctx, 0, 0, WIDTH, theme.wall);

  drawWallFurniture(ctx, 'window', 1, 3);
  drawWallFurniture(ctx, 'whiteboard', 5, 5);
  const sign = drawWallFurniture(ctx, 'sign', 13, 7);
  const signArea = sign.rects?.sign;
  if (signArea) {
    const signAnchorX = 13 * TILE + (3 * TILE) / 2;
    const signTextX = signAnchorX - sign.ax + signArea.x + Math.floor((signArea.w - pixelTextWidth('BOTS')) / 2);
    const signTextY = 2 * TILE - sign.ay + signArea.y + Math.floor((signArea.h - 5) / 2);
    pixelText(ctx, tr('BOTS'), signTextX, signTextY, '#364253');
  }
  drawWallFurniture(ctx, 'clock', 22, 9);
  drawWallFurniture(ctx, 'poster', 25, 11);

  drawFloorFurniture(ctx, 'plant_tall', 0, 3, 'ficus', 11);
  drawFloorFurniture(ctx, 'bookshelf', 1, 6, undefined, 18);
  drawFloorFurniture(ctx, 'plant_tall', 26, 3, 'monstera', 22);
  drawFloorFurniture(ctx, 'printer', 26, 9, undefined, 25);
  drawFloorFurniture(ctx, 'plant_small', 25, 13, 'flower', 17);

  for (let index = 0; index < REVIEW_AREA_DEFS.length; index++) {
    const deskX = 2 + index * 6;
    const chair = drawFloorFurniture(ctx, 'office_chair_front', deskX + 0.5, 8, theme.chairVariant, index + 2);
    const sprite = art.characterSprite({
      appearance: art.appearanceFromSeed(REVIEW_AREA_DEFS[index]!.seed),
      dir: 'down',
      pose: 'sit',
      seated: true,
      frame: 0,
    });
    blit(ctx, sprite, chair.x, chair.y - 3);
    drawFloorFurniture(ctx, 'desk', deskX, 9, theme.deskVariant, index + 3);
  }
}

function drawAgentAvatars(): void {
  for (const canvas of document.querySelectorAll<HTMLCanvasElement>('[data-avatar-seed]')) {
    const seed = Number(canvas.dataset.avatarSeed);
    const avatar = art.avatarCanvas(seed, { scale: 2 });
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(avatar, 0, 0, canvas.width, canvas.height);
  }
}

function wireAuthentication(): void {
  const authAction = document.querySelector<HTMLAnchorElement>('#auth-action')!;
  const logoutAction = document.querySelector<HTMLButtonElement>('#logout-action')!;
  const authNotice = document.querySelector<HTMLParagraphElement>('#auth-notice')!;
  const showNotice = (message: string): void => {
    authNotice.textContent = message;
    authNotice.hidden = false;
  };

  const loginResult = new URLSearchParams(window.location.search).get('login');
  if (loginResult === 'success') {
    showNotice(tr('Login concluído. Para listar repositórios, ainda falta conectar a instalação do GitHub App.'));
  } else if (loginResult === 'cancelled') {
    showNotice(tr('Login cancelado.'));
  } else if (loginResult === 'failed') {
    showNotice(tr('Não foi possível concluir o login. Tente novamente.'));
  } else if (loginResult === 'logged-out') {
    showNotice(tr('Sessão encerrada.'));
  }
  if (loginResult) history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);

  void fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error();
      return await response.json() as unknown;
    })
    .then((session) => {
      if (!session || typeof session !== 'object' || !('authenticated' in session)) throw new Error();
      const value = session as { authenticated?: unknown; githubUserId?: unknown };
      if (value.authenticated === true && typeof value.githubUserId === 'string') {
        authAction.hidden = true;
        logoutAction.hidden = false;
        logoutAction.setAttribute('aria-label', tr('Sair da conta GitHub'));
        showNotice(tr('GitHub conectado: conta {0}.', [value.githubUserId]));
      } else if (value.authenticated === false) {
        authAction.hidden = false;
      }
    })
    .catch(() => {
      authAction.removeAttribute('href');
      authAction.setAttribute('aria-disabled', 'true');
      authAction.tabIndex = -1;
      authAction.title = tr('O login depende da configuração do servidor.');
      authAction.textContent = tr('Login em configuração');
    });

  logoutAction.addEventListener('click', async () => {
    logoutAction.disabled = true;
    try {
      const response = await fetch('/api/logout', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error();
      window.location.assign('/?login=logged-out');
    } catch {
      logoutAction.disabled = false;
      showNotice(tr('Não foi possível encerrar a sessão. Tente novamente.'));
    }
  });
}

async function start(): Promise<void> {
  const locale = getLocale();
  const loader = LOADERS[locale];
  if (loader) {
    try {
      registerDictionary(locale, await loader());
    } catch {
      // A interface continua em português se o dicionário não carregar.
    }
  }
  renderPage();
}

void start();
