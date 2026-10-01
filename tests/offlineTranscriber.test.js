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
