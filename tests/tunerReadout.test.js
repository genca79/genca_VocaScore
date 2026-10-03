import { describe, expect, it } from 'vitest';
import { TunerReadout, tuningVerdict } from '../src/music/tunerReadout.js';
import { midiToItalianName } from '../src/music/noteUtils.js';

describe('nomi italiani delle note', () => {
  it.each([
    [60, 'Do4'],
    [61, 'Do#4'],
    [64, 'Mi4'],
    [67, 'Sol4'],
    [69, 'La4'],
    [71, 'Si4'],
    [48, 'Do3'],
    [21, 'La0'],
  ])('%i → %s', (midi, name) => expect(midiToItalianName(midi)).toBe(name));
});

describe('tuningVerdict', () => {
  it.each([
    [0, 'ok', 'Intonato'],
    [-10, 'ok', 'Intonato'],
    [11, 'near', 'Un po’ crescente (+11 cent)'],
    [-25, 'near', 'Un po’ calante (−25 cent)'],
    [26, 'off', 'Crescente (+26 cent)'],
    [-48, 'off', 'Calante (−48 cent)'],
  ])('%i cent → %s, %s', (cents, level, label) => expect(tuningVerdict(cents)).toEqual({ level, label }));
});

/** Canto simulato al tuner: `pitchAt(ms)` → altezza; restituisce le letture dopo `settleMs`. */
function sing(pitchAt, { fps = 60, secs = 3, settleMs = 500 } = {}) {
  const t = new TunerReadout();
  const out = [];
  for (let ms = 0; ms < secs * 1000; ms += 1000 / fps) {
    const r = t.update({ exactMidi: pitchAt(ms), timeMs: ms });
    if (ms > settleMs) out.push(r);
  }
  return out;
}
const changes = (list, pick) => list.reduce((n, r, i) => n + (i > 0 && pick(r) !== pick(list[i - 1]) ? 1 : 0), 0);
const vibrato = (center, cents) => (ms) => center + (cents / 100) * Math.sin((2 * Math.PI * 5.5 * ms) / 1000);

describe('TunerReadout', () => {
  it('nota, nome italiano e scientifico, giudizio', () => {
    const r = new TunerReadout().update({ exactMidi: 69.2, hz: 445, timeMs: 0 });
    expect(r).toMatchObject({ midi: 69, italian: 'La4', scientific: 'A4', cents: 20, hz: 445 });
    expect(r.verdict.level).toBe('near');
  });

  it.each([60, 144])('REGRESSIONE: vibrato ±40 cent a 5,5 Hz → lettura ferma, giudizio stabile (%i fps)', (fps) => {
    // prima: cent da −16 a +17 e 55 cambi di giudizio in 2,5 s
    const reads = sing(vibrato(69, 40), { fps });
    const cents = reads.map((r) => r.cents);
    expect(Math.max(...cents.map(Math.abs))).toBeLessThanOrEqual(8);
    expect(changes(reads, (r) => r.verdict.level)).toBe(0);
  });

  it('REGRESSIONE: voce sul confine fra due note (+48 cent) → il nome non salta avanti e indietro', () => {
    // prima: 28 cambi di nota in 2,5 s fra La4 e La#4
    const reads = sing(vibrato(69.48, 8));
    expect(changes(reads, (r) => r.midi)).toBe(0);
    expect(reads.at(-1).italian).toBe('La4');
  });

  it('REGRESSIONE: un errore d’ottava isolato del rilevatore non compare', () => {
    const reads = sing((ms) => (Math.floor(ms / 16.7) % 40 === 0 ? 76 : 64));
    expect(reads.every((r) => r.midi === 64)).toBe(true);
  });

  it('una nota nuova cantata davvero compare subito (entro 150 ms), senza trascinare la precedente', () => {
    const t = new TunerReadout();
    for (let ms = 0; ms < 1000; ms += 16.7) t.update({ exactMidi: 60, timeMs: ms });
    let shownAt = null;
    for (let ms = 1000; ms < 1600; ms += 16.7) {
      const r = t.update({ exactMidi: 64.1, timeMs: ms });
      if (shownAt === null && r.midi === 64) shownAt = ms - 1000;
    }
    expect(shownAt).not.toBeNull();
    expect(shownAt).toBeLessThanOrEqual(150);
    expect(t.update({ exactMidi: 64.1, timeMs: 1600 }).cents).toBe(10);
  });

  it('una correzione lenta dell’intonazione viene seguita', () => {
    const t = new TunerReadout();
    for (let ms = 0; ms < 2000; ms += 16.7) t.update({ exactMidi: 60.3, timeMs: ms });
    expect(t.update({ exactMidi: 60.3, timeMs: 2000 }).cents).toBe(30);
  });

  it('un breve buco senza altezza mantiene la lettura; un silenzio lungo la cancella', () => {
    const t = new TunerReadout({ holdMs: 300 });
    t.update({ exactMidi: 64, timeMs: 1000 });
    expect(t.update({ exactMidi: null, timeMs: 1200 })).toMatchObject({ midi: 64 });
    expect(t.update({ exactMidi: null, timeMs: 1400 })).toBeNull();
    expect(t.update({ exactMidi: null, timeMs: 1500 })).toBeNull();
  });
});
