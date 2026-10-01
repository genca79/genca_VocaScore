import { describe, expect, it } from 'vitest';
import { detectPitchMPM } from '../src/audio/pitchDetector.js';

const SR = 48000;
const N = 2048;

/** Genera un segnale con fondamentale `hz` e armoniche di ampiezza data. */
function tone(hz, harmonics = [1], amplitude = 0.5) {
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let v = 0;
    harmonics.forEach((a, h) => (v += a * Math.sin((2 * Math.PI * hz * (h + 1) * i) / SR)));
    buf[i] = amplitude * v;
  }
  return buf;
}

/** Errore in cents tra stimato e atteso. */
const centsError = (est, expected) => Math.abs(1200 * Math.log2(est / expected));

describe('detectPitchMPM', () => {
  it.each([82.41, 110, 220, 261.63, 440, 659.25, 987.77])('sinusoide pura a %s Hz (< 5 cents)', (hz) => {
    const result = detectPitchMPM(tone(hz), SR);
    expect(result).not.toBeNull();
    expect(centsError(result.hz, hz)).toBeLessThan(5);
    expect(result.clarity).toBeGreaterThan(0.95);
  });

  it("voce simulata con fondamentale debole: niente errore d'ottava", () => {
    // fondamentale più debole della 2ª e 3ª armonica, come spesso accade nella voce
    const result = detectPitchMPM(tone(196, [0.3, 1, 0.8, 0.4, 0.2]), SR);
    expect(centsError(result.hz, 196)).toBeLessThan(10);
  });

  it('voce a basso volume (−50 dBFS): il pitch non dipende dal volume', () => {
    const result = detectPitchMPM(tone(220, [1, 0.5, 0.3], 0.003), SR);
    expect(centsError(result.hz, 220)).toBeLessThan(5);
  });

  it('rumore bianco → chiarezza bassa o nessun pitch', () => {
    const buf = new Float32Array(N).map(() => Math.random() * 2 - 1);
    const result = detectPitchMPM(buf, SR);
    expect(result === null || result.clarity < 0.8).toBe(true);
  });

  it('silenzio → null', () => {
    expect(detectPitchMPM(new Float32Array(N), SR)).toBeNull();
  });

  it('fuori range (fischio a 3 kHz) → null, non una subarmonica', () => {
    expect(detectPitchMPM(tone(3000), SR)).toBeNull();
  });
});
