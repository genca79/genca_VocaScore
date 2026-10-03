import { describe, expect, it } from 'vitest';
import { autoGrid, detectBeats, transcribeRhythm, transcribeRhythmVoices } from '../src/music/rhythm.js';

// Generatore pseudo-casuale deterministico
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32) * 2 - 1;
}

/**
 * Canto simulato: durate in movimenti, tempo (BPM, eventualmente variabile), imprecisione degli
 * attacchi (±jitterMs) e stacco prima della nota successiva (la voce "respira").
 * @returns {Array<{ midi:number, startMs:number, endMs:number, transition:boolean }>}
 */
function sing(durations, { bpm = 100, bpmEnd = null, jitterMs = 25, gapMs = 70, startMs = 5000, seed = 7 } = {}) {
  const rand = rng(seed);
  const total = durations.reduce((a, b) => a + b, 0);
  let beat = 0;
  // tempo che varia linearmente: la posizione in ms si ottiene integrando la durata del movimento
  const timeAt = (b) => {
    if (!bpmEnd) return (b * 60000) / bpm;
    let t = 0;
    const steps = Math.ceil(b * 20);
    for (let i = 0; i < steps; i++) {
      const x = ((i + 0.5) / steps) * b;
      t += ((60000 / (bpm + ((bpmEnd - bpm) * x) / total)) * b) / steps;
    }
    return t;
  };
  return durations.map((d, i) => {
    const start = startMs + timeAt(beat) + (i === 0 ? 0 : rand() * jitterMs);
    beat += d;
    const end = startMs + timeAt(beat) - gapMs;
    return { midi: 60 + (i % 7), startMs: start, endMs: end, transition: false };
  });
}

const beatsOf = (written) => written.map((n) => (n.midi === null ? `r${n.beats}` : n.beats));
const SETTINGS = { bpm: 90, grid: 'auto', timeSignature: '4/4', legato: true };

describe('detectBeats (tempo rilevato)', () => {
  it.each([72, 96, 112, 132])('canto a %s BPM con imprecisioni: tempo stimato entro ±3%%', (bpm) => {
    const notes = sing([1, 1, 0.5, 0.5, 1, 2, 1, 1, 0.5, 0.5, 0.5, 0.5, 2, 1, 1, 2], { bpm });
    const r = detectBeats(notes.map((n) => n.startMs), { hintBpm: 100 });
    expect(Math.abs(r.bpm - bpm) / bpm).toBeLessThan(0.03);
  });

  it('il BPM impostato fa da indicazione per l’ambiguità doppio/metà tempo', () => {
    const notes = sing(Array(16).fill(1), { bpm: 112 });
    const onsets = notes.map((n) => n.startMs);
    expect(detectBeats(onsets, { hintBpm: 110 }).bpm).toBeCloseTo(112, -1);
    expect(detectBeats(onsets, { hintBpm: 55 }).bpm).toBeCloseTo(56, -1); // stesso canto letto "in metà tempo"
  });

  it('troppo poche note: nessuna stima', () => {
    expect(detectBeats([0, 500, 1000])).toBeNull();
  });
});

describe('transcribeRhythm senza metronomo', () => {
  const RHYTHM = [1, 1, 0.5, 0.5, 1, 2, 1, 1, 0.5, 0.5, 0.5, 0.5, 2, 1, 1, 2];

  it('REGRESSIONE: canto a 104 BPM con l’app impostata a 90 → ritmo e tempo corretti', () => {
    // Prima la griglia usava i 90 BPM impostati: dopo poche note tutto risultava sfasato.
    const { written, detectedBpm } = transcribeRhythm(sing(RHYTHM, { bpm: 104 }), { settings: SETTINGS, t0Ms: null });
    expect(Math.round(detectedBpm)).toBeGreaterThanOrEqual(101);
    expect(Math.round(detectedBpm)).toBeLessThanOrEqual(107);
    expect(beatsOf(written).slice(0, -1)).toEqual(RHYTHM.slice(0, -1)); // l'ultima non ha una successiva
  });

  it('accelerando (96 → 116 BPM): il ritmo resta giusto fino alla fine', () => {
    const { written } = transcribeRhythm(sing(RHYTHM, { bpm: 96, bpmEnd: 116 }), { settings: SETTINGS, t0Ms: null });
    expect(beatsOf(written).slice(0, -1)).toEqual(RHYTHM.slice(0, -1));
  });

  it('rallentando (110 → 88 BPM)', () => {
    const { written } = transcribeRhythm(sing(RHYTHM, { bpm: 110, bpmEnd: 88 }), { settings: SETTINGS, t0Ms: null });
    expect(beatsOf(written).slice(0, -1)).toEqual(RHYTHM.slice(0, -1));
  });

  it('pause vere restano pause', () => {
    const notes = sing([1, 1, 2, 1, 1, 2, 1, 1, 2], { bpm: 100 });
    notes.splice(3, 1); // un movimento di silenzio al posto della 4ª nota
    const { written } = transcribeRhythm(notes, { settings: SETTINGS, t0Ms: null });
    expect(beatsOf(written).slice(0, 4)).toEqual([1, 1, 2, 'r1']);
  });
});

describe('quantizzazione automatica', () => {
  it('passaggio lento impreciso (±110 ms): semiminime pulite', () => {
    const notes = sing(Array(12).fill(1), { bpm: 80, jitterMs: 110, seed: 3 });
    const t0Ms = notes[0].startMs; // con il metronomo a 80 BPM
    const auto = transcribeRhythm(notes, { settings: { ...SETTINGS, bpm: 80 }, t0Ms });
    expect(beatsOf(auto.written).slice(0, -1).every((b) => b === 1)).toBe(true);
  });

  it('passaggio veloce: semicrome riconosciute (la griglia fissa 1/8 le perderebbe)', () => {
    const rhythm = [0.25, 0.25, 0.25, 0.25, 0.5, 0.5, 1, 0.25, 0.25, 0.5, 1, 1];
    const notes = sing(rhythm, { bpm: 72, jitterMs: 12, gapMs: 25 });
    const t0Ms = notes[0].startMs; // con il metronomo a 72 BPM
    const auto = transcribeRhythm(notes, { settings: { ...SETTINGS, bpm: 72 }, t0Ms });
    const coarse = transcribeRhythm(notes, { settings: { ...SETTINGS, bpm: 72, grid: 0.5 }, t0Ms });
    expect(beatsOf(auto.written).slice(0, -1)).toEqual(rhythm.slice(0, -1));
    expect(beatsOf(coarse.written).slice(0, -1)).not.toEqual(rhythm.slice(0, -1));
  });

  it('autoGrid: la suddivisione si sceglie movimento per movimento', () => {
    const snap = autoGrid([
      { pos: 0.04, weight: 1 }, // movimento 0: un solo attacco → intero
      { pos: 1.02, weight: 1 }, // movimento 1: crome
      { pos: 1.52, weight: 1 },
      { pos: 2.0, weight: 1 }, // movimento 2: semicrome
      { pos: 2.26, weight: 1 },
      { pos: 2.49, weight: 1 },
      { pos: 2.77, weight: 1 },
    ]);
    expect([0.04, 1.52, 2.26, 2.77].map(snap)).toEqual([0, 1.5, 2.25, 2.75]);
    expect(snap(0.3)).toBe(0); // nel movimento 0 (intero) un valore a 0.3 va sul battere
  });

  it('con il metronomo: tempo noto, quantizzazione automatica', () => {
    const rhythm = [1, 0.5, 0.5, 0.25, 0.25, 0.5, 1, 2];
    const notes = sing(rhythm, { bpm: 90, jitterMs: 15, gapMs: 30 });
    const { written, detectedBpm } = transcribeRhythm(notes, { settings: SETTINGS, t0Ms: notes[0].startMs });
    expect(detectedBpm).toBeNull();
    expect(beatsOf(written).slice(0, -1)).toEqual(rhythm.slice(0, -1));
  });
});

describe('più voci insieme (stesso orologio)', () => {
  // Soprano a semiminime; contralto a minime che entra due movimenti dopo; tempo 100, metronomo spento.
  const SOPRANO = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  const ALTO = [2, 2, 2, 2, 2];
  const startMs = 5000;
  const beatMs = 600;
  const soprano = sing(SOPRANO, { bpm: 100, startMs, seed: 11 });
  const alto = sing(ALTO, { bpm: 100, startMs: startMs + 2 * beatMs, seed: 5 });

  it('tempo rilevato su tutte le voci e zero comune: la voce che entra dopo inizia con una pausa', () => {
    const { voices, detectedBpm } = transcribeRhythmVoices([soprano, alto], { settings: SETTINGS, t0Ms: null });
    expect(Math.round(detectedBpm)).toBeGreaterThanOrEqual(97);
    expect(Math.round(detectedBpm)).toBeLessThanOrEqual(103);
    expect(beatsOf(voices[0]).slice(0, -1)).toEqual(SOPRANO.slice(0, -1));
    expect(beatsOf(voices[1]).slice(0, -1)).toEqual(['r2', ...ALTO.slice(0, -1)]);
  });

  it('una voce sola: identico a transcribeRhythm', () => {
    const single = transcribeRhythm(soprano, { settings: SETTINGS, t0Ms: null });
    const multi = transcribeRhythmVoices([soprano], { settings: SETTINGS, t0Ms: null });
    expect(multi.voices[0]).toEqual(single.written);
    expect(multi.detectedBpm).toBe(single.detectedBpm);
  });

  it('una voce vuota resta vuota', () => {
    expect(transcribeRhythmVoices([soprano, []], { settings: SETTINGS, t0Ms: null }).voices[1]).toEqual([]);
  });
});

describe('collegamento all’audio originale (src)', () => {
  it('ogni nota scritta ricorda la sua ripresa e i tempi cantati', async () => {
    const { writeTranscription } = await import('../src/music/rhythm.js');
    const notes = [0, 1, 2, 3, 4].map((i) => ({ midi: 60 + i, start: 1 + i * 0.6, end: 1.5 + i * 0.6, transition: false }));
    const { written } = writeTranscription(notes, { settings: SETTINGS, take: 't7' });
    const pitched = written.filter((n) => n.midi !== null);
    expect(pitched.map((n) => n.src)).toEqual(notes.map((n) => ({ take: 't7', start: n.start, end: n.end })));
    expect(written.filter((n) => n.midi === null).every((n) => n.src === undefined)).toBe(true);
  });
});
