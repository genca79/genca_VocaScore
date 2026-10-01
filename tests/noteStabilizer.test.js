import { describe, expect, it } from 'vitest';
import { NoteStabilizer } from '../src/music/noteStabilizer.js';
import { CONFIG } from '../src/config.js';

/**
 * Simula il loop di analisi: `signal(tMs)` restituisce { midi, gate } per ogni frame.
 * midi = null → nessun pitch; gate = stato del noise gate.
 */
function run(signal, durationMs, fps = 60, stab = new NoteStabilizer(CONFIG.stabilizer)) {
  const events = [];
  const step = 1000 / fps;
  let t = 0;
  for (; t < durationMs; t += step) {
    const { midi, gate = midi != null } = signal(t);
    events.push(...stab.process(midi, t, gate));
  }
  events.push(...stab.flush(t));
  return events;
}

const noteOns = (events) => events.filter((e) => e.type === 'noteOn');

/**
 * Regressione: una nota lunga cantata "male" (come accade davvero) deve restare UNA nota.
 * 3 secondi di A3 con:
 *   - vibrato ±40 cents a 5.5 Hz e una leggera deriva d'intonazione;
 *   - cali del gate di 120 ms (fine fiato, consonanti);
 *   - frame incerti a gate aperto per 300 ms (respiro, raucedine);
 *   - errore d'ottava del detector per 150 ms.
 */
function messyLongNote(t) {
  const base = 57 + 0.25 * Math.sin((2 * Math.PI * t) / 3000); // deriva lenta ±25 cents
  const vibrato = 0.4 * Math.sin((2 * Math.PI * 5.5 * t) / 1000);
  if (t > 600 && t < 720) return { midi: null, gate: false };
  if (t > 1200 && t < 1500) return { midi: null, gate: true };
  if (t > 1900 && t < 2050) return { midi: base + 12 };
  if (t > 2500 && t < 2620) return { midi: null, gate: false };
  return { midi: base + vibrato };
}

describe('NoteStabilizer', () => {
  it.each([60, 120, 144])('nota lunga con disturbi → una sola nota (%s fps)', (fps) => {
    const events = run(messyLongNote, 3000, fps);
    expect(noteOns(events)).toHaveLength(1);
    expect(noteOns(events)[0]).toMatchObject({ midi: 57, name: 'A3' });
    const off = events.find((e) => e.type === 'noteOff');
    expect(off.durationMs).toBeGreaterThan(2800);
  });

  it('conferma una nota dopo confirmMs', () => {
    const events = run(() => ({ midi: 69.05 }), 200);
    expect(noteOns(events)).toHaveLength(1);
    expect(noteOns(events)[0]).toMatchObject({ midi: 69, name: 'A4' });
    expect(noteOns(events)[0].startMs).toBeLessThan(40); // datata alla comparsa, non alla conferma
  });

  it('cambio nota reale: noteOff legato (transition) poi noteOn', () => {
    const events = run((t) => ({ midi: t < 1000 ? 60 : 62 }), 2000);
    expect(events.map((e) => e.type)).toEqual(['noteOn', 'noteOff', 'noteOn', 'noteOff']);
    expect(events[1].transition).toBe(true);
    expect(events[2].midi).toBe(62);
  });

  it("un salto d'ottava VERO e tenuto viene comunque riconosciuto", () => {
    const events = run((t) => ({ midi: t < 1000 ? 57 : 69 }), 2000);
    expect(noteOns(events).map((e) => e.midi)).toEqual([57, 69]);
  });

  it('due note uguali separate da un silenzio vero restano due note', () => {
    const events = run((t) => (t > 1000 && t < 1400 ? { midi: null, gate: false } : { midi: 64 }), 2500);
    expect(noteOns(events)).toHaveLength(2);
  });

  it('la durata termina all’ultimo frame intonato, non dopo la tolleranza', () => {
    const events = run((t) => (t < 1000 ? { midi: 64 } : { midi: null, gate: false }), 2000);
    const off = events.find((e) => e.type === 'noteOff');
    expect(off.endMs).toBeLessThanOrEqual(1000);
    expect(off.durationMs).toBeGreaterThan(950);
  });
});
