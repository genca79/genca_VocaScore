import { timeSignatureInfo } from './notation.js';

/**
 * Registrazione: trasforma gli eventi dello stabilizzatore (tempi in ms) in note scritte
 * (durate in beats) aggiunte in coda allo ScoreDocument.
 *
 * ── Quantizzazione su griglia ASSOLUTA ────────────────────────────────────
 * Inizio e fine di ogni nota vengono convertiti in posizione musicale rispetto all'inizio della
 * sessione (t0) e agganciati alla griglia più vicina (es. ogni croma):
 *
 *     beat = (t − t0) / durata_di_un_beat        posizione = round(beat / griglia) · griglia
 *
 * La durata di una nota è la differenza tra due posizioni agganciate, e le pause sono gli spazi
 * tra una nota e l'altra. Gli errori di tempo NON si sommano: ogni confine è riferito a t0, non
 * alla nota precedente. Quantizzare ogni durata separatamente farebbe invece sfasare tutto rispetto
 * alle battute dopo poche note, e scarterebbe i silenzi brevi.
 *
 * t0 è il primo movimento dopo la battuta di attacco del metronomo; senza metronomo è l'inizio
 * della prima nota cantata, che diventa così il primo movimento della battuta.
 *
 * ── Note legate (impostazione "legato", attiva di default) ─────────────────
 * Chi canta stacca quasi sempre un po' le note (respiro, articolazione). In notazione però la durata
 * di una nota è di norma la distanza fino all'attacco successivo: una semiminima cantata staccata
 * resta una semiminima, non diventa croma + pausa. Quindi, all'attacco di una nota, se il silenzio
 * dalla precedente è BREVE la nota precedente viene allungata fino a qui invece di scrivere una pausa.
 * Breve = non più lungo della nota stessa e non oltre `maxGap` (una croma, o un'unità di griglia
 * se più larga). Un respiro vero tra due frasi (da un movimento in su) resta una pausa.
 */
export class Recorder {
  /**
   * @param {import('./scoreDocument.js').ScoreDocument} doc
   * @param {{ inputLatencyMs?:number }} [options]
   */
  constructor(doc, { inputLatencyMs = 0 } = {}) {
    this.doc = doc;
    this.inputLatencyMs = inputLatencyMs;
    this.session = null;
  }

  /**
   * Inizia una sessione di registrazione (a ogni avvio del microfono).
   * @param {number|null} t0Ms istante del primo movimento (performance.now()), o null per agganciarlo alla prima nota
   * @param {{ snap?:(ms:number) => number, grid?:number }} [options]
   *   snap: aggancio personalizzato ms → posizione in beats (tempo rilevato, quantizzazione automatica);
   *   grid: unità minima per le regole di nota breve, pausa e legato quando si usa `snap`
   */
  beginSession(t0Ms = null, { snap = null, grid: gridOverride = null } = {}) {
    const { bpm, timeSignature } = this.doc.settings;
    // Con la quantizzazione automatica, durante il canto l'anteprima usa una griglia fissa di 1/8:
    // la scelta per movimento si fa allo Stop, quando si conosce tutta la sessione.
    const grid = gridOverride ?? (this.doc.settings.grid === 'auto' ? 0.5 : this.doc.settings.grid);
    const legato = this.doc.settings.legato !== false;
    this.#padToMeasure(timeSignature);
    this.session = {
      // per la rifinitura dopo lo Stop: da dove iniziano le note di questa sessione e con quali impostazioni
      startIndex: this.doc.notes.length,
      t0Raw: t0Ms,
      settings: { bpm, grid: this.doc.settings.grid, timeSignature, legato },
      rawNotes: [], // note con i tempi grezzi (ms), per riscriverle allo Stop con tempo/griglia automatici
      snapFn: snap,
      extendGaps: legato,
      maxGap: Math.max(grid, 0.5),
      lastNoteBeats: null, // durata scritta dell'ultima nota (per l'allungamento legato)
      // Rispetto al metronomo la voce arriva in ritardo (latenza del microfono + finestra di analisi):
      // si sposta t0 in avanti della stessa quantità. Senza metronomo il riferimento è la voce stessa.
      t0: t0Ms === null ? null : t0Ms + this.inputLatencyMs,
      beatMs: 60000 / bpm,
      grid,
      cursor: 0, // posizione (beats) in cui finisce l'ultima nota/pausa scritta della sessione
      pendingStart: null,
      legato: false, // la nota corrente è iniziata senza silenzio dopo la precedente
      lastNoteId: null,
    };
  }

  endSession() {
    this.session = null;
  }

  /** Dati della sessione in corso, per la rifinitura (null se nessuna sessione). */
  get sessionInfo() {
    if (!this.session) return null;
    const { startIndex, t0Raw, settings, rawNotes } = this.session;
    return { startIndex, t0Raw, settings, rawNotes: rawNotes.filter((n) => n.endMs !== null) };
  }

  /**
   * Quantizza su griglia una lista di note con tempi in ms (performance.now()), con le stesse regole
   * della registrazione dal vivo: usato per scrivere il risultato della rifinitura.
   *
   * @param {Array<{ midi:number, startMs:number, endMs:number, transition:boolean }>} notes
   * @param {{ settings:{ bpm:number, grid:number|'auto', timeSignature:string, legato?:boolean }, t0Raw:number|null,
   *           snap?:(ms:number) => number, grid?:number }} session
   * @returns {Array<{ midi:number|null, beats:number }>}
   */
  static quantize(notes, { settings, t0Raw, snap = null, grid = null }) {
    const written = [];
    const sink = {
      settings,
      notes: [],
      append: (n) => (written.push({ ...n }), String(written.length)),
      setBeats: (id, beats) => (written[Number(id) - 1].beats = beats),
    };
    const rec = new Recorder(sink, { inputLatencyMs: 0 });
    rec.beginSession(t0Raw, { snap, grid });
    for (const n of notes) {
      rec.noteStarted(n.startMs);
      rec.noteEnded({ midi: n.midi, endMs: n.endMs, transition: n.transition, src: n.src });
    }
    return written;
  }

  /**
   * Inizio di una nota: lo spazio dalla nota precedente diventa una pausa (scritta subito, per la
   * vista live), oppure, se è breve e le note legate sono attive, allunga la nota precedente.
   */
  noteStarted(startMs) {
    const s = this.#ensureSession(startMs);
    s.rawNotes.push({ midi: null, startMs, endMs: null, transition: false });
    const start = Math.max(this.#snap(startMs), s.cursor);
    const gap = start - s.cursor;
    if (gap >= s.grid) {
      const extend = s.extendGaps && s.lastNoteId !== null && gap <= Math.min(s.lastNoteBeats, s.maxGap);
      if (extend) {
        s.lastNoteBeats += gap;
        this.doc.setBeats(s.lastNoteId, s.lastNoteBeats);
      } else {
        this.doc.append({ midi: null, beats: gap });
        s.lastNoteId = null;
        s.lastNoteBeats = null;
      }
      s.legato = false;
    }
    s.cursor = start;
    s.pendingStart = start;
  }

  /**
   * Fine di una nota: viene scritta dalla posizione di inizio a quella di fine agganciate.
   * `src` (ripresa e tempi cantati) passa alla nota scritta, per il riascolto con la voce originale.
   * @returns {string|null} id della nota scritta (null se assorbita dalla precedente)
   */
  noteEnded({ midi, endMs, transition = false, src = undefined }) {
    const s = this.session;
    if (!s || s.pendingStart === null) return null;
    Object.assign(s.rawNotes.at(-1), { midi, endMs, transition });
    const start = s.pendingStart;
    let end = this.#snap(endMs);
    s.pendingStart = null;
    const wasLegato = s.legato;
    s.legato = transition;

    if (end <= start) {
      // Più breve di mezza unità di griglia. Se è legata a una nota vicina non è una nota vera ma
      // un passaggio della voce: glissato tra due note, o "scivolata" d'attacco verso la nota
      // successiva. La si assorbe: il suo tempo resta alla nota precedente o va alla successiva.
      // Se è isolata (silenzio prima e dopo) la si tiene, lunga un'unità di griglia:
      // una nota breve cantata davvero non va persa.
      if ((wasLegato && s.lastNoteId) || transition) return null;
      end = start + s.grid;
    }
    s.cursor = end;
    s.lastNoteBeats = end - start;
    s.lastNoteId = this.doc.append(src ? { midi, beats: s.lastNoteBeats, src } : { midi, beats: s.lastNoteBeats });
    return s.lastNoteId;
  }

  /** Durata scritta di una nota ancora in corso (per mostrarla mentre si canta). */
  liveBeats(nowMs) {
    const s = this.session;
    if (!s || s.pendingStart === null) return s?.grid ?? 0.5;
    return Math.max(s.grid, this.#snap(nowMs) - s.pendingStart);
  }

  #ensureSession(startMs) {
    if (!this.session) this.beginSession(null);
    if (this.session.t0 === null) this.session.t0 = startMs; // senza metronomo: la prima nota è il "battere"
    return this.session;
  }

  #snap(ms) {
    const s = this.session;
    if (s.snapFn) return s.snapFn(ms);
    const beat = (ms - s.t0) / s.beatMs;
    return Math.max(0, Math.round(beat / s.grid) * s.grid);
  }

  /**
   * Una nuova sessione inizia sempre su una battuta nuova: se l'ultima battuta scritta è
   * incompleta la si completa con una pausa, così il primo movimento del metronomo
   * coincide con una stanghetta.
   */
  #padToMeasure(timeSignature) {
    const rest = restToCompleteMeasure(this.doc.notes, timeSignature);
    if (rest > 0) this.doc.append({ midi: null, beats: rest });
  }
}

/**
 * Durata (beats) della pausa che completa l'ultima battuta; 0 se è già completa o non ci sono note.
 * @param {Array<{ beats:number }>} notes
 * @param {string} timeSignature
 */
export function restToCompleteMeasure(notes, timeSignature) {
  const { measureBeats } = timeSignatureInfo(timeSignature);
  const total = notes.reduce((sum, n) => sum + n.beats, 0);
  const remainder = total % measureBeats;
  return remainder > 1e-9 ? measureBeats - remainder : 0;
}
