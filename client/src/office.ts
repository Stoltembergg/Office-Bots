import '@fontsource/pixelify-sans/400.css';
import * as art from './art';
import { pixelText, pixelTextWidth } from './art/pixelfont';
import { TILE, type FurnitureKind, type Sprite } from './art/api';
import { readPullRequestPickerResponse, type PullRequestPickerItem } from './office-pull-requests';
import { readPreparedReviewInputResponse } from './office-review-input';
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

interface RepositoryPickerItem {
  readonly repositoryId: string;
  readonly fullName: string;
  readonly isPrivate: boolean;
  readonly defaultBranch: string | null;
  readonly htmlUrl: string;
  readonly isSelected: boolean;
}

function readRepositoryPickerItems(value: unknown): RepositoryPickerItem[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid repository response');
  const repositories = (value as { repositories?: unknown }).repositories;
  if (!Array.isArray(repositories) || repositories.length > 10_000) throw new Error('Invalid repository response');
  const seen = new Set<string>();
  let selectedCount = 0;
  const result: RepositoryPickerItem[] = [];
  for (const item of repositories) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('Invalid repository response');
    const repository = item as Record<string, unknown>;
    if (
      typeof repository.repositoryId !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(repository.repositoryId) ||
      seen.has(repository.repositoryId) ||
      typeof repository.fullName !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository.fullName) ||
      typeof repository.isPrivate !== 'boolean' ||
      (repository.defaultBranch !== null &&
        (typeof repository.defaultBranch !== 'string' || repository.defaultBranch.length > 255)) ||
      repository.htmlUrl !== `https://github.com/${repository.fullName}` ||
      typeof repository.isSelected !== 'boolean'
    ) {
      throw new Error('Invalid repository response');
    }
    if (repository.isSelected) selectedCount += 1;
    seen.add(repository.repositoryId);
    result.push(repository as unknown as RepositoryPickerItem);
  }
  if (selectedCount > 1) throw new Error('Invalid repository response');
  return result;
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
          <select class="repo-picker" id="repo-picker" aria-label="${tr('Selecionar repositório')}" disabled>
            <option value="">${tr('Nenhum repositório conectado')}</option>
          </select>
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
              <div class="pull-request-control" id="pull-request-control" hidden>
                <label for="pull-request-picker">${tr('Pull request aberto')}</label>
                <div class="pull-request-actions">
                  <select class="pull-request-picker" id="pull-request-picker" disabled>
                    <option value="">${tr('Selecione um pull request')}</option>
                  </select>
                  <button class="pull-request-refresh" id="pull-request-refresh" type="button">${tr('Atualizar PRs')}</button>
                </div>
                <button class="pull-request-prepare" id="pull-request-prepare" type="button" disabled>${tr('Preparar entrada somente leitura')}</button>
                <p class="pull-request-note" id="pull-request-note" role="status" aria-live="polite">${tr('Selecione um repositório para ver os PRs abertos.')}</p>
                <p class="pull-request-note prepared-input-note" id="prepared-input-note" role="status" aria-live="polite" hidden></p>
                <ul class="prepared-input-files" id="prepared-input-files" hidden></ul>
              </div>
              <div class="setup-note">
                <span class="setup-number">01</span>
                <div class="setup-copy">
                  <p id="github-app-note">${tr('Conecte o GitHub para preparar seu espaço de revisão.')}</p>
                  <div class="setup-actions">
                    <a class="setup-action" id="github-app-action" href="/api/github/app/authorize" hidden>${tr('Conectar GitHub App')}</a>
                    <a class="setup-action secondary" id="github-install-action" href="/api/github/app/install" hidden>${tr('Instalar GitHub App')}</a>
                  </div>
                </div>
                <span class="setup-arrow" aria-hidden="true">↗</span>
              </div>
            </section>
          </aside>
        </div>

        <footer class="workspace-note"><span class="note-icon" aria-hidden="true">i</span><p>${tr('A lista mostra repositórios acessíveis pela GitHub App e seus PRs abertos. O Office pode preparar a entrada somente leitura de um PR; análise e criação de PRs seguem em desenvolvimento.')}</p></footer>
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
  const repositoryPicker = document.querySelector<HTMLSelectElement>('#repo-picker')!;
  const appAction = document.querySelector<HTMLAnchorElement>('#github-app-action')!;
  const installAction = document.querySelector<HTMLAnchorElement>('#github-install-action')!;
  const appNote = document.querySelector<HTMLParagraphElement>('#github-app-note')!;
  const pullRequestControl = document.querySelector<HTMLDivElement>('#pull-request-control')!;
  const pullRequestPicker = document.querySelector<HTMLSelectElement>('#pull-request-picker')!;
  const pullRequestRefresh = document.querySelector<HTMLButtonElement>('#pull-request-refresh')!;
  const pullRequestPrepare = document.querySelector<HTMLButtonElement>('#pull-request-prepare')!;
  const pullRequestNote = document.querySelector<HTMLParagraphElement>('#pull-request-note')!;
  const preparedInputNote = document.querySelector<HTMLParagraphElement>('#prepared-input-note')!;
  const preparedInputFiles = document.querySelector<HTMLUListElement>('#prepared-input-files')!;
  let currentRepositories: RepositoryPickerItem[] = [];
  let currentPullRequests: PullRequestPickerItem[] = [];
  let pullRequestLoadSequence = 0;
  let preparedInputSequence = 0;
  const installationRequired = new URLSearchParams(window.location.search).get('github') === 'install-required';
  const showNotice = (message: string): void => {
    authNotice.textContent = message;
    authNotice.hidden = false;
  };

  function clearPreparedInput(): void {
    preparedInputSequence += 1;
    preparedInputNote.hidden = true;
    preparedInputNote.textContent = '';
    preparedInputFiles.hidden = true;
    preparedInputFiles.replaceChildren();
  }

  const query = new URLSearchParams(window.location.search);
  const loginResult = query.get('login');
  const githubResult = query.get('github');
  if (loginResult === 'success') {
    showNotice(tr('Login concluído. Conecte o GitHub App para carregar os repositórios autorizados.'));
  } else if (loginResult === 'cancelled') {
    showNotice(tr('Login cancelado.'));
  } else if (loginResult === 'failed') {
    showNotice(tr('Não foi possível concluir o login. Tente novamente.'));
  } else if (loginResult === 'logged-out') {
    showNotice(tr('Sessão encerrada.'));
  }
  if (githubResult === 'connected') {
    showNotice(tr('GitHub App conectado. Repositórios autorizados atualizados.'));
  } else if (githubResult === 'install-required') {
    showNotice(tr('Não há uma instalação do GitHub App para esta conta. Instale o app e atualize a lista.'));
  } else if (githubResult === 'cancelled') {
    showNotice(tr('Autorização do GitHub App cancelada.'));
  } else if (githubResult === 'failed') {
    showNotice(tr('Não foi possível sincronizar repositórios. Tente novamente.'));
  } else if (githubResult === 'login-required') {
    showNotice(tr('Entre com GitHub para conectar uma instalação.'));
  }
  if (loginResult || githubResult) history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);

  function renderRepositories(value: unknown): void {
    const repositories = readRepositoryPickerItems(value);
    pullRequestLoadSequence += 1;
    clearPreparedInput();
    pullRequestPrepare.disabled = true;
    currentRepositories = repositories;
    repositoryPicker.replaceChildren();
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = repositories.length ? tr('Selecione um repositório') : tr('Nenhum repositório conectado');
    repositoryPicker.append(emptyOption);
    for (const repository of repositories) {
      const option = document.createElement('option');
      option.value = repository.repositoryId;
      option.textContent = repository.fullName;
      option.selected = repository.isSelected;
      repositoryPicker.append(option);
    }
    repositoryPicker.disabled = repositories.length === 0;
    appAction.textContent = repositories.length ? tr('Atualizar repositórios') : tr('Conectar GitHub App');
    const hasSelectedRepository = repositories.some((repository) => repository.isSelected);
    pullRequestControl.hidden = !hasSelectedRepository;
    if (!hasSelectedRepository) {
      currentPullRequests = [];
      pullRequestPicker.replaceChildren();
      const emptyPullRequest = document.createElement('option');
      emptyPullRequest.value = '';
      emptyPullRequest.textContent = tr('Selecione um pull request');
      pullRequestPicker.append(emptyPullRequest);
      pullRequestPicker.disabled = true;
      pullRequestPrepare.disabled = true;
      pullRequestNote.textContent = tr('Selecione um repositório para ver os PRs abertos.');
    }
  }

  async function loadPullRequests(): Promise<void> {
    const sequence = ++pullRequestLoadSequence;
    clearPreparedInput();
    pullRequestPrepare.disabled = true;
    const repository = currentRepositories.find((item) => item.isSelected);
    if (!repository) {
      pullRequestRefresh.disabled = false;
      return;
    }
    pullRequestControl.hidden = false;
    pullRequestPicker.disabled = true;
    pullRequestRefresh.disabled = true;
    pullRequestNote.textContent = tr('Carregando pull requests abertos…');
    try {
      const response = await fetch('/api/github/pull-requests', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error();
      const result = readPullRequestPickerResponse(await response.json() as unknown, repository.fullName);
      if (sequence !== pullRequestLoadSequence) return;
      currentPullRequests = [...result.pullRequests];
      pullRequestPicker.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = tr('Selecione um pull request');
      pullRequestPicker.append(placeholder);
      for (const pullRequest of currentPullRequests) {
        const option = document.createElement('option');
        option.value = String(pullRequest.number);
        option.textContent = tr('PR #{0} — {1}{2}', [pullRequest.number, pullRequest.title, pullRequest.draft ? ` (${tr('rascunho')})` : '']);
        pullRequestPicker.append(option);
      }
      pullRequestPicker.disabled = currentPullRequests.length === 0;
      pullRequestNote.textContent = currentPullRequests.length === 0
        ? tr('Nenhum PR aberto neste repositório.')
        : result.hasMore
          ? tr('Mostrando os 100 PRs abertos mais recentes. A revisão ainda está em desenvolvimento.')
          : tr('Selecione um PR para preparar a entrada somente leitura.');
    } catch {
      if (sequence !== pullRequestLoadSequence) return;
      currentPullRequests = [];
      pullRequestPicker.replaceChildren();
      const failedOption = document.createElement('option');
      failedOption.value = '';
      failedOption.textContent = tr('Pull requests indisponíveis');
      pullRequestPicker.append(failedOption);
      pullRequestNote.textContent = tr('Não foi possível carregar os pull requests. Tente novamente.');
    } finally {
      if (sequence === pullRequestLoadSequence) pullRequestRefresh.disabled = false;
    }
  }

  async function loadRepositories(): Promise<void> {
    const response = await fetch('/api/github/repositories', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error();
    renderRepositories(await response.json() as unknown);
    await loadPullRequests();
  }

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
        appAction.hidden = false;
        installAction.hidden = !installationRequired;
        appNote.textContent = tr('Autorize o GitHub App para sincronizar os repositórios que você escolheu compartilhar.');
        void loadRepositories().catch(() => {
          appAction.removeAttribute('href');
          appAction.setAttribute('aria-disabled', 'true');
          appAction.title = tr('A integração do GitHub App ainda não está configurada no servidor.');
          appAction.textContent = tr('GitHub App em configuração');
          repositoryPicker.disabled = true;
          showNotice(tr('A integração do GitHub App ainda não está configurada no servidor.'));
        });
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

  repositoryPicker.addEventListener('change', async () => {
    const previous = currentRepositories.find((repository) => repository.isSelected)?.repositoryId ?? '';
    const repositoryId = repositoryPicker.value || null;
    repositoryPicker.disabled = true;
    try {
      const response = await fetch('/api/github/repositories/selected', {
        method: 'PUT',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repositoryId }),
      });
      if (!response.ok) throw new Error();
      renderRepositories(await response.json() as unknown);
      const selected = currentRepositories.find((repository) => repository.isSelected);
      await loadPullRequests();
      showNotice(selected
        ? tr('Repositório selecionado: {0}.', [selected.fullName])
        : tr('Seleção de repositório removida.'));
    } catch {
      repositoryPicker.value = previous;
      showNotice(tr('Não foi possível salvar a seleção do repositório. Tente novamente.'));
    } finally {
      repositoryPicker.disabled = currentRepositories.length === 0;
    }
  });

  pullRequestRefresh.addEventListener('click', () => {
    void loadPullRequests();
  });

  pullRequestPicker.addEventListener('change', () => {
    clearPreparedInput();
    const number = Number(pullRequestPicker.value);
    if (!Number.isSafeInteger(number) || number < 1) {
      pullRequestPrepare.disabled = true;
      pullRequestNote.textContent = tr('Selecione um PR para preparar a entrada somente leitura.');
      return;
    }
    const selected = currentPullRequests.find((pullRequest) => pullRequest.number === number);
    if (selected) {
      pullRequestPrepare.disabled = false;
      pullRequestNote.textContent = tr('PR #{0} selecionado. Preparar a entrada não inicia uma revisão de IA.', [selected.number]);
    } else {
      pullRequestPrepare.disabled = true;
    }
  });

  pullRequestPrepare.addEventListener('click', async () => {
    const number = Number(pullRequestPicker.value);
    const selected = currentPullRequests.find((pullRequest) => pullRequest.number === number);
    if (!selected || !currentRepositories.some((repository) => repository.isSelected)) return;
    const sequence = ++preparedInputSequence;
    pullRequestPrepare.disabled = true;
    preparedInputNote.hidden = false;
    preparedInputNote.textContent = tr('Lendo patches no servidor; nenhuma IA será chamada…');
    preparedInputFiles.hidden = true;
    preparedInputFiles.replaceChildren();
    try {
      const response = await fetch(`/api/github/pull-requests/input?number=${encodeURIComponent(String(number))}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error();
      const result = readPreparedReviewInputResponse(await response.json() as unknown, number);
      if (sequence !== preparedInputSequence) return;
      for (const file of result.files) {
        const item = document.createElement('li');
        item.textContent = file.filename;
        preparedInputFiles.append(item);
      }
      preparedInputFiles.hidden = false;
      preparedInputNote.textContent = tr('Patches lidos apenas em memória no servidor. Integridade e completude não verificadas; nenhuma IA foi chamada.');
    } catch {
      if (sequence !== preparedInputSequence) return;
      preparedInputNote.textContent = tr('Não foi possível preparar a entrada do PR. Tente novamente.');
    } finally {
      if (sequence === preparedInputSequence) pullRequestPrepare.disabled = false;
    }
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
