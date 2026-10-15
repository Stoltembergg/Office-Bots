// Login do modo remoto (servidor com HABBLAUD_PASSWORD): sessão por cookie. Aqui ficam as chamadas /api/auth/*
// e o estado de autenticação da página (lido pela UI para saber se pode responder, mandar mensagens etc.).
// Sem senha no servidor, /api/auth/session responde 404 e nada disso aparece.

export type AuthSession = { required: boolean; authenticated: boolean };
export type LoginResult = 'ok' | 'unauthorized' | 'rate_limited' | 'error';

let state: AuthSession = { required: false, authenticated: false };
const listeners = new Set<() => void>();

/** Estado atual (a cópia: quem lê não altera). */
export function getAuth(): AuthSession {
  return { ...state };
}

export function setAuth(next: AuthSession): void {
  state = { required: next.required, authenticated: next.authenticated };
}

/** Quem quer saber quando o servidor passou a exigir login no meio da sessão (401). */
export function onAuthRequired(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** O servidor respondeu 401: a sessão acabou (ou nunca existiu). Zera `authenticated` e avisa os assinantes. */
export function reportUnauthorized(): void {
  state = { required: true, authenticated: false };
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (err) {
      console.error('[auth] assinante falhou', err);
    }
  }
}

/** GET /api/auth/session. 404 = servidor sem senha (login não é exigido). Outros erros lançam. */
export async function fetchAuthSession(signal?: AbortSignal): Promise<AuthSession> {
  const res = await fetch('/api/auth/session', { signal, cache: 'no-store', credentials: 'same-origin' });
  if (res.status === 404) return { required: false, authenticated: false };
  if (!res.ok) throw new Error(`erro ${res.status}`);
  const body = (await res.json().catch(() => null)) as Partial<AuthSession> | null;
  return { required: body?.required === true, authenticated: body?.authenticated === true };
}

/** POST /api/auth/login. Com sucesso o navegador guarda o cookie e o estado vira autenticado. */
export async function login(password: string): Promise<LoginResult> {
  let res: Response;
  try {
    res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ password }),
    });
  } catch {
    return 'error';
  }
  if (res.ok) {
    state = { required: true, authenticated: true };
    return 'ok';
  }
  if (res.status === 401) return 'unauthorized';
  if (res.status === 429) return 'rate_limited';
  return 'error';
}

/** POST /api/auth/logout (o cookie é apagado pelo servidor). Falha de rede não impede de sair. */
export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // Sem rede: o estado local sai do mesmo jeito.
  }
  state = { required: state.required, authenticated: false };
}
