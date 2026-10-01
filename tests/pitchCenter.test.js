import { describe, expect, it } from 'vitest';
import { median, vibratoCenter } from '../src/music/pitchCenter.js';

/** Nota con vibrato sinusoidale campionata a 60 fps. */
function vibratoNote({ center = 60, depth = 0.3, rateHz = 5.5, durationMs = 460, phase = 0 }) {
  const times = [];
  const values = [];
  for (let t = 0; t <= durationMs; t += 1000 / 60) {
    times.push(t);
    values.push(center + depth * Math.sin(2 * Math.PI * rateHz * (t / 1000) + phase));
  }
  return { times, values };
}

describe('vibratoCenter', () => {
  it('REGRESSIONE: vibrato su un numero non intero di cicli → centro corretto (la mediana sbaglia)', () => {
    let worstMedian = 0;
    let worstCenter = 0;
    for (let phase = 0; phase < 2 * Math.PI; phase += Math.PI / 8) {
      const { times, values } = vibratoNote({ phase }); // 460 ms ≈ 2.5 cicli a 5.5 Hz
      worstMedian = Math.max(worstMedian, Math.abs(median(values) - 60));
      worstCenter = Math.max(worstCenter, Math.abs(vibratoCenter(values, times) - 60));
    }
    expect(worstMedian).toBeGreaterThan(0.06); // la mediana semplice sbaglia di oltre 6 cents
    expect(worstCenter).toBeLessThan(0.03); // il centro robusto resta entro 3 cents
  });

  it('vibrato più veloce (7 Hz) e più ampio (±50 cents)', () => {
    const { times, values } = vibratoNote({ depth: 0.5, rateHz: 7, durationMs: 700, phase: 1 });
    expect(Math.abs(vibratoCenter(values, times) - 60)).toBeLessThan(0.05);
  });

  it('nota più breve di un ciclo: mediana semplice', () => {
    expect(vibratoCenter([60.1, 60.2, 59.9], [0, 16, 33])).toBeCloseTo(60.1, 6);
  });

  it('frame anomalo isolato: resta robusto', () => {
    const { times, values } = vibratoNote({ depth: 0.2, durationMs: 800 });
    values[20] = 72; // errore d'ottava di un frame
    expect(Math.abs(vibratoCenter(values, times) - 60)).toBeLessThan(0.08);
  });
});
