import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { BRAND_FILES, createBrandHandler } from './brand';
import { REVALIDATE } from './static';

describe('marca customizada (pasta de dados/brand)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let server: http.Server;
  let base: string;
  let brandDir: string;

  beforeEach(async () => {
    tmp = tempDir();
    brandDir = join(tmp.dir, 'brand');
    const handle = createBrandHandler(tmp.dir);
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (!handle(req, res, url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('padrao');
      }
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
    tmp.cleanup();
  });

  it('sem a pasta, cai no arquivo padrão', async () => {
    const r = await fetch(`${base}/assets/brand/logo-mark.png`);
    expect(await r.text()).toBe('padrao');
  });

  it('logo.png responde pelo ícone, favicons e ícones do app', async () => {
    mkdirSync(brandDir, { recursive: true });
    writeFileSync(join(brandDir, 'logo.png'), 'minha-logo');
    for (const name of ['logo-mark.png', 'logo-mark@4x.png', 'favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'logo-detailed.png']) {
      const r = await fetch(`${base}/assets/brand/${name}`);
      expect(r.status, name).toBe(200);
      expect(r.headers.get('content-type'), name).toBe('image/png');
      expect(r.headers.get('cache-control'), name).toBe(REVALIDATE);
      expect(await r.text(), name).toBe('minha-logo');
    }
  });

  it('a placa usa signage.png; sem ele, usa logo.png', async () => {
    mkdirSync(brandDir, { recursive: true });
    writeFileSync(join(brandDir, 'logo.png'), 'minha-logo');
    expect(await (await fetch(`${base}/assets/brand/signage.png`)).text()).toBe('minha-logo');
    writeFileSync(join(brandDir, 'signage.png'), 'minha-placa');
    expect(await (await fetch(`${base}/assets/brand/signage.png`)).text()).toBe('minha-placa');
    expect(await (await fetch(`${base}/assets/brand/signage@4x.png`)).text()).toBe('minha-placa');
  });

  it('não serve nada fora do mapa (nem tentativas de sair da pasta)', async () => {
    mkdirSync(brandDir, { recursive: true });
    writeFileSync(join(brandDir, 'logo.png'), 'minha-logo');
    writeFileSync(join(tmp.dir, 'segredo.txt'), 'nao');
    for (const path of ['/assets/brand/segredo.txt', '/assets/brand/..%2Fsegredo.txt', '/assets/brand/logo.png', '/assets/manifest.json']) {
      expect(await (await fetch(`${base}${path}`)).text(), path).toBe('padrao');
    }
    expect(Object.keys(BRAND_FILES)).not.toContain('logo.png');
  });

  it('só GET e HEAD', async () => {
    mkdirSync(brandDir, { recursive: true });
    writeFileSync(join(brandDir, 'logo.png'), 'minha-logo');
    const r = await fetch(`${base}/assets/brand/logo-mark.png`, { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe(String('minha-logo'.length));
    const p = await fetch(`${base}/assets/brand/logo-mark.png`, { method: 'POST' });
    expect(await p.text()).toBe('padrao');
  });
});
