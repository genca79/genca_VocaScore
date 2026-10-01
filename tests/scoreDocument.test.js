import { describe, expect, it } from 'vitest';
import { ScoreDocument, ScoreFormatError, parseScore } from '../src/music/scoreDocument.js';

function docWith(notes) {
  const doc = new ScoreDocument();
  for (const note of notes) doc.append(note);
  doc.clearHistory();
  return doc;
}

describe('ScoreDocument: modifiche', () => {
  it('trasposizione, durata, nota/pausa', () => {
    const doc = docWith([{ midi: 60, beats: 1 }]);
    const id = doc.notes[0].id;
    doc.transpose(id, 1);
    expect(doc.get(id).midi).toBe(61);
    doc.transpose(id, -12);
    expect(doc.get(id).midi).toBe(49);
    doc.setBeats(id, 1.5);
    expect(doc.get(id).beats).toBe(1.5);
    doc.toggleRest(id);
    expect(doc.get(id).midi).toBeNull();
    doc.toggleRest(id);
    expect(doc.get(id).midi).toBe(49); // ritorna all'altezza precedente
  });

  it('le durate vengono agganciate alla griglia della semicroma', () => {
    const doc = docWith([{ midi: 60, beats: 1.1 }]);
    expect(doc.notes[0].beats).toBe(1);
  });

  it('duplica ed elimina', () => {
    const doc = docWith([{ midi: 60, beats: 1 }, { midi: 64, beats: 1 }]);
    const copy = doc.duplicate(doc.notes[0].id);
    expect(doc.notes.map((n) => n.midi)).toEqual([60, 60, 64]);
    doc.remove(copy);
    expect(doc.notes.map((n) => n.midi)).toEqual([60, 64]);
  });

  it('annulla e ripeti', () => {
    const doc = docWith([{ midi: 60, beats: 1 }]);
    const id = doc.notes[0].id;
    doc.transpose(id, 2);
    doc.setSettings({ bpm: 120 });
    doc.undo();
    expect(doc.settings.bpm).toBe(90);
    doc.undo();
    expect(doc.get(id).midi).toBe(60);
    expect(doc.canUndo).toBe(false);
    doc.redo();
    expect(doc.get(id).midi).toBe(62);
  });

  it('replaceRange: sostituzione in un solo passo annullabile, revisione aggiornata', () => {
    const doc = docWith([{ midi: 60, beats: 1 }, { midi: 61, beats: 1 }, { midi: 62, beats: 1 }, { midi: 63, beats: 1 }]);
    const rev = doc.revision;
    doc.replaceRange(1, 3, [{ midi: 70, beats: 2 }, { midi: null, beats: 0.5 }, { midi: 71, beats: 0.5 }]);
    expect(doc.notes.map((n) => n.midi)).toEqual([60, 70, null, 71, 63]);
    expect(doc.revision).toBeGreaterThan(rev);
    doc.undo();
    expect(doc.notes.map((n) => n.midi)).toEqual([60, 61, 62, 63]);
    expect(() => doc.replaceRange(3, 9, [])).toThrow(RangeError);
  });

  it('"Nuovo" è annullabile', () => {
    const doc = docWith([{ midi: 60, beats: 1 }]);
    doc.setSettings({ title: 'Prova' });
    doc.clear();
    expect(doc.notes).toHaveLength(0);
    doc.undo();
    expect(doc.notes).toHaveLength(1);
    expect(doc.settings.title).toBe('Prova');
  });

  it('impostazioni validate (BPM nei limiti, tempo ammesso)', () => {
    const doc = new ScoreDocument();
    doc.setSettings({ bpm: 1000, timeSignature: '7/4' });
    expect(doc.settings.bpm).toBe(240);
    expect(doc.settings.timeSignature).toBe('4/4');
  });

  it('eventi di riascolto ai BPM correnti, anche da una nota selezionata', () => {
    const doc = docWith([{ midi: 60, beats: 1 }, { midi: null, beats: 1 }, { midi: 64, beats: 2 }]);
    doc.setSettings({ bpm: 120 }); // 1 beat = 0.5 s
    expect(doc.playbackEvents().map(({ time, duration, midi }) => ({ time, duration, midi }))).toEqual([
      { time: 0, duration: 0.5, midi: 60 },
      { time: 1, duration: 1, midi: 64 },
    ]);
    expect(doc.playbackEvents(doc.notes[2].id)[0]).toMatchObject({ time: 0, midi: 64 });
  });
});

describe('ScoreDocument: file', () => {
  it('salva e ricarica senza perdite', () => {
    const doc = docWith([{ midi: 61, beats: 1.5 }, { midi: null, beats: 0.5 }]);
    doc.setSettings({ title: 'Canzone', bpm: 100, timeSignature: '3/4', clef: 'bass', showNoteNames: false });
    const json = JSON.parse(JSON.stringify(doc.toJSON()));
    const copy = new ScoreDocument();
    copy.load(json);
    expect(copy.toJSON()).toEqual(doc.toJSON());
  });

  it('rifiuta file non validi con messaggi chiari', () => {
    expect(() => parseScore(null)).toThrow(ScoreFormatError);
    expect(() => parseScore({ format: 'altro', version: 1, notes: [] })).toThrow(/non è uno spartito/);
    expect(() => parseScore({ format: 'vocascore', version: 99, notes: [] })).toThrow(/più recente/);
    expect(() => parseScore({ format: 'vocascore', version: 1, notes: [{ midi: 'x', beats: 1 }] })).toThrow(/Nota 1/);
  });

  it('un caricamento fallito non modifica il documento', () => {
    const doc = docWith([{ midi: 60, beats: 1 }]);
    expect(() => doc.load({ format: 'x' })).toThrow();
    expect(doc.notes).toHaveLength(1);
    expect(doc.canUndo).toBe(false);
  });
});
