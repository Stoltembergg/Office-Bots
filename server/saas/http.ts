import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Roteador HTTP mínimo para a futura superfície SaaS. Não abre porta, autentica usuários,
 * autoriza repositórios nem encaminha para o servidor/rotas legadas. A allowlist é fornecida
 * pelo chamador; este módulo não declara endpoints funcionais. A allowlist é somente roteamento
 * e não prova isolamento ou segurança multiusuário.
 */

export type SaasRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface SaasRoute {
  /** Método HTTP exato, em maiúsculas (por exemplo, GET ou POST). */
  readonly method: string;
  /** Caminho absoluto exato, sem query string. Não há suporte a curingas ou parâmetros. */
  readonly path: string;
  readonly handle: SaasRouteHandler;
}

export interface SaasHttpDeps {
  /** Lista explícita de combinações método/caminho que podem ser encaminhadas. */
  readonly routes: readonly SaasRoute[];
}

const METHOD_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ROUTER_ORIGIN = 'http://saas-router.invalid';

function isRouteMethod(method: unknown): method is string {
  return typeof method === 'string' && METHOD_TOKEN.test(method) && method === method.toUpperCase();
}

function isRoutePath(path: unknown): path is string {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\u0000-\u0020\u007f\\%?#]/.test(path) ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return false;
  }

  try {
    return new URL(path, ROUTER_ORIGIN).pathname === path;
  } catch {
    return false;
  }
}

function requestPath(target: string | undefined): string | undefined {
  if (!target || !target.startsWith('/') || target.startsWith('//') || /[\u0000-\u0020\u007f\\#]/.test(target)) {
    return undefined;
  }

  const queryAt = target.indexOf('?');
  const pathname = queryAt === -1 ? target : target.slice(0, queryAt);
  if (!isRoutePath(pathname)) return undefined;

  try {
    const parsed = new URL(target, ROUTER_ORIGIN);
    return parsed.origin === ROUTER_ORIGIN && parsed.pathname === pathname ? pathname : undefined;
  } catch {
    return undefined;
  }
}

function notFound(req: IncomingMessage, res: ServerResponse): void {
  const body = 'Not Found\n';
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function internalError(res: ServerResponse): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.destroy();
    return;
  }

  const body = 'Internal Server Error\n';
  res.writeHead(500, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * Cria apenas um handler Node HTTP. Cookies e demais credenciais não são interpretados: uma rota
 * permitida é encaminhada sem autenticação e qualquer combinação não listada recebe 404.
 */
export function createSaasHttpHandler(deps: SaasHttpDeps): (req: IncomingMessage, res: ServerResponse) => void {
  if (!deps || !Array.isArray(deps.routes)) throw new TypeError('An explicit SaaS route allowlist is required');

  const handlers = new Map<string, SaasRouteHandler>();
  for (const route of deps.routes) {
    if (
      !route ||
      !isRouteMethod(route.method) ||
      !isRoutePath(route.path) ||
      typeof route.handle !== 'function'
    ) {
      throw new TypeError('Invalid SaaS HTTP route');
    }

    const key = `${route.method}\0${route.path}`;
    if (handlers.has(key)) throw new TypeError('Duplicate SaaS HTTP route');
    handlers.set(key, route.handle);
  }

  return (req, res) => {
    const method = req.method;
    const path = requestPath(req.url);
    if (!method || !METHOD_TOKEN.test(method) || !path) {
      notFound(req, res);
      return;
    }

    const handler = handlers.get(`${method}\0${path}`);
    if (!handler) {
      notFound(req, res);
      return;
    }

    try {
      void Promise.resolve(handler(req, res)).catch(() => internalError(res));
    } catch {
      internalError(res);
    }
  };
}
