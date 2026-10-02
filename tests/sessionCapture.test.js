import { beforeAll, describe, expect, it } from 'vitest';

// Tone.js (importato da sessionCapture.js) è lento da caricare in Node: import una volta sola.
let SessionCapture;
beforeAll(async () => {
  ({ SessionCapture } = await import('../src/audio/sessionCapture.js'));
}, 60000);

describe('SessionCapture.samplesFrom (audio catturato finora, per la trascrizione dal vivo)', () => {
  /** Cattura con l'audio già arrivato in tre blocchi, come dal thread audio: 1…9. */
  function captured() {
    const c = new SessionCapture();
    c.chunks = [Float32Array.from([1, 2, 3]), Float32Array.from([4, 5]), Float32Array.from([6, 7, 8, 9])];
    c.length = 9;
    return c;
  }

  it.each([
    [0, [1, 2, 3, 4, 5, 6, 7, 8, 9]],
    [2, [3, 4, 5, 6, 7, 8, 9]], // dentro il primo blocco
    [3, [4, 5, 6, 7, 8, 9]], // esattamente all'inizio del secondo
    [4, [5, 6, 7, 8, 9]],
    [8, [9]],
    [9, []],
    [20, []], // oltre la fine
    [-1, [1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ])('dal campione %i', (from, expected) => {
    expect([...captured().samplesFrom(from)]).toEqual(expected);
  });

  it('restituisce una copia: la cattura può continuare senza toccare quanto già consegnato', () => {
    const c = captured();
    const out = c.samplesFrom(0);
    out[0] = 99;
    expect(c.chunks[0][0]).toBe(1);
  });
});
