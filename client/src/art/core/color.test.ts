// Testes das funções puras de cor: parse, mistura e rampas de sombreado.
import { describe, expect, it } from 'vitest';
import { hslToRgb, luminance, mix, parseColor, ramp, rgbToHsl, shade, toHex } from './color';

const MAGENTA = [255, 0, 255, 255];

describe('parseColor: cores válidas', () => {
  it.each([
    ['#fff', [255, 255, 255, 255]],
    ['#f80', [255, 136, 0, 255]],
    ['#f80a', [255, 136, 0, 170]],
    ['#ff8800', [255, 136, 0, 255]],
    ['#FF8800', [255, 136, 0, 255]],
    ['#ff880080', [255, 136, 0, 128]],
    ['  #FFF  ', [255, 255, 255, 255]],
    ['transparent', [0, 0, 0, 0]],
    ['rgb(255, 136, 0)', [255, 136, 0, 255]],
    ['RGB(1,2,3)', [1, 2, 3, 255]],
    ['rgb(255 136 0 / 50%)', [255, 136, 0, 128]],
    ['rgba(10,20,30,0.5)', [10, 20, 30, 128]],
    ['hsl(0,100%,50%)', [255, 0, 0, 255]],
    ['hsl(120, 100%, 25%)', [0, 128, 0, 255]],
    ['hsla(240,100%,50%,0.5)', [0, 0, 255, 128]],
    ['hsl(0,0%,50%)', [128, 128, 128, 255]],
  ])('%s', (input, expected) => {
    expect(parseColor(input)).toEqual(expected);
  });
});

describe('parseColor: controles malformados existentes', () => {
  it.each(['#12', '#12345', '#', '', 'vermelho', 'rgb(1,2,3'])('%j devolve magenta', (input) => {
    expect(parseColor(input)).toEqual(MAGENTA);
  });
});

describe('parseColor: cor malformada devolve magenta (nunca NaN)', () => {
  it.each([
    '#zzz',
    '#12345g',
    '#ggg',
    '#12g4',
    '#gg8800',
    '#ff8800zz',
    'rgb(a,b,c)',
    'rgb(10,20,30,x)',
    'rgb(Infinity,0,0)',
    'rgb(1e999,0,0)',
    'hsl(x,y,z)',
    'hsl(0,100%,y)',
    'hsla(0,100%,50%,x)',
  ])('%j devolve magenta', (input) => {
    expect(parseColor(input)).toEqual(MAGENTA);
  });

  it('o resultado nunca tem NaN, e toHex dele é um hex válido', () => {
    for (const input of ['#zzz', '#12345g', 'rgb(a,b,c)', 'hsl(x,y,z)']) {
      const [r, g, b, a] = parseColor(input);
      expect([r, g, b, a].every(Number.isFinite)).toBe(true);
      expect(toHex(r, g, b, a)).toBe('#ff00ff');
    }
  });

  it('a mesma entrada inválida dá o mesmo resultado na segunda chamada (cache)', () => {
    expect(parseColor('#zzz')).toEqual(MAGENTA);
    expect(parseColor('#zzz')).toEqual(MAGENTA);
  });
});

describe('toHex', () => {
  it('sem alfa (ou alfa 255) devolve #rrggbb; com alfa menor devolve #rrggbbaa', () => {
    expect(toHex(255, 136, 0)).toBe('#ff8800');
    expect(toHex(255, 136, 0, 255)).toBe('#ff8800');
    expect(toHex(255, 136, 0, 128)).toBe('#ff880080');
  });

  it('limita cada canal a 0–255 e arredonda', () => {
    expect(toHex(300, -5, 127.5)).toBe('#ff0080');
  });
});

describe('rgbToHsl e hslToRgb', () => {
  it('primárias e cinza', () => {
    expect(rgbToHsl(255, 0, 0)).toEqual([0, 1, 0.5]);
    expect(rgbToHsl(0, 255, 0)).toEqual([120, 1, 0.5]);
    expect(rgbToHsl(0, 0, 255)).toEqual([240, 1, 0.5]);
    expect(rgbToHsl(128, 128, 128)[1]).toBe(0);
    expect(hslToRgb(0, 1, 0.5)).toEqual([255, 0, 0]);
    expect(hslToRgb(120, 1, 0.5)).toEqual([0, 255, 0]);
    expect(hslToRgb(240, 1, 0.5)).toEqual([0, 0, 255]);
    expect(hslToRgb(0, 0, 0.5)).toEqual([128, 128, 128]);
  });

  it('a matiz dá a volta: -120 e 480 caem em 240 e 120', () => {
    expect(hslToRgb(-120, 1, 0.5)).toEqual(hslToRgb(240, 1, 0.5));
    expect(hslToRgb(480, 1, 0.5)).toEqual(hslToRgb(120, 1, 0.5));
  });

  it.each([
    [226, 96, 79],
    [74, 134, 216],
    [10, 200, 30],
    [0, 0, 0],
    [255, 255, 255],
    [128, 128, 128],
  ])('ida e volta rgb(%i, %i, %i)', (r, g, b) => {
    const [h, s, l] = rgbToHsl(r, g, b);
    expect(hslToRgb(h, s, l)).toEqual([r, g, b]);
  });
});

describe('shade', () => {
  it('k = 0 devolve a mesma cor', () => {
    expect(shade('#e2604f', 0)).toBe('#e2604f');
  });

  it('k > 0 clareia, k < 0 escurece, sempre num hex válido', () => {
    for (const c of ['#e2604f', '#4a86d8', '#808080', '#2b2530']) {
      const lighter = shade(c, 0.1);
      const darker = shade(c, -0.1);
      expect(lighter).toMatch(/^#[0-9a-f]{6}$/);
      expect(darker).toMatch(/^#[0-9a-f]{6}$/);
      expect(luminance(lighter)).toBeGreaterThan(luminance(c));
      expect(luminance(darker)).toBeLessThan(luminance(c));
    }
  });

  it('mantém o alfa', () => {
    expect(shade('#e2604f80', 0.1)).toMatch(/^#[0-9a-f]{6}80$/);
  });

  it('cor inválida: sombreia o magenta, sem NaN', () => {
    expect(shade('#zzz', 0.1)).not.toContain('NaN');
    expect(shade('#zzz', -0.1)).toBe(shade('#ff00ff', -0.1));
  });
});

describe('mix', () => {
  it('t = 0 devolve a primeira, t = 1 a segunda, e t fora de 0–1 é limitado', () => {
    expect(mix('#ff0000', '#0000ff', 0)).toBe('#ff0000');
    expect(mix('#ff0000', '#0000ff', 1)).toBe('#0000ff');
    expect(mix('#ff0000', '#0000ff', 2)).toBe('#0000ff');
    expect(mix('#ff0000', '#0000ff', -1)).toBe('#ff0000');
  });

  it('t = 0.5 entre preto e branco é cinza médio; o alfa também é misturado', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mix('#00000000', '#ffffffff', 0.5)).toBe('#80808080');
  });

  it('cor inválida entra como magenta', () => {
    expect(mix('#zzz', '#000000', 0)).toBe('#ff00ff');
  });
});

describe('ramp', () => {
  it('cinco tons em ordem de luminosidade, com a base igual à cor dada', () => {
    const r = ramp('#e2604f');
    expect(r.base).toBe('#e2604f');
    const lum = [r.hi, r.lt, r.base, r.dk, r.dd].map(luminance);
    for (let i = 1; i < lum.length; i++) expect(lum[i]).toBeLessThan(lum[i - 1]);
  });

  it('o passo muda a distância entre os tons', () => {
    const small = ramp('#808080', 0.04);
    const large = ramp('#808080', 0.12);
    expect(luminance(large.hi) - luminance(large.dd)).toBeGreaterThan(luminance(small.hi) - luminance(small.dd));
  });
});
