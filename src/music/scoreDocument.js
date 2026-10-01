import { GRID, TIME_SIGNATURES } from './notation.js';
import { midiToNoteName } from './noteUtils.js';

/**
 * Documento dello spartito: impostazioni + sequenza di note e pause, con annulla/ripeti.
 *
 * È la fonte di verità per pentagramma, riascolto, salvataggio e stampa.
 * Le durate sono in beats (semiminime), non in millisecondi: lo spartito è musica scritta,
 * quindi cambiare i BPM ne cambia la velocità di esecuzione, non le figure.
 *
 * Ogni modifica passa da #commit(), che salva lo stato precedente nella pila "annulla"
 * e notifica i listener con un evento 'change'.
 */

export const FORMAT_ID = 'vocascore';
export const FORMAT_VERSION = 1;
export const MIN_BPM = 30;
export const MAX_BPM = 240;
const MIN_MIDI = 21; // A0, estensione del pianoforte
const MAX_MIDI = 108; // C8
const MAX_BEATS = 64;
const HISTORY_LIMIT = 200;

export const DEFAULT_SETTINGS = Object.freeze({
  title: '',
  bpm: 90,
  timeSignature: '4/4',
  clef: 'auto', // 'auto' | 'treble' | 'bass'
  showNoteNames: true,
  grid: 0.5, // quantizzazione della registrazione in beats: 1 = semiminima, 0.5 = croma, 0.25 = semicroma
  metronome: true, // metronomo con battuta di attacco durante la registrazione
  refine: true, // allo Stop, rianalisi dell'intera registrazione (più precisa) al posto della trascrizione dal vivo
  legato: true, // una nota staccata viene scritta lunga fino all'attacco successivo, se il silenzio è breve
});

export const GRID_OPTIONS = [
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

export class ScoreDocument extends EventTarget {
  constructor() {
    super();
    this.settings = { ...DEFAULT_SETTINGS };
    /** @type {Array<{ id:string, midi:number|null, beats:number }>} */
    this.notes = [];
    this.undoStack = [];
    this.redoStack = [];
    this.nextId = 1;
    /** Cresce a ogni modifica: permette di sapere se il documento è cambiato nel frattempo. */
    this.revision = 0;
  }

  // ── Lettura ────────────────────────────────────────────────────────────

  get isEmpty() {
    return !this.notes.some((n) => n.midi !== null);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  indexOf(id) {
    return this.notes.findIndex((n) => n.id === id);
  }

  get(id) {
    return this.notes.find((n) => n.id === id) ?? null;
  }

  /** Nome leggibile di un elemento, per la UI ("C#4 · 1.5 ♩" oppure "Pausa · 1 ♩"). */
  describe(id) {
    const note = this.get(id);
    if (!note) return '';
    const what = note.midi === null ? 'Pausa' : midiToNoteName(note.midi);
    return `${what} · ${note.beats} ♩`;
  }

  /**
   * Eventi per il riascolto, ai BPM correnti, eventualmente a partire da un elemento.
   * @param {string|null} [fromId]
   * @returns {Array<{ id:string, time:number, duration:number, midi:number }>} tempi in secondi
   */
  playbackEvents(fromId = null) {
    const secPerBeat = 60 / this.settings.bpm;
    const start = Math.max(0, fromId ? this.indexOf(fromId) : 0);
    const events = [];
    let beat = 0;
    for (const note of this.notes.slice(start)) {
      if (note.midi !== null) {
        events.push({ id: note.id, time: beat * secPerBeat, duration: note.beats * secPerBeat, midi: note.midi });
      }
      beat += note.beats;
    }
    return events;
  }

  // ── Modifiche (tutte annullabili) ──────────────────────────────────────

  /** Aggiunge in coda (usato dalla registrazione). Restituisce l'id. */
  append({ midi, beats }) {
    let id;
    this.#commit('append', () => {
      id = this.#newId();
      this.notes.push({ id, midi: midi === null ? null : clampMidi(midi), beats: snapBeats(beats) });
    });
    return id;
  }

  /**
   * Sostituisce gli elementi [start, end) con nuove note in un'unica modifica annullabile
   * (usato dalla rifinitura dopo lo Stop: Ctrl+Z riporta la trascrizione dal vivo).
   */
  replaceRange(start, end, notes) {
    if (start < 0 || end > this.notes.length || start > end) throw new RangeError('Intervallo non valido');
    this.#commit('refine', () => {
      const fresh = notes.map(({ midi, beats }) => ({
        id: this.#newId(),
        midi: midi === null ? null : clampMidi(midi),
        beats: snapBeats(beats),
      }));
      this.notes.splice(start, end - start, ...fresh);
    });
  }

  /** Inserisce una copia dell'elemento `id` subito dopo di esso. Restituisce il nuovo id. */
  duplicate(id) {
    const index = this.indexOf(id);
    if (index < 0) return null;
    let newId;
    this.#commit('insert', () => {
      newId = this.#newId();
      this.notes.splice(index + 1, 0, { ...this.notes[index], id: newId });
    });
    return newId;
  }

  remove(id) {
    const index = this.indexOf(id);
    if (index < 0) return;
    this.#commit('remove', () => this.notes.splice(index, 1));
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
    const index = this.indexOf(id);
    if (index < 0) return;
    const note = this.notes[index];
    this.#commit('edit', () => {
      if (note.midi !== null) {
        note.restoreMidi = note.midi;
        note.midi = null;
      } else {
        note.midi = note.restoreMidi ?? this.#nearestPitch(index) ?? 60;
      }
    });
  }

  setSettings(patch) {
    const next = { ...this.settings, ...sanitizeSettings({ ...this.settings, ...patch }) };
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return;
    this.#commit('settings', () => (this.settings = next));
  }

  /** Nuovo spartito vuoto (annullabile). Mantiene BPM, tempo e chiave. */
  clear() {
    if (this.notes.length === 0 && !this.settings.title) return;
    this.#commit('clear', () => {
      this.notes = [];
      this.settings = { ...this.settings, title: '' };
    });
  }

  /** Sostituisce il contenuto con un documento caricato (annullabile). */
  load(data) {
    const parsed = parseScore(data);
    this.#commit('load', () => {
      this.settings = parsed.settings;
      this.notes = parsed.notes.map((n) => ({ ...n, id: this.#newId() }));
    });
  }

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
      notes: this.notes.map(({ midi, beats }) => ({ midi, beats })),
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
    return JSON.stringify({ settings: this.settings, notes: this.notes });
  }

  #restore(snapshot) {
    const { settings, notes } = JSON.parse(snapshot);
    this.settings = settings;
    this.notes = notes;
  }

  #emit(kind) {
    this.revision++;
    this.dispatchEvent(new CustomEvent('change', { detail: { kind } }));
  }

  #newId() {
    return `n${this.nextId++}`;
  }

  #nearestPitch(index) {
    for (let d = 1; d < this.notes.length; d++) {
      const candidate = this.notes[index - d]?.midi ?? this.notes[index + d]?.midi;
      if (candidate != null) return candidate;
    }
    return null;
  }
}

function sanitizeSettings(s) {
  return {
    title: String(s.title ?? '').slice(0, 120),
    bpm: Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(Number(s.bpm) || DEFAULT_SETTINGS.bpm))),
    timeSignature: TIME_SIGNATURES.includes(s.timeSignature) ? s.timeSignature : DEFAULT_SETTINGS.timeSignature,
    clef: ['auto', 'treble', 'bass'].includes(s.clef) ? s.clef : DEFAULT_SETTINGS.clef,
    showNoteNames: s.showNoteNames !== false,
    grid: GRID_OPTIONS.some((g) => g.value === Number(s.grid)) ? Number(s.grid) : DEFAULT_SETTINGS.grid,
    metronome: s.metronome !== false,
    refine: s.refine !== false,
    legato: s.legato !== false,
  };
}

/**
 * Valida un oggetto letto da file. I file arrivano dall'esterno: si controlla tutto
 * e si scartano campi sconosciuti, invece di fidarsi del contenuto.
 *
 * @returns {{ settings:object, notes:Array<{ midi:number|null, beats:number }> }}
 */
export function parseScore(data) {
  if (!data || typeof data !== 'object') throw new ScoreFormatError('Il file non contiene uno spartito valido.');
  if (data.format !== FORMAT_ID) throw new ScoreFormatError('Il file non è uno spartito GENCA VocaScore.');
  if (typeof data.version !== 'number' || data.version > FORMAT_VERSION) {
    throw new ScoreFormatError('Il file è stato creato con una versione più recente di GENCA VocaScore.');
  }
  if (!Array.isArray(data.notes)) throw new ScoreFormatError('Il file non contiene note.');

  const notes = data.notes.map((n, i) => {
    const midi = n?.midi === null ? null : Number(n?.midi);
    const beats = Number(n?.beats);
    if ((midi !== null && !Number.isFinite(midi)) || !Number.isFinite(beats) || beats <= 0) {
      throw new ScoreFormatError(`Nota ${i + 1} non valida nel file.`);
    }
    return { midi: midi === null ? null : clampMidi(midi), beats: snapBeats(beats) };
  });
  return { settings: sanitizeSettings(data), notes };
}
