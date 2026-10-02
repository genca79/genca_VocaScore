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

describe('ScoreDocument: voci', () => {
  it('aggiungi, rinomina, elimina: annullabili; l’ultima voce non si elimina', () => {
    const doc = new ScoreDocument();
    const first = doc.voice.id;
    const second = doc.addVoice();
    expect(doc.voices.map((v) => v.name)).toEqual(['Voce 1', 'Voce 2']);
    expect(doc.voice.id).toBe(second); // la nuova voce diventa attiva
    doc.renameVoice(second, '  Tenore  ');
    expect(doc.voiceById(second).name).toBe('Tenore');
    doc.renameVoice(second, '   '); // nome vuoto: resta il precedente
    expect(doc.voiceById(second).name).toBe('Tenore');
    doc.removeVoice(second);
    expect(doc.voices).toHaveLength(1);
    expect(doc.voice.id).toBe(first);
    doc.removeVoice(first);
    expect(doc.voices).toHaveLength(1);
    doc.undo(); // ripristina "Tenore"
    expect(doc.voices.map((v) => v.name)).toEqual(['Voce 1', 'Tenore']);
  });

  it('le note si modificano per id in qualsiasi voce; indici relativi alla propria voce', () => {
    const doc = docWith([{ midi: 60, beats: 1 }]);
    const v2 = doc.addVoice();
    const id = doc.append({ midi: 67, beats: 1 }, v2);
    doc.setActiveVoice(doc.voices[0].id);
    doc.transpose(id, 1);
    expect(doc.get(id).midi).toBe(68);
    expect(doc.indexOf(id)).toBe(0);
    expect(doc.voiceOf(id).id).toBe(v2);
    expect(doc.describe(id)).toBe('Voce 2: G#4 · 1 ♩');
  });

  it('riascolto polifonico: tutte le voci insieme, in ordine di tempo, ognuna col suo strumento', () => {
    const doc = docWith([{ midi: 72, beats: 1 }, { midi: 74, beats: 1 }]);
    const v2 = doc.addVoice();
    doc.append({ midi: 60, beats: 2 }, v2);
    doc.setMix(v2, { instrument: 'organ' });
    doc.setSettings({ bpm: 120 });
    expect(doc.playbackEvents().map(({ time, midi, instrument }) => [time, midi, instrument])).toEqual([
      [0, 72, null],
      [0, 60, 'organ'],
      [0.5, 74, null],
    ]);
  });

  it('muto e solo', () => {
    const doc = docWith([{ midi: 72, beats: 1 }]);
    const v2 = doc.addVoice();
    doc.append({ midi: 60, beats: 1 }, v2);
    const midis = () => doc.playbackEvents().map((e) => e.midi);
    doc.setMix(v2, { muted: true });
    expect(midis()).toEqual([72]);
    doc.setMix(v2, { muted: false, solo: true });
    expect(midis()).toEqual([60]);
    doc.setMix(doc.voices[0].id, { solo: true }); // due voci in solo: si sentono entrambe
    expect(midis().sort()).toEqual([60, 72]);
  });

  it('riascolto da una nota selezionata: tutte le voci ripartono dallo stesso movimento', () => {
    const doc = docWith([{ midi: 72, beats: 1 }, { midi: 74, beats: 1 }]);
    const v2 = doc.addVoice();
    doc.append({ midi: 60, beats: 1 }, v2);
    const second = doc.append({ midi: 62, beats: 1 }, v2);
    expect(doc.playbackEvents(second).map((e) => [e.time, e.midi])).toEqual([
      [0, 74],
      [0, 62],
    ]);
    expect(doc.playbackEvents(null, { fromBeat: 1, excludeVoiceId: v2 }).map((e) => e.midi)).toEqual([74]);
  });

  it('mixer e voce attiva non entrano in annulla/ripeti e non cambiano la revisione', () => {
    const doc = docWith([{ midi: 60, beats: 1 }]);
    const id = doc.notes[0].id;
    const v1 = doc.voice.id;
    const v2 = doc.addVoice();
    doc.transpose(id, 2);
    const rev = doc.revision;
    doc.setMix(v1, { muted: true });
    doc.setActiveVoice(v1);
    expect(doc.revision).toBe(rev);
    doc.undo(); // annulla la trasposizione…
    expect(doc.get(id).midi).toBe(60);
    expect(doc.voiceById(v1).muted).toBe(true); // …ma la voce resta muta
    expect(doc.voiceById(v2)).not.toBeNull();
  });

  it('importVoices: più voci in un passo; la voce attiva vuota viene riempita dalla prima', () => {
    const doc = new ScoreDocument();
    const ids = doc.importVoices(
      [
        { name: 'Soprano', notes: [{ midi: 72, beats: 1 }] },
        { name: 'Basso', notes: [{ midi: 48, beats: 1 }] },
      ],
      { bpm: 100 },
    );
    expect(doc.voices.map((v) => v.name)).toEqual(['Soprano', 'Basso']);
    expect(ids).toEqual(doc.voices.map((v) => v.id));
    expect(doc.settings.bpm).toBe(100);
    doc.undo();
    expect(doc.voices.map((v) => v.name)).toEqual(['Voce 1']);
    expect(doc.settings.bpm).toBe(90);
  });

  it('"Nuovo" torna a una sola voce (annullabile)', () => {
    const doc = new ScoreDocument();
    doc.addVoice('B');
    doc.append({ midi: 60, beats: 1 });
    doc.clear();
    expect(doc.voices.map((v) => v.name)).toEqual(['Voce 1']);
    doc.undo();
    expect(doc.voices.map((v) => v.name)).toEqual(['Voce 1', 'B']);
  });

  it('isEmpty considera tutte le voci', () => {
    const doc = new ScoreDocument();
    const v2 = doc.addVoice();
    expect(doc.isEmpty).toBe(true);
    doc.append({ midi: 60, beats: 1 }, v2);
    doc.setActiveVoice(doc.voices[0].id);
    expect(doc.isEmpty).toBe(false);
  });
});

describe('ScoreDocument: file', () => {
  it('salva e ricarica senza perdite', () => {
    const doc = docWith([{ midi: 61, beats: 1.5 }, { midi: null, beats: 0.5 }]);
    doc.setSettings({ title: 'Canzone', bpm: 100, timeSignature: '3/4', showNoteNames: false });
    doc.setVoiceClef(doc.voice.id, 'bass');
    const json = JSON.parse(JSON.stringify(doc.toJSON()));
    const copy = new ScoreDocument();
    copy.load(json);
    expect(copy.toJSON()).toEqual(doc.toJSON());
  });

  it('partitura a più voci: salva e ricarica nomi, chiavi, mixer, note e voce attiva', () => {
    const doc = docWith([{ midi: 72, beats: 2 }]);
    doc.renameVoice(doc.voice.id, 'Soprano');
    const alto = doc.addVoice('Contralto');
    doc.append({ midi: 65, beats: 1 }, alto);
    doc.setVoiceClef(alto, 'treble');
    doc.setMix(alto, { instrument: 'organ', muted: true });
    const copy = new ScoreDocument();
    copy.load(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(copy.toJSON()).toEqual(doc.toJSON());
    expect(copy.voices.map((v) => v.name)).toEqual(['Soprano', 'Contralto']);
    expect(copy.voice.name).toBe('Contralto');
    expect(copy.voices[1]).toMatchObject({ clef: 'treble', instrument: 'organ', muted: true, solo: false });
  });

  it('file della versione 1 (una sola voce): si apre come partitura con una voce', () => {
    const doc = new ScoreDocument();
    doc.load({ format: 'vocascore', version: 1, title: 'Vecchio', bpm: 80, timeSignature: '4/4', clef: 'bass', notes: [{ midi: 48, beats: 2 }] });
    expect(doc.voices).toHaveLength(1);
    expect(doc.voices[0]).toMatchObject({ name: 'Voce 1', clef: 'bass' });
    expect(doc.notes.map((n) => n.midi)).toEqual([48]);
    expect(doc.settings).toMatchObject({ title: 'Vecchio', bpm: 80 });
  });

  it('rifiuta file non validi con messaggi chiari', () => {
    expect(() => parseScore(null)).toThrow(ScoreFormatError);
    expect(() => parseScore({ format: 'altro', version: 1, notes: [] })).toThrow(/non è uno spartito/);
    expect(() => parseScore({ format: 'vocascore', version: 99, notes: [] })).toThrow(/più recente/);
    expect(() => parseScore({ format: 'vocascore', version: 1, notes: [{ midi: 'x', beats: 1 }] })).toThrow(/Nota 1/);
    expect(() => parseScore({ format: 'vocascore', version: 2, voices: [] })).toThrow(/non contiene voci/);
    const twoVoices = { format: 'vocascore', version: 2, voices: [{ name: 'S', notes: [] }, { name: 'A', notes: [{ beats: -1 }] }] };
    expect(() => parseScore(twoVoices)).toThrow(/Nota 1 della voce "A"/);
  });

  it('un caricamento fallito non modifica il documento', () => {
    const doc = docWith([{ midi: 60, beats: 1 }]);
    expect(() => doc.load({ format: 'x' })).toThrow();
    expect(doc.notes).toHaveLength(1);
    expect(doc.canUndo).toBe(false);
  });
});
