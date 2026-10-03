import { describe, expect, it } from 'vitest';
import { base64ToPcm16, fromPcm16, pcm16ToBase64, toPcm16 } from '../src/storage/pcm.js';

describe('PCM 16 bit', () => {
  it('float → 16 bit → float: errore sotto mezzo passo di quantizzazione, saturazione ai bordi', () => {
    const x = Float32Array.from([0, 0.5, -0.5, 0.999, -1, 1.7, -3]);
    const back = fromPcm16(toPcm16(x));
    [0, 0.5, -0.5, 0.999, -1, 1, -1].forEach((v, i) => expect(Math.abs(back[i] - v)).toBeLessThan(1 / 32767));
  });
});

describe('base64', () => {
  it.each([0, 1, 2, 3, 7, 1000])('%i campioni: andata e ritorno esatti', (n) => {
    const pcm = Int16Array.from({ length: n }, (_, i) => ((i * 7919) % 65536) - 32768);
    expect([...base64ToPcm16(pcm16ToBase64(pcm))]).toEqual([...pcm]);
  });

  it('stessa codifica del base64 standard (riferimento: Buffer di Node)', () => {
    const pcm = Int16Array.from([1, -2, 32767, -32768, 12345]);
    const reference = Buffer.from(pcm.buffer).toString('base64');
    expect(pcm16ToBase64(pcm)).toBe(reference);
    expect([...base64ToPcm16(reference)]).toEqual([...pcm]);
  });

  it('testo non valido: errore chiaro', () => {
    expect(() => base64ToPcm16('ab$d')).toThrow(/non valido/);
    expect(() => base64ToPcm16('AA==')).toThrow(/non valido/); // 1 byte: non è un numero intero di campioni
  });
});
