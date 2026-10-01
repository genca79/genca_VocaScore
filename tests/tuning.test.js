import { describe, expect, it } from 'vitest';
import { TuningEstimator } from '../src/music/tuning.js';

describe('TuningEstimator', () => {
  it('nessuna correzione con meno di 3 note', () => {
    const t = new TuningEstimator();
    t.observe(59.7);
    t.observe(61.7);
    expect(t.offset).toBe(0);
  });

  it('cantante calante di 30 cents', () => {
    const t = new TuningEstimator();
    for (const m of [59.7, 61.68, 63.72, 64.7]) t.observe(m);
    expect(t.offset).toBeCloseTo(-0.3, 1);
    expect(t.cents).toBeCloseTo(-30, -1);
  });

  it('scarti incoerenti (canto intonato con errori sparsi): nessuna correzione', () => {
    const t = new TuningEstimator();
    for (const m of [60.3, 61.8, 63.1, 64.6, 66.0, 67.45]) t.observe(m);
    expect(Math.abs(t.offset)).toBeLessThan(0.15);
  });

  it('correzione limitata a ±40 cents', () => {
    const t = new TuningEstimator();
    for (const m of [59.57, 61.57, 63.57, 64.57]) t.observe(m);
    expect(t.offset).toBe(-0.4);
  });

  it('REGRESSIONE: prime note ambigue (≈ ±50 cents) non bloccano la direzione sbagliata', () => {
    // Cantante calante di ~42 cents: le prime note cadono per caso a −49/+49 cents (indecidibili),
    // le successive indicano chiaramente "calante". Prima la stima si bloccava su +40.
    const t = new TuningEstimator();
    for (const m of [59.6, 61.51, 63.52]) t.observe(m);
    expect(t.offset).toBeLessThanOrEqual(0); // nessuna decisione sbagliata sui dati ambigui
    for (const m of [66.63, 64.57, 63.6, 61.62]) t.observe(m);
    expect(t.offset).toBeLessThan(-0.3);
  });

  it('vicino a ±50 cents la stima non cambia direzione (niente salti di un semitono)', () => {
    const t = new TuningEstimator();
    for (const m of [59.58, 61.6, 63.57]) t.observe(m); // −0.42: direzione "calante"
    expect(t.offset).toBeLessThan(0);
    for (const m of [64.46, 66.45, 67.47]) t.observe(m); // ora sembrerebbe +0.46 ("crescente")
    expect(t.offset).toBeLessThan(0);
  });

  it('segue un cantante che cambia intonazione nel corso del brano', () => {
    const t = new TuningEstimator();
    for (const m of [59.8, 61.8, 63.8, 64.8]) t.observe(m); // −20 cents
    for (let i = 0; i < 12; i++) t.observe(60 + i + 0.2); // poi +20 cents
    expect(t.offset).toBeCloseTo(0.2, 1);
  });
});
