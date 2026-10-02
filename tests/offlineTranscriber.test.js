import { describe, expect, it } from 'vitest';
import { transcribeOffline } from '../src/music/offlineTranscriber.js';
import { circularMeanOffset } from '../src/music/tuning.js';
import {
  synthVoice,
  TEST_MELODY,
  TEST_MELODY_EXPECTED,
  TEST_MELODY_STARTS,
  FLAT_SINGER_MELODY,
  FLAT_SINGER_DETUNE,
} from './helpers/synthVoice.js';

const SR = 16000;

describe('transcribeOffline', () => {
  it('melodia cantata intonata: note, sillabe ripetute e attacchi corretti', () => {
    const { notes } = transcribeOffline(synthVoice(TEST_MELODY, SR), SR);
    expect(notes.map((n) => n.midi)).toEqual(TEST_MELODY_EXPECTED);
    notes.forEach((n, i) => expect(Math.abs(n.start - TEST_MELODY_STARTS[i])).toBeLessThan(0.05));
  });

  it('cantante calante e incostante (−30 ±22 cents): l’intonazione viene stimata e compensata', () => {
    const audio = synthVoice(FLAT_SINGER_MELODY, SR, { detune: FLAT_SINGER_DETUNE });
    const { notes, tuningOffset } = transcribeOffline(audio, SR);
    expect(tuningOffset).toBeLessThan(-0.25);
    expect(tuningOffset).toBeGreaterThan(-0.45);
    expect(notes.map((n) => n.midi)).toEqual(TEST_MELODY_EXPECTED);
  });

  it('cantante al limite dell’ambiguità (−47 cents): risolto sull’intera registrazione', () => {
    const { notes } = transcribeOffline(synthVoice(TEST_MELODY, SR, { detune: -0.47 }), SR);
    expect(notes.map((n) => n.midi)).toEqual(TEST_MELODY_EXPECTED);
  });

  it('stesso canto senza compensazione: note sbagliate (confronto)', () => {
    const audio = synthVoice(FLAT_SINGER_MELODY, SR, { detune: FLAT_SINGER_DETUNE });
    const { notes } = transcribeOffline(audio, SR, { tuning: false });
    expect(notes.map((n) => n.midi)).not.toEqual(TEST_MELODY_EXPECTED);
  });

  it('crescente di 40 cents', () => {
    const { notes } = transcribeOffline(synthVoice(TEST_MELODY, SR, { detune: 0.4 }), SR);
    expect(notes.map((n) => n.midi)).toEqual(TEST_MELODY_EXPECTED);
  });

  it('legato e sillabe: transition solo tra note legate senza consonante', () => {
    const { notes } = transcribeOffline(synthVoice(TEST_MELODY, SR), SR);
    expect(notes[0].transition).toBe(true); // 60 → 62 legato
    expect(notes[2].transition).toBe(false); // "la" → "la": nuova sillaba
  });

  it('REGRESSIONE: voce con soffio (rumore a banda larga) → tutte le note', () => {
    const { notes } = transcribeOffline(synthVoice(TEST_MELODY, SR, { breath: 0.08 }), SR);
    expect(notes.map((n) => n.midi)).toEqual(TEST_MELODY_EXPECTED);
  });

  it('stesso canto senza passa-basso: note sbagliate (confronto)', () => {
    const { notes } = transcribeOffline(synthVoice(TEST_MELODY, SR, { breath: 0.08 }), SR, { lowpassHz: 0 });
    expect(notes.map((n) => n.midi)).not.toEqual(TEST_MELODY_EXPECTED);
  });

  // Scala cantata a note staccate (silenzio tra una nota e l'altra), come "do mi sol fa".
  const SCALE = [60, 64, 67, 65].map((midi, i) => ({ midi, start: 0.4 + i * 0.6, end: 0.4 + i * 0.6 + 0.5, vibrato: 0.25 }));

  it('REGRESSIONE: entrata da sopra o da sotto (150 ms, 1–2 semitoni) → una nota sola, dall’attacco', () => {
    // Voce reale: "mi" attaccato un semitono sopra per 160 ms, "re" partito due semitoni sotto.
    // Prima diventavano una nota breve in più (D#3 0.25 | D3 0.75 invece di D3 1).
    const melody = SCALE.map((n, i) => (i === 1 ? { ...n, onset: { semitones: 1, sec: 0.15 } } : i === 3 ? { ...n, onset: { semitones: -2, sec: 0.15 } } : n));
    const { notes } = transcribeOffline(synthVoice(melody, SR), SR);
    expect(notes.map((n) => n.midi)).toEqual([60, 64, 67, 65]);
    notes.forEach((n, i) => expect(Math.abs(n.start - SCALE[i].start)).toBeLessThan(0.05));
  });

  it('una nota breve DENTRO una frase legata resta una nota (non è un’entrata)', () => {
    // 60 legato → 62 breve (150 ms) legato → 64: la 62 non apre un gruppo, è una nota di passaggio vera
    const melody = [
      { midi: 60, start: 0.4, end: 0.9 },
      { midi: 62, start: 0.9, end: 1.05 },
      { midi: 64, start: 1.05, end: 1.7 },
    ];
    const { notes } = transcribeOffline(synthVoice(melody, SR), SR);
    expect(notes.map((n) => n.midi)).toEqual([60, 62, 64]);
  });

  it('silenzio e rumore: nessuna nota', () => {
    const noise = new Float32Array(SR * 2).map((_, i) => Math.sin(i * 12.9898) * 0.0005);
    expect(transcribeOffline(noise, SR).notes).toEqual([]);
  });

  it('44.1 kHz decimato a 22.05 kHz: stesso risultato', () => {
    const sr = 22050;
    const { notes } = transcribeOffline(synthVoice(FLAT_SINGER_MELODY, sr, { detune: -0.3 }), sr);
    expect(notes.map((n) => n.midi)).toEqual(TEST_MELODY_EXPECTED);
  });
});

describe('circularMeanOffset', () => {
  it('media corretta anche a cavallo di ±0.5 semitoni', () => {
    // scarti +0.48 e −0.48 sono vicini (metà strada): la media aritmetica direbbe 0
    const { offset } = circularMeanOffset([60.48, 61.52, 62.48, 63.52]);
    expect(Math.abs(Math.abs(offset) - 0.5)).toBeLessThan(0.03);
  });

  it('cantante calante di 30 cents', () => {
    const { offset, coherence } = circularMeanOffset([59.7, 61.72, 63.68, 64.7]);
    expect(offset).toBeCloseTo(-0.3, 1);
    expect(coherence).toBeGreaterThan(0.9);
  });
});
