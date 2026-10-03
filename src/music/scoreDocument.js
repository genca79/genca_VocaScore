import { GRID, TIME_SIGNATURES, timeSignatureInfo } from './notation.js';
import { midiToNoteName } from './noteUtils.js';
import { base64ToPcm16, pcm16ToBase64 } from '../storage/pcm.js';

/**
 * Documento dello spartito: impostazioni + una o più VOCI (partitura), con annulla/ripeti.
 *
 * È la fonte di verità per pentagramma, riascolto, salvataggio e stampa.
 * Le durate sono in beats (semiminime), non in millisecondi: lo spartito è musica scritta,
 * quindi cambiare i BPM ne cambia la velocità di esecuzione, non le figure.
 *
 * Voci: ognuna ha un nome scelto dall'utente, una chiave, e le sue note; tutte partono dalla battuta 1
 * e si leggono in parallelo. La "voce attiva" è quella in cui si registra e che si modifica
 * (selezionare una nota rende attiva la sua voce). Gli id delle note sono unici in tutto il documento.
 *
 * Due tipi di modifica:
 *   - contenuto (note, nomi, chiavi, impostazioni): passa da #commit(), che salva lo stato precedente
 *     nella pila "annulla", aumenta `revision` e notifica un evento 'change';
 *   - mixer (strumento, sorgente, muto, solo) e voce attiva: si salvano nel file ma NON entrano in
 *     annulla/ripeti (annullare una nota non deve riaccendere una voce messa in muto) e non cambiano `revision`.
 *
 * Audio originale: ogni registrazione o file trascritto è una "ripresa" (take) conservata in `audio`
 * (PCM 16 bit, fuori da annulla/ripeti perché pesante). Ogni nota trascritta ricorda da quale ripresa
 * viene e quando è stata cantata davvero (`src`); una nota modificata a mano è `edited`. Nel riascolto
 * una voce con sorgente "originale" suona la sua ripresa così com'è (vedi playbackPlan).
 */

export const FORMAT_ID = 'vocascore';
export const FORMAT_VERSION = 2; // 1 = una sola voce (ancora leggibile)
export const MIN_BPM = 30;
export const MAX_BPM = 240;
export const MAX_VOICES = 8;
const MAX_NAME = 40;
const MIN_MIDI = 21; // A0, estensione del pianoforte
const MAX_MIDI = 108; // C8
const MAX_BEATS = 64;
const HISTORY_LIMIT = 200;
const CLEFS = ['auto', 'treble', 'bass'];

export const DEFAULT_SETTINGS = Object.freeze({
  title: '',
  bpm: 90,
  timeSignature: '4/4',
  showNoteNames: true,
  // quantizzazione della registrazione: 'auto' (per movimento) oppure griglia fissa in beats
  // (1 = semiminima, 0.5 = croma, 0.25 = semicroma)
  grid: 'auto',
  metronome: true, // metronomo con battuta di attacco durante la registrazione
  refine: true, // allo Stop, rianalisi dell'intera registrazione al posto della trascrizione fatta durante il canto
  legato: true, // una nota staccata viene scritta lunga fino all'attacco successivo, se il silenzio è breve
});

export const GRID_OPTIONS = [
  { value: 'auto', label: 'Automatica' },
  { value: 1, label: 'Semiminime (1/4)' },
  { value: 0.5, label: 'Crome (1/8)' },
  { value: 0.25, label: 'Semicrome (1/16)' },
];

/** Errore di formato durante il caricamento di un file. */
export class ScoreFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScoreFormatError';
  }
}

const clampMidi = (m) => Math.min(MAX_MIDI, Math.max(MIN_MIDI, Math.round(m)));
const snapBeats = (b) => Math.min(MAX_BEATS, Math.max(GRID, Math.round(b / GRID) * GRID));
const cleanName = (name, fallback) => String(name ?? '').trim().slice(0, MAX_NAME) || fallback;
/** Volume di una voce nel mix (dB rispetto al livello normale). */
export const MIN_VOICE_DB = -30;
export const MAX_VOICE_DB = 6;
const clampVolume = (db) => {
  const v = Math.round(Number(db));
  return Number.isFinite(v) ? Math.min(MAX_VOICE_DB, Math.max(MIN_VOICE_DB, v)) : 0;
};
const totalBeats = (notes) => notes.reduce((sum, n) => sum + n.beats, 0);

/**
 * @typedef {{ take:string, start:number, end:number }} NoteSource
 *   da quale ripresa viene la nota e quando è stata cantata (s dall'inizio della ripresa)
 * @typedef {{ id:string, midi:number|null, beats:number, restoreMidi?:number, src?:NoteSource, edited?:boolean }} Note
 * @typedef {{ id:string, name:string, clef:'auto'|'treble'|'bass', instrument:string|null,
 *             source:'original'|'synth', volumeDb:number, muted:boolean, solo:boolean, notes:Note[] }} Voice
 *   volumeDb: volume della voce nel mix, in dB (0 = normale; da MIN_VOICE_DB a MAX_VOICE_DB)
 *   instrument null = lo strumento generale di "Suono Synth"; source 'original' = nel riascolto la
 *   voce originale, se c'è il suo audio (altrimenti il synth)
 * @typedef {{ sampleRate:number, samples:Int16Array }} Take audio di una ripresa
 */

/** Prefisso degli id di ripresa il cui audio non è più disponibile (mai generati da addAudio). */
const LOST_TAKE = 'lost-';

/** Margini attorno alle note quando si suona una ripresa: l'attacco e la coda della voce. */
const CLIP_LEAD_SEC = 0.15;
const CLIP_TAIL_SEC = 0.3;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function cleanSource(src) {
  if (!src || typeof src.take !== 'string' || src.take.length > 32) return undefined;
  const start = Number(src.start);
  const end = Number(src.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return undefined;
  return { take: src.take, start, end };
}

export class ScoreDocument extends EventTarget {
  constructor() {
    super();
    this.settings = { ...DEFAULT_SETTINGS };
    this.nextId = 1;
    this.nextVoiceId = 1;
    this.nextTakeId = 1;
    /** @type {Map<string, Take>} audio originale delle riprese (fuori da annulla/ripeti) */
    this.audio = new Map();
    /** @type {Voice[]} */
    this.voices = [this.#newVoice('Voce 1')];
    this.activeVoiceId = this.voices[0].id;
    this.undoStack = [];
    this.redoStack = [];
    /** Cresce a ogni modifica del contenuto: permette di sapere se il documento è cambiato nel frattempo. */
    this.revision = 0;
  }

  // ── Lettura ────────────────────────────────────────────────────────────

  /** Voce attiva (registrazione e modifica). */
  get voice() {
    return this.voiceById(this.activeVoiceId) ?? this.voices[0];
  }

  /** Note della voce attiva. */
  get notes() {
    return this.voice.notes;
  }

  get isEmpty() {
    return !this.voices.some((v) => v.notes.some((n) => n.midi !== null));
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  voiceById(voiceId) {
    return this.voices.find((v) => v.id === voiceId) ?? null;
  }

  /** Voce che contiene la nota `id` (null se non esiste). */
  voiceOf(id) {
    return this.voices.find((v) => v.notes.some((n) => n.id === id)) ?? null;
  }

  /** Posizione della nota nella SUA voce (−1 se non esiste). */
  indexOf(id) {
    const voice = this.voiceOf(id);
    return voice ? voice.notes.findIndex((n) => n.id === id) : -1;
  }

  get(id) {
    return this.voiceOf(id)?.notes.find((n) => n.id === id) ?? null;
  }

  /** Nome leggibile di un elemento, per la UI ("C#4 · 1.5 ♩", con la voce se sono più d'una). */
  describe(id) {
    const note = this.get(id);
    if (!note) return '';
    const what = note.midi === null ? 'Pausa' : midiToNoteName(note.midi);
    const voice = this.voices.length > 1 ? `${this.voiceOf(id).name}: ` : '';
    return `${voice}${what} · ${note.beats} ♩`;
  }

  /** Voci che si sentono nel riascolto: se qualcuna è in "solo", solo quelle; altrimenti le non mute. */
  get audibleVoices() {
    const solo = this.voices.filter((v) => v.solo);
    return solo.length > 0 ? solo : this.voices.filter((v) => !v.muted);
  }

  /**
   * Eventi per il riascolto POLIFONICO, ai BPM correnti: tutte le voci udibili insieme.
   * Si parte dalla nota `fromId` (tutte le voci dallo stesso punto) o dal movimento `fromBeat`.
   *
   * @param {string|null} [fromId]
   * @param {{ fromBeat?:number, excludeVoiceId?:string|null }} [options]
   *   excludeVoiceId: voce da non suonare (quella che si sta registrando)
   * @returns {Array<{ id:string, voiceId:string, instrument:string|null, gainDb:number, time:number, duration:number, midi:number }>}
   *   tempi in secondi dal punto di partenza, in ordine di tempo
   */
  playbackEvents(fromId = null, { fromBeat = 0, excludeVoiceId = null } = {}) {
    const secPerBeat = 60 / this.settings.bpm;
    const start = fromId && this.get(fromId) ? this.beatOf(fromId) : fromBeat;
    const events = [];
    for (const voice of this.audibleVoices) {
      if (voice.id === excludeVoiceId) continue;
      let beat = 0;
      for (const note of voice.notes) {
        if (note.midi !== null && beat >= start - 1e-9) {
          events.push({
            id: note.id,
            voiceId: voice.id,
            instrument: voice.instrument,
            gainDb: voice.volumeDb,
            time: (beat - start) * secPerBeat,
            duration: note.beats * secPerBeat,
            midi: note.midi,
          });
        }
        beat += note.beats;
      }
    }
    return events.sort((a, b) => a.time - b.time);
  }

  /**
   * Piano del riascolto: come playbackEvents, ma le voci con sorgente "originale" (e il loro audio)
   * suonano la registrazione così com'è invece del synth.
   *
   * Ogni ripresa di una voce diventa una "clip" posata sulla linea del tempo dello spartito: lo
   * scostamento è la mediana di (tempo scritto − tempo cantato) delle sue note, robusta a qualche nota
   * quantizzata lontano. Si sente il canto reale, al suo tempo reale (strada 1: niente stiramenti).
   * Nella clip:
   *   - le note NON modificate diventano solo "segnali" per evidenziarle (silent), nel momento in cui
   *     vengono cantate davvero;
   *   - le note modificate a mano vengono zittite nell'audio (mutes) e, se hanno un'altezza, suonate
   *     dal synth alla loro posizione scritta;
   *   - le note senza ripresa (scritte o duplicate a mano) restano al synth.
   *
   * @param {string|null} [fromId]
   * @param {{ fromBeat?:number, excludeVoiceId?:string|null }} [options]
   * @returns {{ events:Array<{ id:string, voiceId:string, instrument:string|null, time:number,
   *             duration:number, midi:number, silent?:boolean }>,
   *             clips:Array<{ voiceId:string, take:string, at:number, from:number, to:number,
   *             mutes:Array<[number, number]> }> }}
   *   clip: la ripresa `take` suona il suo tratto [from, to] (s della ripresa); il suo istante 0 cade
   *   al tempo `at` (s dal punto di partenza, anche negativo); mutes = tratti da zittire (s della ripresa)
   */
  playbackPlan(fromId = null, { fromBeat = 0, excludeVoiceId = null } = {}) {
    const secPerBeat = 60 / this.settings.bpm;
    const start = fromId && this.get(fromId) ? this.beatOf(fromId) : fromBeat;
    const events = this.playbackEvents(fromId, { fromBeat, excludeVoiceId });
    const byId = new Map(events.map((e) => [e.id, e]));
    const clips = [];

    for (const voice of this.audibleVoices) {
      if (voice.id === excludeVoiceId || voice.source !== 'original') continue;
      // tempo scritto (s dal punto di partenza) di ogni nota della voce
      const placed = [];
      let beat = 0;
      for (const note of voice.notes) {
        if (note.src && this.audio.has(note.src.take)) placed.push({ note, time: (beat - start) * secPerBeat });
        beat += note.beats;
      }
      for (const take of new Set(placed.map((p) => p.note.src.take))) {
        const own = placed.filter((p) => p.note.src.take === take);
        const anchors = own.filter((p) => !p.note.edited && p.note.midi !== null);
        if (anchors.length === 0) continue; // tutte modificate: resta il synth
        const at = median(anchors.map((p) => p.time - p.note.src.start));
        const from = Math.max(0, Math.min(...own.map((p) => p.note.src.start)) - CLIP_LEAD_SEC);
        const to = Math.max(...own.map((p) => p.note.src.end)) + CLIP_TAIL_SEC;
        if (at + to <= 0) continue; // la ripresa finisce prima del punto di partenza
        const mutes = own.filter((p) => p.note.edited).map((p) => [p.note.src.start, p.note.src.end]);
        clips.push({ voiceId: voice.id, take, at, from, to, mutes, gainDb: voice.volumeDb });

        for (const { note } of anchors) {
          const event = byId.get(note.id);
          if (!event) continue; // prima del punto di partenza
          event.silent = true; // la suona la ripresa: resta solo per l'evidenziazione…
          event.time = Math.max(0, at + note.src.start); // …nel momento in cui è stata cantata
          event.duration = note.src.end - note.src.start;
        }
      }
    }
    return { events: events.sort((a, b) => a.time - b.time), clips };
  }

  /** La voce ha note collegate a un audio originale disponibile? */
  hasAudio(voiceId) {
    return Boolean(this.voiceById(voiceId)?.notes.some((n) => n.src && this.audio.has(n.src.take)));
  }

  /**
   * La voce veniva da una registrazione il cui audio non c'è più (pagina ricaricata, o file salvato
   * senza audio e riaperto dalla bozza)? Nel riascolto suona il synth: va detto all'utente.
   */
  lostAudio(voiceId) {
    return Boolean(this.voiceById(voiceId)?.notes.some((n) => n.src && !this.audio.has(n.src.take)));
  }

  /** Cancella tutte le note di una voce (annullabile); la voce resta, con nome, chiave e mixer. */
  clearVoice(voiceId) {
    const voice = this.#requireVoice(voiceId);
    if (voice.notes.length === 0) return;
    this.#commit('clear-voice', () => (voice.notes = []));
  }

  /**
   * Conserva l'audio originale di una ripresa (fuori da annulla/ripeti). Restituisce l'id da usare come
   * `take` nelle note trascritte da quell'audio.
   * @param {Take} take
   */
  addAudio({ sampleRate, samples }) {
    const id = `t${this.nextTakeId++}`;
    this.audio.set(id, { sampleRate, samples });
    return id;
  }

  /** Durata della partitura in beats: la voce più lunga. */
  get lengthBeats() {
    return Math.max(0, ...this.voices.map((v) => totalBeats(v.notes)));
  }

  /**
   * Durata (s) di un giro del loop dal punto di partenza: fino alla fine della battuta che contiene
   * l'ultima nota, così il giro ricomincia a tempo.
   * @param {string|null} [fromId] nota da cui parte il riascolto (null = inizio)
   */
  loopSeconds(fromId = null) {
    const measure = timeSignatureInfo(this.settings.timeSignature).measureBeats;
    const end = Math.ceil(this.lengthBeats / measure - 1e-9) * measure;
    const start = fromId && this.get(fromId) ? this.beatOf(fromId) : 0;
    return Math.max(0, end - start) * (60 / this.settings.bpm);
  }

  /** Posizione (beats dall'inizio) della nota `id` nella sua voce. */
  beatOf(id) {
    const voice = this.voiceOf(id);
    if (!voice) return 0;
    const index = voice.notes.findIndex((n) => n.id === id);
    return totalBeats(voice.notes.slice(0, index));
  }

  // ── Modifiche alle note (tutte annullabili) ────────────────────────────

  /** Aggiunge in coda a una voce (default: la voce attiva). Restituisce l'id. */
  append({ midi, beats }, voiceId = this.voice.id) {
    const voice = this.#requireVoice(voiceId);
    let id;
    this.#commit('append', () => {
      id = this.#newId();
      voice.notes.push({ id, midi: midi === null ? null : clampMidi(midi), beats: snapBeats(beats) });
    });
    return id;
  }

  /**
   * Sostituisce gli elementi [start, end) di una voce con nuove note in un'unica modifica annullabile
   * (scrittura di una registrazione o di un file audio).
   * @param {object} [settingsPatch] impostazioni da cambiare nello stesso passo (es. BPM rilevato)
   * @param {string} [voiceId] voce (default: la voce attiva)
   */
  replaceRange(start, end, notes, settingsPatch = null, voiceId = this.voice.id) {
    const voice = this.#requireVoice(voiceId);
    if (start < 0 || end > voice.notes.length || start > end) throw new RangeError('Intervallo non valido');
    this.#commit('refine', () => {
      if (settingsPatch) this.settings = sanitizeSettings({ ...this.settings, ...settingsPatch });
      voice.notes.splice(start, end - start, ...this.#freshNotes(notes));
    });
  }

  /** Inserisce una copia dell'elemento `id` subito dopo di esso. Restituisce il nuovo id. */
  duplicate(id) {
    const voice = this.voiceOf(id);
    if (!voice) return null;
    const index = voice.notes.findIndex((n) => n.id === id);
    let newId;
    this.#commit('insert', () => {
      newId = this.#newId();
      // la copia non viene da una registrazione: nel riascolto la suona il synth
      const { src, edited, ...copy } = voice.notes[index];
      voice.notes.splice(index + 1, 0, { ...copy, id: newId });
    });
    return newId;
  }

  remove(id) {
    const voice = this.voiceOf(id);
    if (!voice) return;
    const index = voice.notes.findIndex((n) => n.id === id);
    this.#commit('remove', () => voice.notes.splice(index, 1));
  }

  /** Trasposizione in semitoni (±1 semitono, ±12 ottava). Ignorata sulle pause. */
  transpose(id, semitones) {
    const note = this.get(id);
    if (!note || note.midi === null) return;
    const midi = clampMidi(note.midi + semitones);
    if (midi === note.midi) return;
    this.#commit('edit', () => {
      note.midi = midi;
      markEdited(note);
    });
  }

  setBeats(id, beats) {
    const note = this.get(id);
    if (!note) return;
    const snapped = snapBeats(beats);
    if (snapped === note.beats) return;
    this.#commit('edit', () => {
      note.beats = snapped;
      markEdited(note);
    });
  }

  /** Nota ↔ pausa. Una pausa ridiventa nota con l'altezza della nota più vicina (o Do4). */
  toggleRest(id) {
    const voice = this.voiceOf(id);
    if (!voice) return;
    const index = voice.notes.findIndex((n) => n.id === id);
    const note = voice.notes[index];
    this.#commit('edit', () => {
      if (note.midi !== null) {
        note.restoreMidi = note.midi;
        note.midi = null;
      } else {
        note.midi = note.restoreMidi ?? nearestPitch(voice.notes, index) ?? 60;
      }
      markEdited(note);
    });
  }

  setSettings(patch) {
    const next = sanitizeSettings({ ...this.settings, ...patch });
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return;
    this.#commit('settings', () => (this.settings = next));
  }

  /** Nuovo spartito vuoto (annullabile): una sola voce. Mantiene BPM, tempo e opzioni. */
  clear() {
    if (this.voices.length === 1 && this.voices[0].notes.length === 0 && !this.settings.title) return;
    this.#commit('clear', () => {
      this.voices = [this.#newVoice('Voce 1')];
      this.activeVoiceId = this.voices[0].id;
      this.settings = { ...this.settings, title: '' };
    });
  }

  /** Sostituisce il contenuto con un documento caricato (annullabile). */
  load(data) {
    const parsed = parseScore(data);
    // Le riprese del file prendono id nuovi: non devono confondersi con quelle già in memoria.
    const takeIds = new Map([...parsed.audio].map(([take, audio]) => [take, this.addAudio(audio)]));
    // Riprese citate dalle note ma senza audio (bozza dopo un ricaricamento): un id "perso" che non
    // coincide mai con quelli di addAudio, così una ripresa nuova non viene collegata a note vecchie.
    const relink = (notes) =>
      notes.map((n) => {
        if (!n.src) return n;
        if (!takeIds.has(n.src.take)) takeIds.set(n.src.take, `${LOST_TAKE}${this.nextTakeId++}`);
        return { ...n, src: { ...n.src, take: takeIds.get(n.src.take) } };
      });
    this.#commit('load', () => {
      this.settings = parsed.settings;
      this.voices = parsed.voices.map((v) => ({ ...this.#newVoice(v.name), ...v, notes: this.#freshNotes(relink(v.notes)) }));
      this.activeVoiceId = this.voices[Math.min(parsed.activeVoice, this.voices.length - 1)].id;
    });
  }

  // ── Voci ───────────────────────────────────────────────────────────────

  /** Nuova voce vuota (annullabile), che diventa la voce attiva. Restituisce l'id (null oltre il massimo). */
  addVoice(name = null) {
    if (this.voices.length >= MAX_VOICES) return null;
    const voice = this.#newVoice(cleanName(name, this.#defaultName()));
    this.#commit('voices', () => {
      this.voices.push(voice);
      this.activeVoiceId = voice.id;
    });
    return voice.id;
  }

  /** Elimina una voce (annullabile). L'ultima voce rimasta non si elimina. */
  removeVoice(voiceId) {
    const index = this.voices.findIndex((v) => v.id === voiceId);
    if (index < 0 || this.voices.length === 1) return;
    this.#commit('voices', () => {
      this.voices.splice(index, 1);
      if (this.activeVoiceId === voiceId) this.activeVoiceId = this.voices[Math.min(index, this.voices.length - 1)].id;
    });
  }

  renameVoice(voiceId, name) {
    const voice = this.#requireVoice(voiceId);
    const clean = cleanName(name, voice.name);
    if (clean === voice.name) return;
    this.#commit('voices', () => (voice.name = clean));
  }

  setVoiceClef(voiceId, clef) {
    const voice = this.#requireVoice(voiceId);
    if (!CLEFS.includes(clef) || clef === voice.clef) return;
    this.#commit('voices', () => (voice.clef = clef));
  }

  /**
   * Aggiunge più voci in un solo passo annullabile (più file audio caricati insieme).
   * Se la voce attiva è vuota viene riempita dalla prima (e prende il suo nome).
   * @param {Array<{ name:string, notes:Array<{ midi:number|null, beats:number }> }>} list
   * @param {object} [settingsPatch] impostazioni da cambiare nello stesso passo (es. BPM rilevato)
   * @returns {string[]} id delle voci scritte
   */
  importVoices(list, settingsPatch = null) {
    const ids = [];
    this.#commit('voices', () => {
      if (settingsPatch) this.settings = sanitizeSettings({ ...this.settings, ...settingsPatch });
      list.forEach((item, i) => {
        const fillActive = i === 0 && this.voice.notes.length === 0;
        if (!fillActive && this.voices.length >= MAX_VOICES) return;
        const voice = fillActive ? this.voice : this.#newVoice('');
        voice.name = cleanName(item.name, this.#defaultName());
        voice.notes = this.#freshNotes(item.notes);
        if (!fillActive) this.voices.push(voice);
        ids.push(voice.id);
      });
      if (ids.length > 0) this.activeVoiceId = ids[0];
    });
    return ids;
  }

  /** Voce attiva (non annullabile: è una scelta di lavoro, non un contenuto). */
  setActiveVoice(voiceId) {
    if (voiceId === this.activeVoiceId || !this.voiceById(voiceId)) return;
    this.activeVoiceId = voiceId;
    this.#emit('active', false);
  }

  /** Mixer di una voce: strumento, sorgente (voce originale o synth), muto, solo, volume (salvati nel file, non annullabili). */
  setMix(voiceId, { instrument, source, muted, solo, volumeDb }) {
    const voice = this.#requireVoice(voiceId);
    if (instrument !== undefined) voice.instrument = instrument || null;
    if (source !== undefined) voice.source = source === 'synth' ? 'synth' : 'original';
    if (muted !== undefined) voice.muted = Boolean(muted);
    if (solo !== undefined) voice.solo = Boolean(solo);
    if (volumeDb !== undefined) voice.volumeDb = clampVolume(volumeDb);
    this.#emit('mix', false);
  }

  // ── Annulla / ripeti ───────────────────────────────────────────────────

  /** Svuota annulla/ripeti (es. dopo il ripristino della bozza all'avvio). */
  clearHistory() {
    this.undoStack = [];
    this.redoStack = [];
    this.#emit('history');
  }

  undo() {
    if (!this.canUndo) return;
    this.redoStack.push(this.#snapshot());
    this.#restore(this.undoStack.pop());
    this.#emit('undo');
  }

  redo() {
    if (!this.canRedo) return;
    this.undoStack.push(this.#snapshot());
    this.#restore(this.redoStack.pop());
    this.#emit('redo');
  }

  // ── Serializzazione ────────────────────────────────────────────────────

  /**
   * Formato del file salvato: leggibile, senza gli id interni.
   * @param {{ includeAudio?:boolean, keepSources?:boolean }} [options]
   *   includeAudio: aggiunge l'audio originale delle riprese usate (PCM 16 bit in base64) e il
   *   collegamento delle note; senza, il file contiene solo la partitura.
   *   keepSources: tiene il collegamento delle note (`src`) anche senza l'audio: lo usa la bozza
   *   automatica, così dopo un ricaricamento si sa quali voci avevano un audio originale ormai perso.
   */
  toJSON({ includeAudio = false, keepSources = false } = {}) {
    const used = new Set();
    const data = {
      format: FORMAT_ID,
      version: FORMAT_VERSION,
      ...this.settings,
      activeVoice: Math.max(0, this.voices.indexOf(this.voice)),
      voices: this.voices.map(({ name, clef, instrument, source, volumeDb, muted, solo, notes }) => ({
        name,
        clef,
        instrument,
        source,
        volumeDb,
        muted,
        solo,
        notes: notes.map(({ midi, beats, src, edited }) => {
          const withAudio = includeAudio && src && this.audio.has(src.take);
          if (!src || (!withAudio && !keepSources)) return { midi, beats };
          if (withAudio) used.add(src.take);
          return edited ? { midi, beats, src, edited } : { midi, beats, src };
        }),
      })),
    };
    if (used.size > 0) {
      data.audio = Object.fromEntries(
        [...used].map((take) => {
          const { sampleRate, samples } = this.audio.get(take);
          return [take, { sampleRate, pcm16: pcm16ToBase64(samples) }];
        }),
      );
    }
    return data;
  }

  // ── Interni ────────────────────────────────────────────────────────────

  #commit(kind, mutate) {
    this.undoStack.push(this.#snapshot());
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    mutate();
    this.#emit(kind);
  }

  #snapshot() {
    return JSON.stringify({ settings: this.settings, voices: this.voices });
  }

  /** Ripristina il contenuto; il mixer resta quello attuale per le voci che esistono ancora. */
  #restore(snapshot) {
    const { settings, voices } = JSON.parse(snapshot);
    const mix = new Map(this.voices.map((v) => [v.id, { instrument: v.instrument, source: v.source, muted: v.muted, solo: v.solo, volumeDb: v.volumeDb }]));
    this.settings = settings;
    this.voices = voices.map((v) => ({ ...v, ...(mix.get(v.id) ?? {}) }));
    if (!this.voiceById(this.activeVoiceId)) this.activeVoiceId = this.voices[0].id;
  }

  #emit(kind, content = true) {
    if (content) this.revision++;
    this.dispatchEvent(new CustomEvent('change', { detail: { kind } }));
  }

  #newId() {
    return `n${this.nextId++}`;
  }

  /** @returns {Voice} */
  #newVoice(name) {
    return {
      id: `v${this.nextVoiceId++}`,
      name,
      clef: 'auto',
      instrument: null,
      source: 'original',
      volumeDb: 0,
      muted: false,
      solo: false,
      notes: [],
    };
  }

  /** "Voce N" con il primo N non ancora usato. */
  #defaultName() {
    const used = new Set(this.voices.map((v) => v.name));
    let n = this.voices.length + 1;
    while (used.has(`Voce ${n}`)) n++;
    return `Voce ${n}`;
  }

  #freshNotes(notes) {
    return notes.map(({ midi, beats, src, edited }) => {
      const note = { id: this.#newId(), midi: midi === null ? null : clampMidi(midi), beats: snapBeats(beats) };
      const source = cleanSource(src);
      if (source) {
        note.src = source;
        if (edited === true) note.edited = true;
      }
      return note;
    });
  }

  #requireVoice(voiceId) {
    const voice = this.voiceById(voiceId);
    if (!voice) throw new RangeError(`Voce inesistente: ${voiceId}`);
    return voice;
  }
}

/** Una nota cantata e poi modificata a mano non corrisponde più all'audio: nel riascolto la suona il synth. */
function markEdited(note) {
  if (note.src) note.edited = true;
}

function nearestPitch(notes, index) {
  for (let d = 1; d < notes.length; d++) {
    const candidate = notes[index - d]?.midi ?? notes[index + d]?.midi;
    if (candidate != null) return candidate;
  }
  return null;
}

function sanitizeSettings(s) {
  return {
    title: String(s.title ?? '').slice(0, 120),
    bpm: Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(Number(s.bpm) || DEFAULT_SETTINGS.bpm))),
    timeSignature: TIME_SIGNATURES.includes(s.timeSignature) ? s.timeSignature : DEFAULT_SETTINGS.timeSignature,
    showNoteNames: s.showNoteNames !== false,
    grid: s.grid === 'auto' ? 'auto' : GRID_OPTIONS.some((g) => g.value === Number(s.grid)) ? Number(s.grid) : DEFAULT_SETTINGS.grid,
    metronome: s.metronome !== false,
    refine: s.refine !== false,
    legato: s.legato !== false,
  };
}

/** @param {string|null} voiceName nome della voce nei messaggi (null se è l'unica) */
function parseNotes(list, voiceName) {
  const where = voiceName ? ` della voce "${voiceName}"` : '';
  if (!Array.isArray(list)) throw new ScoreFormatError(`Note mancanti${where} nel file.`);
  return list.map((n, i) => {
    const midi = n?.midi === null ? null : Number(n?.midi);
    const beats = Number(n?.beats);
    if ((midi !== null && !Number.isFinite(midi)) || !Number.isFinite(beats) || beats <= 0) {
      throw new ScoreFormatError(`Nota ${i + 1}${where} non valida nel file.`);
    }
    const note = { midi: midi === null ? null : clampMidi(midi), beats: snapBeats(beats) };
    const src = cleanSource(n?.src);
    if (src) Object.assign(note, n.edited === true ? { src, edited: true } : { src });
    return note;
  });
}

const MIN_AUDIO_RATE = 8000;
const MAX_AUDIO_RATE = 192000;

/**
 * Audio originale salvato nel file: { id: { sampleRate, pcm16 (base64) } }.
 * @returns {Map<string, Take>}
 */
function parseAudio(raw) {
  const audio = new Map();
  if (raw === undefined) return audio;
  if (!raw || typeof raw !== 'object') throw new ScoreFormatError('Audio originale non valido nel file.');
  for (const [take, entry] of Object.entries(raw)) {
    const sampleRate = Number(entry?.sampleRate);
    if (!Number.isInteger(sampleRate) || sampleRate < MIN_AUDIO_RATE || sampleRate > MAX_AUDIO_RATE || typeof entry?.pcm16 !== 'string') {
      throw new ScoreFormatError('Audio originale non valido nel file.');
    }
    try {
      audio.set(take, { sampleRate, samples: base64ToPcm16(entry.pcm16) });
    } catch {
      throw new ScoreFormatError('Audio originale non valido nel file.');
    }
  }
  return audio;
}

/**
 * Valida un oggetto letto da file. I file arrivano dall'esterno: si controlla tutto
 * e si scartano campi sconosciuti, invece di fidarsi del contenuto.
 * Versione 1 (una sola voce, `notes` e `clef` in cima) → partitura con una voce.
 *
 * @returns {{ settings:object, voices:Array<Omit<Voice, 'id'>>, activeVoice:number, audio:Map<string, Take> }}
 */
export function parseScore(data) {
  if (!data || typeof data !== 'object') throw new ScoreFormatError('Il file non contiene una partitura valida.');
  if (data.format !== FORMAT_ID) throw new ScoreFormatError('Il file non è una partitura GENCA VocaScore.');
  if (typeof data.version !== 'number' || data.version > FORMAT_VERSION) {
    throw new ScoreFormatError('Il file è stato creato con una versione più recente di GENCA VocaScore.');
  }

  let rawVoices;
  if (data.version < 2) {
    if (!Array.isArray(data.notes)) throw new ScoreFormatError('Il file non contiene note.');
    rawVoices = [{ name: 'Voce 1', clef: data.clef, notes: data.notes }];
  } else {
    if (!Array.isArray(data.voices) || data.voices.length === 0) throw new ScoreFormatError('Il file non contiene voci.');
    if (data.voices.length > MAX_VOICES) throw new ScoreFormatError(`Il file ha più di ${MAX_VOICES} voci.`);
    rawVoices = data.voices;
  }

  const voices = rawVoices.map((v, i) => {
    const name = cleanName(v?.name, `Voce ${i + 1}`);
    return {
      name,
      clef: CLEFS.includes(v?.clef) ? v.clef : 'auto',
      instrument: typeof v?.instrument === 'string' && v.instrument.length <= 32 ? v.instrument : null,
      source: v?.source === 'synth' ? 'synth' : 'original',
      volumeDb: clampVolume(v?.volumeDb),
      muted: v?.muted === true,
      solo: v?.solo === true,
      notes: parseNotes(v?.notes, rawVoices.length > 1 ? name : null),
    };
  });
  const active = Number.isInteger(data.activeVoice) && data.activeVoice >= 0 && data.activeVoice < voices.length ? data.activeVoice : 0;
  return { settings: sanitizeSettings(data), voices, activeVoice: active, audio: parseAudio(data.audio) };
}
