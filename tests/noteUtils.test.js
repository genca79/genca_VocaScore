import { describe, expect, it } from 'vitest';
import { hzToMidi, hzToNote, midiToHz, midiToNoteName, midiToVexKey } from '../src/music/noteUtils.js';
import { chooseClef, quantizeDuration } from '../src/music/notation.js';

describe('noteUtils', () => {
  it('A4 = 440 Hz = MIDI 69', () => {
    expect(hzToMidi(440)).toBe(69);
    expect(midiToHz(69)).toBe(440);
    expect(midiToNoteName(69)).toBe('A4');
  });

  it("un'ottava sopra raddoppia la frequenza (+12 semitoni)", () => {
    expect(hzToMidi(880)).toBeCloseTo(81, 10);
    expect(midiToHz(57)).toBeCloseTo(220, 10);
  });

  it('Do centrale (261.63 Hz) → C4', () => {
    const note = hzToNote(261.63);
    expect(note.midi).toBe(60);
    expect(note.name).toBe('C4');
    expect(Math.abs(note.cents)).toBeLessThanOrEqual(1);
  });

  it('nomi con diesis e ottave', () => {
    expect(midiToNoteName(75)).toBe('D#5');
    expect(midiToNoteName(36)).toBe('C2');
    expect(midiToNoteName(0)).toBe('C-1');
  });

  it('cents: 25 cents sopra A4 restano A4 con +25', () => {
    const note = hzToNote(440 * 2 ** (25 / 1200));
    expect(note.name).toBe('A4');
    expect(note.cents).toBe(25);
  });

  it('input non valido → null', () => {
    expect(hzToNote(0)).toBeNull();
    expect(hzToNote(-10)).toBeNull();
    expect(hzToNote(NaN)).toBeNull();
  });

  it('chiavi VexFlow con alterazione separata', () => {
    expect(midiToVexKey(61)).toEqual({ key: 'c#/4', accidental: '#' });
    expect(midiToVexKey(48)).toEqual({ key: 'c/3', accidental: null });
  });
});

describe('notation', () => {
  const bpm = 60; // 1 movimento = 1000 ms: semplifica i conti

  it('quantizza le durate alla figura più vicina', () => {
    expect(quantizeDuration(1000, bpm)).toMatchObject({ duration: 'q', dots: 0 });
    expect(quantizeDuration(520, bpm)).toMatchObject({ duration: '8', dots: 0 });
    expect(quantizeDuration(1550, bpm)).toMatchObject({ duration: 'q', dots: 1 });
    expect(quantizeDuration(2100, bpm)).toMatchObject({ duration: 'h', dots: 0 });
    expect(quantizeDuration(9000, bpm)).toMatchObject({ duration: 'w' });
    expect(quantizeDuration(30, bpm)).toMatchObject({ duration: '16' });
  });

  it('chiave automatica con isteresi', () => {
    expect(chooseClef([48, 50, 52], 'treble')).toBe('bass'); // voce grave
    expect(chooseClef([67, 69, 72], 'bass')).toBe('treble'); // voce acuta
    expect(chooseClef([58, 60, 59], 'bass')).toBe('bass'); // fascia intermedia: resta
    expect(chooseClef([58, 60, 59], 'treble')).toBe('treble');
    expect(chooseClef([], 'bass')).toBe('bass');
  });
});
