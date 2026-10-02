import { GRID, TIME_SIGNATURES } from './notation.js';
import { midiToNoteName } from './noteUtils.js';

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
 *   - mixer (strumento, muto, solo) e voce attiva: si salvano nel file ma NON entrano in annulla/ripeti
 *     (annullare una nota non deve riaccendere una voce messa in muto) e non cambiano `revision`.
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
  { value: 'auto', label: 'Auto' },
  { value: 1, label: '1/4' },
  { value: 0.5, label: '1/8' },
  { value: 0.25, label: '1/16' },
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
const totalBeats = (notes) => notes.reduce((sum, n) => sum + n.beats, 0);

/**
 * @typedef {{ id:string, midi:number|null, beats:number, restoreMidi?:number }} Note
 * @typedef {{ id:string, name:string, clef:'auto'|'treble'|'bass', instrument:string|null,
 *             muted:boolean, solo:boolean, notes:Note[] }} Voice
 *   instrument null = lo strumento generale di "Suono Synth"
 */

export class ScoreDocument extends EventTarget {
  constructor() {
    super();
    this.settings = { ...DEFAULT_SETTINGS };
    this.nextId = 1;
    this.nextVoiceId = 1;
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
   * @returns {Array<{ id:string, voiceId:string, instrument:string|null, time:number, duration:number, midi:number }>}
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
      voice.notes.splice(index + 1, 0, { ...voice.notes[index], id: newId });
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
    this.#commit('edit', () => (note.midi = midi));
  }

  setBeats(id, beats) {
    const note = this.get(id);
    if (!note) return;
    const snapped = snapBeats(beats);
    if (snapped === note.beats) return;
    this.#commit('edit', () => (note.beats = snapped));
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
    this.#commit('load', () => {
      this.settings = parsed.settings;
      this.voices = parsed.voices.map((v) => ({ ...this.#newVoice(v.name), ...v, notes: this.#freshNotes(v.notes) }));
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

  /** Mixer di una voce: strumento, muto, solo (salvati nel file, non annullabili). */
  setMix(voiceId, { instrument, muted, solo }) {
    const voice = this.#requireVoice(voiceId);
    if (instrument !== undefined) voice.instrument = instrument || null;
    if (muted !== undefined) voice.muted = Boolean(muted);
    if (solo !== undefined) voice.solo = Boolean(solo);
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

  /** Formato del file salvato: leggibile, senza gli id interni. */
  toJSON() {
    return {
      format: FORMAT_ID,
      version: FORMAT_VERSION,
      ...this.settings,
      activeVoice: Math.max(0, this.voices.indexOf(this.voice)),
      voices: this.voices.map(({ name, clef, instrument, muted, solo, notes }) => ({
        name,
        clef,
        instrument,
        muted,
        solo,
        notes: notes.map(({ midi, beats }) => ({ midi, beats })),
      })),
    };
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
    const mix = new Map(this.voices.map((v) => [v.id, { instrument: v.instrument, muted: v.muted, solo: v.solo }]));
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
    return { id: `v${this.nextVoiceId++}`, name, clef: 'auto', instrument: null, muted: false, solo: false, notes: [] };
  }

  /** "Voce N" con il primo N non ancora usato. */
  #defaultName() {
    const used = new Set(this.voices.map((v) => v.name));
    let n = this.voices.length + 1;
    while (used.has(`Voce ${n}`)) n++;
    return `Voce ${n}`;
  }

  #freshNotes(notes) {
    return notes.map(({ midi, beats }) => ({
      id: this.#newId(),
      midi: midi === null ? null : clampMidi(midi),
      beats: snapBeats(beats),
    }));
  }

  #requireVoice(voiceId) {
    const voice = this.voiceById(voiceId);
    if (!voice) throw new RangeError(`Voce inesistente: ${voiceId}`);
    return voice;
  }
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
    return { midi: midi === null ? null : clampMidi(midi), beats: snapBeats(beats) };
  });
}

/**
 * Valida un oggetto letto da file. I file arrivano dall'esterno: si controlla tutto
 * e si scartano campi sconosciuti, invece di fidarsi del contenuto.
 * Versione 1 (una sola voce, `notes` e `clef` in cima) → partitura con una voce.
 *
 * @returns {{ settings:object, voices:Array<Omit<Voice, 'id'>>, activeVoice:number }}
 */
export function parseScore(data) {
  if (!data || typeof data !== 'object') throw new ScoreFormatError('Il file non contiene uno spartito valido.');
  if (data.format !== FORMAT_ID) throw new ScoreFormatError('Il file non è uno spartito GENCA VocaScore.');
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
      muted: v?.muted === true,
      solo: v?.solo === true,
      notes: parseNotes(v?.notes, rawVoices.length > 1 ? name : null),
    };
  });
  const active = Number.isInteger(data.activeVoice) && data.activeVoice >= 0 && data.activeVoice < voices.length ? data.activeVoice : 0;
  return { settings: sanitizeSettings(data), voices, activeVoice: active };
}
