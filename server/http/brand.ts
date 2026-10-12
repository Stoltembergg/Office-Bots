// Marca customizada: PNGs em <pasta de dados>/brand/ substituem os do Habblaud sem recompilar.
//
//   logo.png     -> ícone da barra superior e da abertura, favicons e ícones do app
//   signage.png  -> placa da recepção (opcional; sem ele, a placa usa logo.png)
//
// Só os nomes do mapa abaixo são atendidos; qualquer outro pedido segue para o cliente padrão.
// O arquivo é lido a cada pedido (com ETag), então trocar o PNG vale no próximo recarregar da página.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileStat, REVALIDATE, sendFile } from './static';

const LOGO = ['logo.png'];
const SIGNAGE = ['signage.png', 'logo.png'];

/** Arquivo pedido em /assets/brand/ -> arquivos da pasta de marca, em ordem de preferência. */
export const BRAND_FILES: Readonly<Record<string, readonly string[]>> = {
  'logo-mark.png': LOGO,
  'logo-mark@4x.png': LOGO,
  'logo-detailed.png': LOGO,
  'favicon-16.png': LOGO,
  'favicon-32.png': LOGO,
  'apple-touch-icon.png': LOGO,
  'icon-192.png': LOGO,
  'icon-512.png': LOGO,
  'signage.png': SIGNAGE,
  'signage@4x.png': SIGNAGE,
};

const PREFIX = '/assets/brand/';

/** Atende o pedido com a marca customizada, se houver; devolve false para seguir ao cliente padrão. */
export function createBrandHandler(dataDir: string): (req: IncomingMessage, res: ServerResponse, pathname: string) => boolean {
  const dir = join(dataDir, 'brand');
  return (req, res, pathname) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (!pathname.startsWith(PREFIX)) return false;
    const candidates = BRAND_FILES[pathname.slice(PREFIX.length)];
    if (!candidates) return false;
    for (const name of candidates) {
      const file = join(dir, name);
      const st = fileStat(file);
      if (st) {
        sendFile(req, res, file, st, REVALIDATE);
        return true;
      }
    }
    return false;
  };
}
