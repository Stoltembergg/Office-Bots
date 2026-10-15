// Ponto de entrada do cliente: store (dados) -> mundo (canvas) -> UI (painéis).
import { fetchAuthSession, getAuth, onAuthRequired, setAuth, type AuthSession } from './net/auth';
import { OfficeStore } from './net/store';
import { createWorld } from './world';
import { createUI } from './ui';
import { showLogin } from './ui/login';
import { isLocalHostname } from './ui/permission';
import { migrateLegacyKeys, safeLocalStorage } from './ui/prefs';

// Antes de tudo: o mundo (carteiras) e a UI (preferências) leem o localStorage ao serem criados.
migrateLegacyKeys(safeLocalStorage());

const params = new URLSearchParams(location.search);
const store = new OfficeStore({ mock: params.has('mock') });
const world = createWorld(document.getElementById('world') as HTMLCanvasElement, store);
createUI(document.getElementById('ui') as HTMLElement, store, world);

// Modo remoto (servidor com senha): só conecta depois do login. Quem abre pela própria máquina conecta direto (o
// servidor é quem decide; se responder 401, o login aparece pelo caminho do 401).
let loginOpen = false;
async function requireLogin(expired: boolean): Promise<void> {
  if (loginOpen) return;
  loginOpen = true;
  store.disconnect();
  try {
    await showLogin({ expired });
  } finally {
    loginOpen = false;
  }
  store.reconnectNow();
}

async function boot(): Promise<void> {
  if (store.mock) return store.connect();
  let session: AuthSession = { required: false, authenticated: false };
  try {
    session = await fetchAuthSession();
  } catch {
    // Servidor fora do ar agora: conecta mesmo assim (o store reconecta e o 401, se vier, pede o login).
  }
  setAuth(session);
  onAuthRequired(() => void requireLogin(true));
  if (session.required && !session.authenticated && !isLocalHostname(location.hostname)) {
    loginOpen = true;
    await showLogin();
    loginOpen = false;
  }
  store.connect();
}
void boot();

// Facilita a depuração pelo console do navegador.
Object.assign(window, { habblaud: { store, world, auth: getAuth } });
