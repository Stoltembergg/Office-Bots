// Letras 3×5 do "STOP" (placa e marcação no chão), em pixels: cada linha é uma máscara de 3 bits.
const GLYPHS: Readonly<Record<string, readonly number[]>> = {
  S: [0b111, 0b100, 0b111, 0b001, 0b111],
  T: [0b111, 0b010, 0b010, 0b010, 0b010],
  O: [0b111, 0b101, 0b101, 0b101, 0b111],
  P: [0b111, 0b101, 0b111, 0b100, 0b100],
};

/** Largura (px) de `text` na escala `scale`: letras de 3 colunas com 1 de espaço entre elas. */
export function pixelTextWidth(text: string, scale = 1): number {
  return (text.length * 4 - 1) * scale;
}

/** Desenha `text` (S, T, O, P) com o canto superior esquerdo em (x, y). */
export function drawPixelText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, scale = 1): void {
  ctx.fillStyle = color;
  [...text].forEach((ch, i) => {
    const g = GLYPHS[ch];
    if (!g) return;
    g.forEach((bits, row) => {
      for (let col = 0; col < 3; col++) if (bits & (0b100 >> col)) ctx.fillRect(x + (i * 4 + col) * scale, y + row * scale, scale, scale);
    });
  });
}
