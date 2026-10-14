import { describe, expect, it } from 'vitest';
import { INPUT_CHUNK, InputQueues, splitInput } from './ptyapi';

describe('splitInput', () => {
  it('corta em pedaços do tamanho máximo, sem separar um emoji', () => {
    expect(splitInput('')).toEqual([]);
    expect(splitInput('abcdef', 4)).toEqual(['abcd', 'ef']);
    expect(splitInput('abc😀def', 4)).toEqual(['abc', '😀de', 'f']);
    const big = 'x'.repeat(INPUT_CHUNK * 4 + 10);
    const parts = splitInput(big);
    expect(parts.join('')).toBe(big);
    expect(Math.max(...parts.map((p) => p.length))).toBe(INPUT_CHUNK);
  });
});

describe('InputQueues', () => {
  it('cada pty com a sua fila: um pty parado não segura o outro', async () => {
    const sent: string[] = [];
    let release!: () => void;
    const stuck = new Promise<void>((r) => (release = r));
    const q = new InputQueues(
      () => undefined,
      async (id, data) => {
        if (id === 'a') await stuck;
        sent.push(`${id}:${data}`);
      },
    );
    const a = q.send('a', '1');
    void q.send('a', '2');
    await q.send('b', 'x');
    expect(sent).toEqual(['b:x']);
    release();
    await a;
    await q.send('a', '');
    // As teclas que chegam antes do envio sair vão juntas.
    expect(sent).toEqual(['b:x', 'a:12']);
  });

  it('colagem grande vai em pedaços, na ordem; erro é avisado', async () => {
    const sent: string[] = [];
    const errors: string[] = [];
    const q = new InputQueues(
      (id, err) => errors.push(`${id}:${err.message}`),
      async (id, data) => {
        if (id === 'x') throw new Error('o Habblaud não respondeu');
        sent.push(data);
      },
    );
    const text = 'a'.repeat(INPUT_CHUNK) + 'b'.repeat(INPUT_CHUNK) + 'c';
    await q.send('p', text);
    expect(sent.map((s) => s[0] + s.length)).toEqual([`a${INPUT_CHUNK}`, `b${INPUT_CHUNK}`, 'c1']);
    await q.send('x', 'oi');
    expect(errors).toEqual(['x:o Habblaud não respondeu']);
  });
});
