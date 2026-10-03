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
    expect(() => parseScore({ format: 'altro', version: 1, notes: [] })).toThrow(/non è una partitura/);
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

describe('ScoreDocument: voce originale', () => {
  /** Voce con 3 semiminime a 120 BPM (0.5 s l'una) cantate con 0.2 s di ritardo rispetto allo scritto. */
  function sung() {
    const doc = new ScoreDocument();
    doc.setSettings({ bpm: 120 });
    const take = doc.addAudio({ sampleRate: 48000, samples: new Int16Array(48000 * 3) });
    doc.replaceRange(0, 0, [60, 62, 64].map((midi, i) => ({ midi, beats: 1, src: { take, start: 0.2 + i * 0.5, end: 0.6 + i * 0.5 } })));
    doc.clearHistory();
    return { doc, take };
  }

  it('una voce con audio suona la ripresa: le note restano solo per l’evidenziazione, al tempo cantato', () => {
    const { doc, take } = sung();
    const { events, clips } = doc.playbackPlan();
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ voiceId: doc.voice.id, take, mutes: [] });
    expect(clips[0].at).toBeCloseTo(-0.2); // l'istante 0 della ripresa cade 0.2 s prima dell'inizio
    expect(clips[0].from).toBeCloseTo(0.05); // 0.15 s prima della prima nota
    expect(clips[0].to).toBeCloseTo(1.9); // 0.3 s dopo l'ultima
    expect(events.every((e) => e.silent)).toBe(true);
    expect(events.map((e) => e.time)).toEqual([0, 0.5, 1].map((t) => expect.closeTo(t, 6)));
  });

  it('sorgente synth, o audio non disponibile: tutto al synth', () => {
    const { doc } = sung();
    doc.setMix(doc.voice.id, { source: 'synth' });
    expect(doc.playbackPlan().clips).toEqual([]);
    expect(doc.playbackPlan().events.some((e) => e.silent)).toBe(false);
    doc.setMix(doc.voice.id, { source: 'original' });
    doc.audio.clear();
    expect(doc.playbackPlan().clips).toEqual([]);
    expect(doc.hasAudio(doc.voice.id)).toBe(false);
  });

  it('nota modificata a mano: zittita nella ripresa e suonata dal synth alla posizione scritta', () => {
    const { doc } = sung();
    const second = doc.notes[1].id;
    doc.transpose(second, 2);
    expect(doc.get(second).edited).toBe(true);
    const { events, clips } = doc.playbackPlan();
    expect(clips[0].mutes).toEqual([[0.7, 1.1].map((t) => expect.closeTo(t, 6))]);
    const synth = events.filter((e) => !e.silent);
    expect(synth).toEqual([expect.objectContaining({ id: second, midi: 64, time: 0.5 })]);
  });

  it('nota duplicata: la copia non viene dalla registrazione', () => {
    const { doc } = sung();
    const copy = doc.duplicate(doc.notes[0].id);
    expect(doc.get(copy).src).toBeUndefined();
    expect(doc.playbackPlan().events.find((e) => e.id === copy).silent).toBeUndefined();
  });

  it('riascolto da una nota: la ripresa riparte da lì', () => {
    const { doc } = sung();
    const { events, clips } = doc.playbackPlan(doc.notes[2].id);
    expect(clips[0].at).toBeCloseTo(-1.2); // la terza nota (cantata a 1.2 s) cade all'istante 0
    expect(events.map((e) => e.id)).toEqual([doc.notes[2].id]);
  });

  it('salvataggio: senza audio il file ha solo la partitura; con audio si riapre identico', () => {
    const { doc } = sung();
    doc.audio.get(doc.notes[0].src.take).samples.set([1, -2, 3]);
    expect(JSON.stringify(doc.toJSON())).not.toContain('pcm16');
    expect(doc.toJSON().voices[0].notes[0]).toEqual({ midi: 60, beats: 1 });

    const copy = new ScoreDocument();
    copy.load(JSON.parse(JSON.stringify(doc.toJSON({ includeAudio: true }))));
    expect(copy.hasAudio(copy.voice.id)).toBe(true);
    const take = copy.notes[0].src.take;
    expect([...copy.audio.get(take).samples.slice(0, 3)]).toEqual([1, -2, 3]);
    expect(copy.audio.get(take).sampleRate).toBe(48000);
    expect(copy.playbackPlan().clips).toHaveLength(1);
  });

  it('un file aperto non confonde le sue riprese con quelle già in memoria', () => {
    const { doc } = sung();
    const saved = JSON.parse(JSON.stringify(doc.toJSON({ includeAudio: true })));
    const other = sung().doc; // ha già una ripresa "t1"
    other.load(saved);
    expect(other.audio.size).toBe(2);
    expect(other.notes[0].src.take).not.toBe('t1');
  });

  it('audio non valido nel file: errore chiaro, documento invariato', () => {
    const { doc } = sung();
    const bad = { ...doc.toJSON({ includeAudio: true }), audio: { t1: { sampleRate: 48000, pcm16: '$$$' } } };
    expect(() => new ScoreDocument().load(bad)).toThrow(/Audio originale non valido/);
  });
});

describe('ScoreDocument: audio perso e voce svuotata', () => {
  function recorded() {
    const doc = new ScoreDocument();
    const take = doc.addAudio({ sampleRate: 48000, samples: new Int16Array(48000) });
    doc.replaceRange(0, 0, [{ midi: 60, beats: 1, src: { take, start: 0.1, end: 0.5 } }]);
    return doc;
  }

  it('REGRESSIONE: dopo un ricaricamento (bozza senza audio) la voce dice che l’audio originale è perso', () => {
    const doc = recorded();
    expect(doc.lostAudio(doc.voice.id)).toBe(false);
    const reloaded = new ScoreDocument();
    reloaded.load(JSON.parse(JSON.stringify(doc.toJSON({ keepSources: true }))));
    expect(reloaded.hasAudio(reloaded.voice.id)).toBe(false);
    expect(reloaded.lostAudio(reloaded.voice.id)).toBe(true);
    expect(reloaded.playbackPlan().clips).toEqual([]); // suona il synth
    expect(reloaded.playbackPlan().events.some((e) => e.silent)).toBe(false);
  });

  it('una ripresa nuova non viene mai collegata alle note di una ripresa persa', () => {
    const reloaded = new ScoreDocument();
    reloaded.load(JSON.parse(JSON.stringify(recorded().toJSON({ keepSources: true }))));
    reloaded.addAudio({ sampleRate: 48000, samples: new Int16Array(10) }); // id nuovo, mai "lost-…"
    expect(reloaded.hasAudio(reloaded.voice.id)).toBe(false);
    expect(reloaded.lostAudio(reloaded.voice.id)).toBe(true);
  });

  it('il file salvato senza audio resta pulito (nessun collegamento alle riprese)', () => {
    expect(JSON.stringify(recorded().toJSON())).not.toContain('"src"');
  });

  it('svuota la voce: note cancellate, voce e impostazioni restano, Ctrl+Z le riporta', () => {
    const doc = recorded();
    doc.renameVoice(doc.voice.id, 'Soprano');
    doc.setVoiceClef(doc.voice.id, 'treble');
    doc.clearVoice(doc.voice.id);
    expect(doc.voice.notes).toEqual([]);
    expect(doc.voice).toMatchObject({ name: 'Soprano', clef: 'treble' });
    expect(doc.hasAudio(doc.voice.id)).toBe(false);
    doc.undo();
    expect(doc.voice.notes.map((n) => n.midi)).toEqual([60]);
    expect(doc.hasAudio(doc.voice.id)).toBe(true); // l'audio era rimasto in memoria
  });
});

describe('ScoreDocument: durata e loop', () => {
  it('il giro del loop finisce a fine battuta, dalla voce più lunga; parte dalla nota selezionata', () => {
    const doc = new ScoreDocument();
    doc.setSettings({ bpm: 120, timeSignature: '4/4' }); // 1 beat = 0.5 s
    doc.append({ midi: 60, beats: 1 });
    const second = doc.append({ midi: 62, beats: 1 });
    const v2 = doc.addVoice();
    doc.append({ midi: 48, beats: 5 }, v2); // la più lunga: 5 beats → 2 battute
    expect(doc.lengthBeats).toBe(5);
    expect(doc.loopSeconds()).toBe(4); // 8 beats
    expect(doc.loopSeconds(second)).toBe(3.5); // da beat 1
  });

  it('partitura vuota: giro di durata zero', () => {
    expect(new ScoreDocument().loopSeconds()).toBe(0);
  });
});

describe('ScoreDocument: volume per voce', () => {
  it('volume nel mixer: limitato, salvato nel file, non annullabile; arriva al riascolto e alle riprese', () => {
    const doc = new ScoreDocument();
    const take = doc.addAudio({ sampleRate: 48000, samples: new Int16Array(48000) });
    doc.replaceRange(0, 0, [{ midi: 60, beats: 1, src: { take, start: 0.1, end: 0.5 } }]);
    const v2 = doc.addVoice();
    doc.append({ midi: 48, beats: 1 }, v2);
    expect(doc.voices.map((v) => v.volumeDb)).toEqual([0, 0]);

    doc.setMix(v2, { volumeDb: -12 });
    doc.setMix(doc.voices[0].id, { volumeDb: 99 }); // oltre il massimo
    expect(doc.voices.map((v) => v.volumeDb)).toEqual([6, -12]);

    const { events, clips } = doc.playbackPlan();
    expect(events.find((e) => e.voiceId === v2).gainDb).toBe(-12);
    expect(clips[0].gainDb).toBe(6);

    const rev = doc.revision;
    doc.transpose(doc.voices[1].notes[0].id, 1);
    doc.undo(); // annulla la trasposizione: il volume resta
    expect(doc.voiceById(v2).volumeDb).toBe(-12);
    expect(doc.revision).toBeGreaterThan(rev);

    const copy = new ScoreDocument();
    copy.load(JSON.parse(JSON.stringify(doc.toJSON())));
    expect(copy.voices.map((v) => v.volumeDb)).toEqual([6, -12]);
  });

  it('file senza volume (versioni precedenti) o con valori assurdi: 0 dB', () => {
    const doc = new ScoreDocument();
    doc.load({ format: 'vocascore', version: 2, voices: [{ name: 'A', notes: [] }, { name: 'B', volumeDb: 'forte', notes: [] }] });
    expect(doc.voices.map((v) => v.volumeDb)).toEqual([0, 0]);
  });
});
