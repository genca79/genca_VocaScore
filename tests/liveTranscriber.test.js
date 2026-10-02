import { describe, expect, it } from 'vitest';
import { LiveTranscriber } from '../src/music/liveTranscriber.js';
import { transcribeOffline } from '../src/music/offlineTranscriber.js';
import {
  synthVoice,
  TEST_MELODY,
  TEST_MELODY_EXPECTED,
  FLAT_SINGER_MELODY,
  FLAT_SINGER_DETUNE,
} from './helpers/synthVoice.js';

const SR = 16000;

/**
 * Simula la registrazione dal vivo come in main.js: ogni `stepSec` si analizza l'audio catturato da
 * `windowStartSec` in poi; allo Stop un ultimo giro rende tutto definitivo.
 * @returns {{ notes:Array<object>, during:Array<{ t:number, count:number }>, live:LiveTranscriber }}
 */
function stream(signal, { stepSec = 0.5, contextSec = undefined } = {}) {
  const live = new LiveTranscriber({ contextSec });
  const totalSec = signal.length / SR;
  const during = [];
  const step = (endSec, final) => {
    const from = Math.round(live.windowStartSec * SR);
    const to = Math.round(endSec * SR);
    if (!final && to - from < 0.3 * SR) return;
    const result = transcribeOffline(signal.subarray(from, to), SR, { floorCapDb: live.floorCapDb });
    live.accept(result, from / SR, to / SR, { final });
  };
  for (let t = stepSec; t < totalSec; t += stepSec) {
    step(t, false);
    during.push({ t, count: live.notes.length });
  }
  step(totalSec, true);
  return { notes: live.notes, during, live };
}

const pitches = (notes) => notes.map((n) => n.midi);

describe('LiveTranscriber (stesso algoritmo della rifinitura, a finestre)', () => {
  it('melodia con legato, sillabe ripetute e scivolate: come l’analisi dell’audio intero', () => {
    const signal = synthVoice(TEST_MELODY, SR);
    const whole = transcribeOffline(signal, SR).notes;
    const { notes } = stream(signal);
    expect(pitches(whole)).toEqual(TEST_MELODY_EXPECTED);
    expect(pitches(notes)).toEqual(pitches(whole));
    notes.forEach((n, i) => {
      expect(Math.abs(n.start - whole[i].start)).toBeLessThan(0.03);
      expect(Math.abs(n.end - whole[i].end)).toBeLessThan(0.03);
    });
  });

  it('REGRESSIONE: entrate da sopra o da sotto → una nota sola anche dal vivo', () => {
    const scale = [60, 64, 67, 65].map((midi, i) => ({ midi, start: 0.4 + i * 0.6, end: 0.4 + i * 0.6 + 0.5, vibrato: 0.25 }));
    scale[1].onset = { semitones: 1, sec: 0.15 };
    scale[3].onset = { semitones: -2, sec: 0.15 };
    const { notes } = stream(synthVoice(scale, SR));
    expect(pitches(notes)).toEqual([60, 64, 67, 65]);
    notes.forEach((n, i) => expect(Math.abs(n.start - scale[i].start)).toBeLessThan(0.05));
  });

  it('frase lunga tutta legata (nessun silenzio): nessuna nota persa o spezzata ai bordi delle finestre', () => {
    const melody = Array.from({ length: 16 }, (_, i) => ({
      midi: [60, 62, 64, 65, 67, 65, 64, 62][i % 8],
      start: 0.4 + i * 0.45,
      end: 0.4 + (i + 1) * 0.45,
      vibrato: 0.2,
    }));
    const signal = synthVoice(melody, SR);
    const live = pitches(stream(signal).notes);
    expect(live).toEqual(pitches(transcribeOffline(signal, SR).notes));
    expect(live).toEqual(melody.map((n) => n.midi));
  }, 60000); // simula molti giri di analisi: lento per natura

  it('le note compaiono mentre si canta (circa 1 s dopo), non solo allo Stop', () => {
    const scale = [60, 62, 64, 65, 67, 69, 71, 72].map((midi, i) => ({ midi, start: 0.4 + i * 0.6, end: 0.4 + i * 0.6 + 0.5 }));
    const { during } = stream(synthVoice(scale, SR));
    // a 3 s sono state cantate 5 note (l'ultima iniziata a 2.8 s): almeno 4 già sul pentagramma
    expect(during.find((d) => Math.abs(d.t - 3) < 1e-9).count).toBeGreaterThanOrEqual(4);
  });

  it('il tratto da analizzare non cresce oltre il contesto: silenzio e canto lungo (costo limitato)', () => {
    const notes = Array.from({ length: 40 }, (_, i) => ({ midi: 60 + (i % 5), start: 8 + i * 0.6, end: 8.5 + i * 0.6 }));
    const long = synthVoice(notes, SR);
    const { live: after } = stream(long, { contextSec: 4 });
    expect(after.final.length).toBe(40);
    // durante il canto il tratto analizzato resta vicino al contesto (4 s), non all'intera sessione (32 s)
    const probe = new LiveTranscriber({ contextSec: 4 });
    let longest = 0;
    for (let t = 0.5; t <= long.length / SR; t += 0.5) {
      const from = Math.round(probe.windowStartSec * SR);
      const to = Math.round(t * SR);
      if (to - from < 0.3 * SR) continue;
      longest = Math.max(longest, (to - from) / SR);
      probe.accept(transcribeOffline(long.subarray(from, to), SR, { floorCapDb: probe.floorCapDb }), from / SR, to / SR);
    }
    // contesto + la nota che lo scavalca + un giro
    expect(longest).toBeLessThanOrEqual(4 + 2);
  }, 60000); // simula decine di giri di analisi: lento per natura

  it('la finestra avanza anche durante un lungo silenzio', () => {
    const signal = synthVoice([{ midi: 60, start: 8, end: 8.6 }], SR);
    const live = new LiveTranscriber();
    for (let t = 0.5; t <= 7.5; t += 0.5) {
      const from = Math.round(live.windowStartSec * SR);
      const to = Math.round(t * SR);
      if (to - from >= 0.3 * SR) live.accept(transcribeOffline(signal.subarray(from, to), SR, { floorCapDb: live.floorCapDb }), from / SR, to / SR);
    }
    expect(7.5 - live.windowStartSec).toBeLessThan(2);
    expect(pitches(stream(signal).notes)).toEqual([60]);
  });

  it('REGRESSIONE: cantante calante, ripetuto 3 volte (oltre il tratto rianalizzato): come sull’audio intero', () => {
    // L'intonazione (−36 cents) si stima su più note: una finestra di 1–2 s non basterebbe e le note
    // vicine a −50 cents cadrebbero un semitono sotto. Il tratto rianalizzato (12 s) la contiene.
    const length = 5.6;
    const shift = (n, k) => ({ ...n, start: n.start + k * length, end: n.end + k * length, dips: n.dips?.map((d) => d + k * length) });
    const melody = [0, 1, 2].flatMap((k) => FLAT_SINGER_MELODY.map((n) => shift(n, k)));
    const signal = synthVoice(melody, SR, { detune: FLAT_SINGER_DETUNE });
    const expected = [...TEST_MELODY_EXPECTED, ...TEST_MELODY_EXPECTED, ...TEST_MELODY_EXPECTED];
    expect(pitches(transcribeOffline(signal, SR).notes)).toEqual(expected); // l'audio intero (riferimento)
    expect(pitches(stream(signal).notes)).toEqual(expected);
    expect(pitches(stream(signal, { contextSec: 1 }).notes)).not.toEqual(expected); // confronto: contesto di 1 s
  }, 60000);

  it('pezzo tutto cantato: il rumore di fondo resta quello misurato all’inizio (floorCapDb)', () => {
    const { live } = stream(synthVoice(TEST_MELODY, SR, { noise: 0.0005 }));
    // rumore di 0.0005 di ampiezza ≈ −70 dBFS; senza tetto una finestra tutta cantata stimerebbe il canto
    expect(live.floorCapDb).toBeLessThan(-60);
  });
});
