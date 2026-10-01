import { describe, expect, it } from 'vitest';
import { NoiseGate, computeRms, rmsToDb } from '../src/audio/noiseGate.js';

const FRAME_MS = 1000 / 60;

/** Alimenta il gate con un livello costante per `ms` millisecondi; restituisce gli stati per frame. */
function hold(gate, db, ms, clock) {
  const states = [];
  for (const end = clock.t + ms; clock.t < end; clock.t += FRAME_MS) states.push(gate.process(db, clock.t));
  return states;
}

describe('RMS e dBFS', () => {
  it('conversioni', () => {
    expect(computeRms(new Float32Array([1, -1, 1, -1]))).toBe(1);
    expect(rmsToDb(1)).toBe(0);
    expect(rmsToDb(0.1)).toBeCloseTo(-20, 10);
    expect(rmsToDb(0)).toBe(-Infinity);
  });
});

describe('NoiseGate adattivo', () => {
  it('impara il rumore di fondo e apre 10 dB sopra', () => {
    const gate = new NoiseGate();
    const clock = { t: 0 };
    hold(gate, -72, 1000, clock);
    expect(gate.floorDb).toBeCloseTo(-72, 0);
    expect(gate.openDb).toBeCloseTo(-62, 0);
  });

  it('microfono poco sensibile: voce a −55 dBFS apre il gate (con soglia fissa a −45 veniva tagliata)', () => {
    const gate = new NoiseGate();
    const clock = { t: 0 };
    hold(gate, -75, 1000, clock);
    const states = hold(gate, -55, 500, clock);
    expect(states.at(-1)).toBe(true);
  });

  it('stanza rumorosa: la soglia non supera maxOpenDb', () => {
    const gate = new NoiseGate();
    hold(gate, -30, 2000, { t: 0 });
    expect(gate.openDb).toBe(-35);
  });

  it('il floor non "impara" la voce mentre si canta', () => {
    const gate = new NoiseGate();
    const clock = { t: 0 };
    hold(gate, -70, 1000, clock);
    const before = gate.openDb;
    const states = hold(gate, -40, 10000, clock); // 10 s di nota tenuta
    expect(states.every(Boolean)).toBe(true);
    expect(gate.openDb).toBeCloseTo(before, 1);
  });

  it('isteresi e hold: un calo breve non chiude, il silenzio sì', () => {
    const gate = new NoiseGate({ holdMs: 250 });
    const clock = { t: 0 };
    hold(gate, -70, 1000, clock); // floor −70 → apre a −60, chiude a −66
    expect(hold(gate, -50, 200, clock).at(-1)).toBe(true);
    expect(hold(gate, -63, 500, clock).every(Boolean)).toBe(true); // tra le soglie: resta aperto
    expect(hold(gate, -80, 200, clock).every(Boolean)).toBe(true); // dentro l'hold
    expect(hold(gate, -80, 200, clock).at(-1)).toBe(false); // hold scaduto
  });
});
