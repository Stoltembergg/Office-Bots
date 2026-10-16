import { describe, expect, it } from 'vitest';
import { PasteService, parsePaste } from './paste';

const png = { name: 'print.png', type: 'image/png', data: Buffer.from('imagem de teste').toString('base64') };

describe('parsePaste', () => {
  it('aceita só imagens', () => {
    expect(parsePaste(png)).toMatchObject({ name: 'print.png', type: 'image/png' });
    expect(parsePaste({ ...png, type: 'application/pdf' })).toHaveProperty('error');
    expect(parsePaste({ ...png, data: '' })).toHaveProperty('error');
  });
});

describe('PasteService', () => {
  it('no Docker, sem o auxiliar visto, fica indisponível', () => {
    const s = new PasteService();
    expect(s.available()).toBe(false);
    expect(s.submit(png)).toMatchObject({ error: 'unavailable' });
  });

  it('entrega a imagem ao auxiliar uma vez e guarda o caminho do ack', () => {
    let t = 0;
    const s = new PasteService({ now: () => t, newId: () => 'p1' });
    s.poll();
    const r = s.submit(png);
    expect(r).toMatchObject({ paste: { id: 'p1', status: 'queued' } });
    const list = s.poll();
    expect(list).toEqual([{ id: 'p1', name: 'print.png', type: 'image/png', data: png.data }]);
    expect(s.poll()).toEqual([]);
    s.ack({ results: [{ id: 'p1', ok: true, path: 'C:\\x\\print.png' }] });
    expect(s.get('p1')).toEqual({ id: 'p1', status: 'done', path: 'C:\\x\\print.png' });
    t += 6 * 60_000;
    expect(s.get('p1')).toBeUndefined();
  });

  it('falha quando o auxiliar não busca a tempo', () => {
    let t = 0;
    const s = new PasteService({ now: () => t, newId: () => 'p1' });
    s.poll();
    s.submit(png);
    t += 31_000;
    expect(s.get('p1')).toMatchObject({ status: 'failed' });
  });

  it('no modo Node grava na hora', () => {
    const s = new PasteService({ write: (id, f) => `/tmp/${id}/${f.name}`, newId: () => 'p1' });
    s.submit(png);
    expect(s.get('p1')).toEqual({ id: 'p1', status: 'done', path: '/tmp/p1/print.png' });
  });
});
