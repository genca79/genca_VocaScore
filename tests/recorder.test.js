import { describe, expect, it } from 'vitest';
import { ScoreDocument } from '../src/music/scoreDocument.js';
import { Recorder } from '../src/music/recorder.js';
import { layoutMeasures, quantizeBeats } from '../src/music/notation.js';

const BEAT = 60000 / 90; // 90 BPM → 666.7 ms

function setup(settings = {}) {
  const doc = new ScoreDocument();
  doc.setSettings({ bpm: 90, grid: 0.5, ...settings });
  const rec = new Recorder(doc, { inputLatencyMs: 0 });
  return { doc, rec };
}

/** Simula gli eventi dello stabilizzatore per una nota. */
function sing(rec, midi, startMs, endMs, transition = false) {
  rec.noteStarted(startMs);
  rec.noteEnded({ midi, startMs, endMs, durationMs: endMs - startMs, transition });
}

const written = (doc) => doc.notes.map(({ midi, beats }) => [midi, beats]);

// Generatore pseudo-casuale deterministico: test riproducibili.
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32) * 2 - 1;
}

describe('Recorder: griglia assoluta', () => {
  it('REGRESSIONE: 16 semiminime cantate "umane" restano 16 semiminime in 4 battute pulite', () => {
    const { doc, rec } = setup();
    rec.beginSession(0);
    const rand = rng(42);
    for (let i = 0; i < 16; i++) {
      const on = i * BEAT + rand() * 60; // attacco impreciso di ±60 ms
      const off = (i + 1) * BEAT - 90 + rand() * 40; // respiro di 50–130 ms prima della nota successiva
      sing(rec, 60 + (i % 5), on, off);
    }
    expect(written(doc).every(([midi, beats]) => midi !== null && beats === 1)).toBe(true);
    expect(doc.notes).toHaveLength(16);
    const measures = layoutMeasures(doc.notes, '4/4');
    expect(measures).toHaveLength(4);
    expect(measures.flat().some((s) => s.tieNext)).toBe(false); // nessuna nota spezzata
  });

  it('la vecchia quantizzazione nota-per-nota sullo stesso canto si sfasava (confronto)', () => {
    // Durata di ogni nota quantizzata da sola e silenzi < croma scartati: i respiri si perdono.
    const rand = rng(42);
    let total = 0;
    for (let i = 0; i < 16; i++) {
      const on = i * BEAT + rand() * 60;
      const off = (i + 1) * BEAT - 90 + rand() * 40;
      total += quantizeBeats(off - on, 90);
    }
    expect(total).not.toBe(16);
  });

  it('ritmo misto: crome, minima e pausa', () => {
    const { doc, rec } = setup();
    rec.beginSession(0);
    sing(rec, 64, 10, 0.5 * BEAT - 40);
    sing(rec, 65, 0.5 * BEAT + 20, BEAT - 30);
    sing(rec, 67, BEAT - 10, 3 * BEAT - 70);
    // pausa da semiminima (beat 3), poi semiminima sul 4° movimento
    sing(rec, 69, 4 * BEAT + 30, 5 * BEAT - 80);
    expect(written(doc)).toEqual([[64, 0.5], [65, 0.5], [67, 2], [null, 1], [69, 1]]);
  });

  it('senza metronomo la prima nota diventa il primo movimento', () => {
    const { doc, rec } = setup();
    rec.beginSession(null);
    sing(rec, 60, 5000, 5000 + BEAT - 50);
    sing(rec, 62, 5000 + BEAT + 20, 5000 + 2 * BEAT - 60);
    expect(written(doc)).toEqual([[60, 1], [62, 1]]);
  });

  it('le note cantate durante la battuta di attacco iniziano al primo movimento', () => {
    const { doc, rec } = setup();
    rec.beginSession(0);
    sing(rec, 60, -200, BEAT - 50);
    expect(written(doc)).toEqual([[60, 1]]);
  });

  it('compensazione della latenza: la voce arriva in ritardo rispetto al click', () => {
    const doc = new ScoreDocument();
    doc.setSettings({ bpm: 90, grid: 0.25 });
    const rec = new Recorder(doc, { inputLatencyMs: 40 });
    rec.beginSession(0);
    // attacchi e stacchi tutti "visti" 120 ms dopo: senza compensazione cadrebbero sulla semicroma successiva
    sing(rec, 60, 0.25 * BEAT + 120, 1.25 * BEAT + 120);
    expect(written(doc)).toEqual([[null, 0.25], [60, 1]]);
  });
});

describe('Recorder: note mancanti o in più', () => {
  it('un glissato breve tra due note legate viene assorbito (niente nota in più)', () => {
    const { doc, rec } = setup();
    rec.beginSession(0);
    sing(rec, 60, 0, BEAT - 20, true);
    sing(rec, 61, BEAT - 20, BEAT + 60, true); // passaggio di 80 ms
    sing(rec, 62, BEAT + 60, 2 * BEAT - 50);
    expect(written(doc)).toEqual([[60, 1], [62, 1]]);
  });

  it("una scivolata d'attacco verso la nota vera viene assorbita", () => {
    const { doc, rec } = setup();
    rec.beginSession(0);
    sing(rec, 58, 10, 90, true); // la voce "entra" dal basso per 80 ms
    sing(rec, 60, 90, BEAT - 40);
    expect(written(doc)).toEqual([[60, 1]]);
  });

  it('una nota breve isolata NON viene persa: dura un’unità di griglia', () => {
    const { doc, rec } = setup();
    rec.beginSession(0);
    sing(rec, 72, 2 * BEAT + 10, 2 * BEAT + 110); // 100 ms staccato
    expect(written(doc)).toEqual([[null, 2], [72, 0.5]]);
  });

  it('con "Note legate" spento i silenzi brevi restano pause al loro posto', () => {
    const { doc, rec } = setup({ legato: false });
    rec.beginSession(0);
    sing(rec, 60, 0, 1.5 * BEAT); // nota da 1.5
    sing(rec, 62, 2 * BEAT, 3 * BEAT); // dopo una pausa di croma
    expect(written(doc)).toEqual([[60, 1.5], [null, 0.5], [62, 1]]);
  });
});

describe('Recorder: note legate', () => {
  /** 8 semiminime cantate staccate: ognuna suona per il 55% del movimento. */
  function staccato(rec) {
    rec.beginSession(0);
    for (let i = 0; i < 8; i++) sing(rec, 60 + (i % 3), i * BEAT + 10, i * BEAT + 0.55 * BEAT);
  }

  it('REGRESSIONE: semiminime staccate restano semiminime (non croma + pausa)', () => {
    const { doc, rec } = setup();
    staccato(rec);
    expect(doc.notes).toHaveLength(8); // nessuna pausa
    // tutte semiminime; l'ultima non ha una nota successiva fino a cui allungarsi: resta come cantata
    expect(written(doc).slice(0, 7).every(([midi, beats]) => midi !== null && beats === 1)).toBe(true);
    expect(written(doc).at(-1)).toEqual([60 + (7 % 3), 0.5]);
  });

  it('con "Note legate" spento si scrive la durata esatta come cantata', () => {
    const { doc, rec } = setup({ legato: false });
    staccato(rec);
    expect(written(doc).slice(0, 4)).toEqual([[60, 0.5], [null, 0.5], [61, 0.5], [null, 0.5]]);
  });

  it('un respiro vero tra due frasi (un movimento) resta una pausa', () => {
    const { doc, rec } = setup();
    rec.beginSession(0);
    sing(rec, 60, 0, 2 * BEAT); // minima
    sing(rec, 62, 3 * BEAT, 4 * BEAT); // dopo un movimento di silenzio
    expect(written(doc)).toEqual([[60, 2], [null, 1], [62, 1]]);
  });

  it('una nota brevissima seguita da un silenzio più lungo di lei resta staccata', () => {
    const { doc, rec } = setup({ grid: 0.25 });
    rec.beginSession(0);
    sing(rec, 72, 0, 0.25 * BEAT); // semicroma
    sing(rec, 72, 0.75 * BEAT, BEAT); // dopo una pausa di croma
    expect(written(doc)).toEqual([[72, 0.25], [null, 0.5], [72, 0.25]]);
  });

  it('con griglia 1/4 il silenzio tollerato è di un movimento', () => {
    const { doc, rec } = setup({ grid: 1 });
    rec.beginSession(0);
    sing(rec, 60, 0, 1.4 * BEAT); // agganciata a 1 movimento
    sing(rec, 62, 2 * BEAT, 3 * BEAT);
    expect(written(doc)).toEqual([[60, 2], [62, 1]]);
  });

  it('anche la rifinitura (Recorder.quantize) scrive note legate', () => {
    const session = { t0Raw: 0, settings: { bpm: 90, grid: 0.5, timeSignature: '4/4', legato: true } };
    const notes = [0, 1, 2].map((i) => ({ midi: 64, startMs: i * BEAT, endMs: i * BEAT + 0.5 * BEAT, transition: false }));
    expect(Recorder.quantize(notes, session)).toEqual([
      { midi: 64, beats: 1 },
      { midi: 64, beats: 1 },
      { midi: 64, beats: 0.5 },
    ]);
  });
});

describe('Recorder.quantize (scrittura della rifinitura)', () => {
  it('stesse regole della registrazione dal vivo, con la griglia della sessione', () => {
    const session = { t0Raw: 1000, settings: { bpm: 90, grid: 0.5, timeSignature: '4/4' } };
    const notes = [
      { midi: 60, startMs: 1000 + 10, endMs: 1000 + BEAT - 60, transition: false },
      { midi: 62, startMs: 1000 + BEAT + 20, endMs: 1000 + 3 * BEAT - 80, transition: false },
      { midi: 64, startMs: 1000 + 4 * BEAT, endMs: 1000 + 5 * BEAT, transition: false },
    ];
    expect(Recorder.quantize(notes, session)).toEqual([
      { midi: 60, beats: 1 },
      { midi: 62, beats: 2 },
      { midi: null, beats: 1 },
      { midi: 64, beats: 1 },
    ]);
  });

  it('senza metronomo la griglia parte dalla prima nota', () => {
    const session = { t0Raw: null, settings: { bpm: 90, grid: 0.5, timeSignature: '4/4' } };
    const written = Recorder.quantize([{ midi: 67, startMs: 52_000, endMs: 52_000 + 2 * BEAT, transition: false }], session);
    expect(written).toEqual([{ midi: 67, beats: 2 }]);
  });

  it('sessionInfo registra inizio e impostazioni della sessione (dopo il completamento della battuta)', () => {
    const { doc, rec } = setup();
    rec.beginSession(0);
    sing(rec, 60, 0, 3 * BEAT - 50);
    rec.endSession();
    rec.beginSession(5000);
    expect(rec.sessionInfo).toEqual({
      startIndex: 2,
      t0Raw: 5000,
      settings: { bpm: 90, grid: 0.5, timeSignature: '4/4', legato: true },
      rawNotes: [],
    });
    expect(doc.notes).toHaveLength(2); // nota + pausa di completamento
    sing(rec, 62, 5000, 5000 + BEAT);
    expect(rec.sessionInfo.rawNotes).toEqual([{ midi: 62, startMs: 5000, endMs: 5000 + BEAT, transition: false }]);
  });
});

describe('Recorder: sessioni', () => {
  it('una nuova sessione completa la battuta e riparte dal primo movimento', () => {
    const { doc, rec } = setup();
    rec.beginSession(0);
    sing(rec, 60, 0, 3 * BEAT - 50); // 3 beats in 4/4
    rec.endSession();
    rec.beginSession(120_000); // due minuti dopo
    sing(rec, 62, 120_000, 120_000 + BEAT - 50);
    expect(written(doc)).toEqual([[60, 3], [null, 1], [62, 1]]);
  });

  it('nota in corso: durata scritta aggiornata sulla griglia', () => {
    const { rec } = setup();
    rec.beginSession(0);
    rec.noteStarted(0);
    expect(rec.liveBeats(100)).toBe(0.5); // minimo un'unità di griglia
    expect(rec.liveBeats(2 * BEAT + 50)).toBe(2);
  });
});
