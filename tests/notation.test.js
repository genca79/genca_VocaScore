import { describe, expect, it } from 'vitest';
import { figuresForBeats, layoutMeasures, quantizeBeats, timeSignatureInfo } from '../src/music/notation.js';

const fig = (s) => s.duration + (s.dots ? '.' : '');
let nextId = 0;
const n = (midi, beats) => ({ id: `t${nextId++}`, midi, beats });

describe('figure e quantizzazione', () => {
  it('figuresForBeats copre qualsiasi multiplo della semicroma', () => {
    expect(figuresForBeats(9).map(fig)).toEqual(['w', 'w', 'q']);
    expect(figuresForBeats(2.5).map(fig)).toEqual(['h', '8']);
    expect(figuresForBeats(1.75).map(fig)).toEqual(['q.', '16']);
    expect(figuresForBeats(3).map(fig)).toEqual(['h.']);
  });

  it('quantizeBeats: figura vicina per note brevi, movimento intero per quelle lunghe', () => {
    expect(quantizeBeats(1000, 60)).toBe(1);
    expect(quantizeBeats(1550, 60)).toBe(1.5);
    expect(quantizeBeats(4400, 60)).toBe(4);
    expect(quantizeBeats(6000, 90)).toBe(9);
  });

  it('indicazioni di tempo', () => {
    expect(timeSignatureInfo('4/4').measureBeats).toBe(4);
    expect(timeSignatureInfo('3/4').measureBeats).toBe(3);
    expect(timeSignatureInfo('6/8').measureBeats).toBe(3);
    expect(timeSignatureInfo('2/4').measureBeats).toBe(2);
  });
});

describe('layoutMeasures', () => {
  it('riempie le battute in 4/4', () => {
    const m = layoutMeasures([n(60, 1), n(62, 1), n(64, 2), n(65, 4)], '4/4');
    expect(m).toHaveLength(2);
    expect(m[0].map(fig)).toEqual(['q', 'q', 'h']);
    expect(m[1].map(fig)).toEqual(['w']);
  });

  it('una nota che attraversa la stanghetta viene spezzata e legata', () => {
    // in 3/4: semiminima + nota da 4 beats → 2 beats nella 1ª battuta, 2 nella 2ª
    const m = layoutMeasures([n(60, 1), n(67, 4)], '3/4');
    expect(m.map((x) => x.map(fig))).toEqual([['q', 'h'], ['h']]);
    expect(m[0][1].tieNext).toBe(true);
    expect(m[1][0].first).toBe(false);
  });

  it('le pause non si legano', () => {
    const m = layoutMeasures([n(60, 3), n(null, 3)], '4/4');
    expect(m.flat().filter((s) => s.tieNext)).toHaveLength(0);
  });

  it('nota lunghissima in 4/4: una semibreve per battuta, tutte legate', () => {
    const m = layoutMeasures([n(60, 12)], '4/4');
    expect(m.map((x) => x.map(fig))).toEqual([['w'], ['w'], ['w']]);
    expect(m.flat().map((s) => s.tieNext)).toEqual([true, true, false]);
  });
});

describe('alterazioni', () => {
  const acc = (measures) => measures.map((m) => m.map((s) => s.accidental));

  it('il diesis vale per tutta la battuta, il bequadro lo annulla', () => {
    // C#4 C#4 C4 C#4 | C#4
    const m = layoutMeasures([n(61, 1), n(61, 1), n(60, 1), n(61, 1), n(61, 4)], '4/4');
    expect(acc(m)).toEqual([['#', null, 'n', '#'], ['#']]);
  });

  it('la continuazione legata oltre la stanghetta non ripete l’alterazione', () => {
    const m = layoutMeasures([n(60, 3), n(66, 2), n(66, 1)], '4/4');
    // F#4 legato a cavallo della battuta, poi F#4 nella stessa battuta: nessuna alterazione ripetuta
    expect(acc(m)).toEqual([[null, '#'], [null, null]]);
  });

  it('ottave diverse sono indipendenti', () => {
    const m = layoutMeasures([n(61, 1), n(73, 1)], '4/4');
    expect(acc(m)).toEqual([['#', '#']]);
  });
});
