import { getLocale, tr } from '../../shared/i18n';
import '@fontsource/pixelify-sans/400.css';
import './preview.css';

const labels = [
  { n: '01', title: tr('Segurança'), icon: '⌑', tone: 'mint', copy: tr('Pontos de atenção que merecem uma segunda olhada.') },
  { n: '02', title: tr('Performance'), icon: '↗', tone: 'coral', copy: tr('Oportunidades para deixar o código mais ágil.') },
  { n: '03', title: tr('Testes'), icon: '✓', tone: 'yellow', copy: tr('Cobertura e casos que podem estar faltando.') },
  { n: '04', title: tr('Design'), icon: '✳', tone: 'blue', copy: tr('Usabilidade, consistência e acabamento visual.') },
];

document.documentElement.lang = getLocale();
document.title = tr('Office Bots — uma revisão mais humana');
document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute(
  'content',
  tr('Office Bots — uma nova forma de revisar repositórios GitHub, em desenvolvimento.'),
);

document.querySelector<HTMLDivElement>('#preview')!.innerHTML = `
  <main>
    <nav class="topbar" aria-label="${tr('Navegação principal')}">
      <a class="brand" href="#top" aria-label="${tr('Office Bots, início')}"><span class="brand-icon" aria-hidden="true">▦</span> office<span>bots</span></a>
      <div class="topbar-actions">
        <span class="preview-tag"><i></i>${tr('Prévia · em desenvolvimento')}</span>
        <a class="auth-button" id="auth-action" href="/api/auth/github/start">${tr('Entrar com GitHub')}</a>
        <button class="auth-button" id="logout-action" type="button" hidden>${tr('Sair')}</button>
      </div>
    </nav>
    <p class="auth-notice" id="auth-notice" role="status" aria-live="polite" hidden></p>
    <section class="hero" id="top" aria-labelledby="headline">
      <div class="hero-copy">
        <p class="eyebrow"><span>✳</span> ${tr('UM NOVO ESCRITÓRIO PARA O CÓDIGO')}</p>
        <h1 id="headline">${tr('Boas revisões\ncomeçam com')} <em>${tr('boas perguntas.')}</em></h1>
        <p class="intro">${tr('Office Bots está sendo criado para ajudar você a revisar repositórios GitHub com mais clareza — e um pouco mais de humanidade.')}</p>
        <a class="down-link" href="#como-funciona"><span aria-hidden="true">↓</span> ${tr('Conheça a ideia')}</a>
      </div>
      <div class="pixel-scene" role="img" aria-label="${tr('Ilustração em pixel art de um pequeno escritório com uma planta e uma tela de código')}">
        <div class="scene-label">${tr('ESCRITÓRIO 01')} <b>✳</b></div>
        <div class="window"><span></span><span></span><span></span><div class="window-lines">▰ ▰ ▰<br> ▰ ▰<br>▰ ▰ ▰ ▰</div></div>
        <div class="plant"><i></i><i></i><i></i><b></b></div>
        <div class="desk"><div class="monitor"><div class="screen"><i></i><i></i><i></i><i></i></div><b></b></div><div class="cup"></div><div class="desk-top"></div><div class="desk-leg"></div></div>
        <div class="scene-note">${tr('UM LUGAR PARA PENSAR MELHOR')}<span>✳</span></div>
        <div class="pixel-spark spark-a">✦</div><div class="pixel-spark spark-b">✳</div>
      </div>
      <div class="hero-index">01 <span>—</span> 04</div>
    </section>
    <section class="workflow" id="como-funciona" aria-labelledby="workflow-title">
      <div class="section-heading"><div><p class="eyebrow">${tr('UMA IDEIA, EM QUATRO OLHARES')}</p><h2 id="workflow-title">${tr('Um repositório.')} <em>${tr('Quatro perspectivas.')}</em></h2></div><p>${tr('A proposta é simples: você escolhe um repositório autorizado e pede uma revisão nas áreas que importam.')}</p></div>
      <ol class="review-grid">${labels.map((item) => `<li class="review-card ${item.tone}"><span class="card-number">${item.n} / 04</span><span class="card-icon" aria-hidden="true">${item.icon}</span><h3>${item.title}</h3><p>${item.copy}</p><span class="card-arrow" aria-hidden="true">↗</span></li>`).join('')}</ol>
      <div class="flowline"><span>${tr('GITHUB')}</span><b></b><span>${tr('SEU REPOSITÓRIO')}</span><b></b><span>${tr('REVISÃO COM CONTEXTO')}</span><b></b><span>${tr('VOCÊ NO COMANDO')}</span></div>
    </section>
    <section class="honest" aria-labelledby="honest-title"><div class="honest-mark" aria-hidden="true">!</div><div><p class="eyebrow">${tr('TRANSPARÊNCIA, DESDE O PRIMEIRO DIA')}</p><h2 id="honest-title">${tr('Ainda estamos')} <em>${tr('construindo.')}</em></h2><p>${tr('Esta página é uma prévia da visão do Office Bots. O login GitHub depende da configuração do servidor; a instalação do GitHub App, a escolha de repositórios e as revisões ainda estão sendo construídas. Não há revisões ou agentes em execução por aqui.')}</p></div><span class="build-stamp">${tr('EM CONSTRUÇÃO')}<br>✳</span></section>
    <footer><a class="brand" href="#top"><span class="brand-icon" aria-hidden="true">▦</span> office<span>bots</span></a><p>${tr('Feito com cuidado. Ainda em desenvolvimento.')}</p><a href="#top" class="back-top">${tr('Voltar ao topo')} ↑</a></footer>
  </main>`;

const authAction = document.querySelector<HTMLAnchorElement>('#auth-action')!;
const logoutAction = document.querySelector<HTMLButtonElement>('#logout-action')!;
const authNotice = document.querySelector<HTMLParagraphElement>('#auth-notice')!;
const showAuthNotice = (message: string): void => {
  authNotice.textContent = message;
  authNotice.hidden = false;
};

const loginResult = new URLSearchParams(window.location.search).get('login');
if (loginResult === 'success') {
  showAuthNotice(tr('Login concluído. Para listar repositórios, ainda falta conectar a instalação do GitHub App.'));
} else if (loginResult === 'cancelled') {
  showAuthNotice(tr('Login cancelado.'));
} else if (loginResult === 'failed') {
  showAuthNotice(tr('Não foi possível concluir o login. Tente novamente.'));
} else if (loginResult === 'logged-out') {
  showAuthNotice(tr('Sessão encerrada.'));
}
if (loginResult) history.replaceState(null, '', `${window.location.pathname}${window.location.hash}`);

void fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' })
  .then(async response => {
    if (!response.ok) throw new Error();
    return await response.json() as unknown;
  })
  .then(session => {
    if (!session || typeof session !== 'object' || !('authenticated' in session)) throw new Error();
    const value = session as { authenticated?: unknown; githubUserId?: unknown };
    if (value.authenticated === true && typeof value.githubUserId === 'string') {
      authAction.hidden = true;
      logoutAction.hidden = false;
      logoutAction.setAttribute('aria-label', tr('Sair da conta GitHub'));
      showAuthNotice(tr('GitHub conectado: conta {0}.', [value.githubUserId]));
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
    showAuthNotice(tr('Não foi possível encerrar a sessão. Tente novamente.'));
  }
});
