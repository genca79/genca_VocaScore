import { describe, expect, it } from 'vitest';
import { lowpass } from '../src/audio/lowpass.js';

/**
 * Riferimento indipendente dall'implementazione: due sezioni Butterworth del 2° ordine (Q = 1/√2)
 * in cascata, trasformate con la bilineare. Il guadagno di ciascuna è 1/√(1 + Ω⁴) con
 * Ω = tan(πf/fs) / tan(πfc/fs) (frequenza "piegata" dalla bilineare), quindi in cascata 1/(1 + Ω⁴).
 */
function expectedGainDb(f, fc, fs) {
  const omega = Math.tan((Math.PI * f) / fs) / Math.tan((Math.PI * fc) / fs);
  return 20 * Math.log10(1 / (1 + omega ** 4));
}

/** Guadagno misurato su una sinusoide, a regime (scartato il primo decimo di secondo). */
function measuredGainDb(f, fc, fs) {
  const x = Float32Array.from({ length: fs }, (_, i) => Math.sin((2 * Math.PI * f * i) / fs));
  const y = lowpass(x, fs, fc);
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const from = Math.round(fs / 10);
  return 20 * Math.log10(rms(y.subarray(from)) / rms(x.subarray(from)));
}

describe('lowpass', () => {
  it.each([
    [48000, 2500, [100, 440, 1100, 2500, 4000, 8000]],
    [16000, 2500, [100, 440, 1100, 2500, 4000, 6000]],
  ])('fs %i Hz, taglio %i Hz: risposta in frequenza come da formula', (fs, fc, freqs) => {
    for (const f of freqs) expect(measuredGainDb(f, fc, fs)).toBeCloseTo(expectedGainDb(f, fc, fs), 0);
  });

  it('la banda della voce (fino a 1100 Hz) passa quasi intatta, il soffio sopra i 6 kHz no', () => {
    expect(measuredGainDb(1100, 2500, 48000)).toBeGreaterThan(-0.5);
    expect(measuredGainDb(6000, 2500, 48000)).toBeLessThan(-25);
  });

  it('nessun transitorio iniziale: una finestra costante resta costante', () => {
    // dal vivo ogni finestra viene filtrata da sola: un avvio "da zero" deformerebbe i primi campioni
    const y = lowpass(new Float32Array(256).fill(0.3), 48000, 2500);
    for (const v of y) expect(v).toBeCloseTo(0.3, 6);
  });

  it('taglio 0: copia invariata', () => {
    const x = Float32Array.from([0.1, -0.2, 0.3]);
    expect([...lowpass(x, 48000, 0)]).toEqual([...x]);
  });

  it('scrive nel buffer di uscita fornito (niente allocazioni a ogni frame)', () => {
    const out = new Float32Array(64);
    expect(lowpass(new Float32Array(64).fill(1), 48000, 2500, out)).toBe(out);
  });
});
