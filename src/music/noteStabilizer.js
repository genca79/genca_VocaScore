import { midiToHz, midiToNoteName } from './noteUtils.js';

/**
 * Trasforma la sequenza "rumorosa" di pitch per frame in eventi di nota discreti.
 *
 * La voce non è mai perfettamente stabile: vibrato (±30–50 cents a 5–7 Hz), glissando
 * di attacco, respiro, cali di volume e piccoli errori del detector produrrebbero decine
 * di note spurie al secondo. I meccanismi che li assorbono:
 *   1. Filtro mediano sugli ultimi N valori: elimina i picchi isolati.
 *   2. Isteresi: per lasciare la nota corrente bisogna allontanarsene di oltre `hysteresisSemitones`.
 *   3. Conferma a tempo: una nuova nota deve restare stabile per `confirmMs`.
 *      Un salto di esattamente un'ottava (l'errore tipico dei pitch detector) richiede `octaveConfirmMs`.
 *   4. Tolleranza ai buchi: frame senza pitch non chiudono subito la nota.
 *      - gate chiuso (silenzio):           la nota si chiude dopo `releaseMs`;
 *      - gate aperto ma pitch incerto
 *        (respiro, consonante, raucedine): la nota resta viva fino a `unvoicedHoldMs`.
 *
 * Tutte le soglie sono in millisecondi, non in frame: rAF va a 60 Hz su un monitor e a
 * 120/144 Hz su un altro, e con soglie in frame le tolleranze si dimezzerebbero.
 *
 * È un modulo puro: `process()` restituisce un array di eventi invece di produrre effetti.
 */
export class NoteStabilizer {
  constructor({
    medianWindow = 7,
    confirmMs = 80,
    octaveConfirmMs = 250,
    hysteresisSemitones = 0.8,
    releaseMs = 180,
    unvoicedHoldMs = 400,
  } = {}) {
    Object.assign(this, { medianWindow, confirmMs, octaveConfirmMs, hysteresisSemitones, releaseMs, unvoicedHoldMs });
    this.reset();
  }

  reset() {
    this.history = [];
    this.current = null; // { midi, startMs }
    this.candidate = null; // { midi, sinceMs }
    this.lastVoicedMs = null;
  }

  /**
   * @param {number|null} exactMidi MIDI continuo del frame, o null se non c'è pitch
   * @param {number} nowMs timestamp del frame
   * @param {boolean} [gateOpen] stato del noise gate (distingue silenzio da pitch incerto)
   * @returns {Array<{type:'noteOn'|'noteOff'} & object>}
   */
  process(exactMidi, nowMs, gateOpen = exactMidi != null) {
    if (exactMidi == null) return this.#processUnvoiced(nowMs, gateOpen);

    const events = [];
    this.lastVoicedMs = nowMs;
    this.history.push(exactMidi);
    if (this.history.length > this.medianWindow) this.history.shift();
    const smoothed = median(this.history);

    // Isteresi: finché restiamo "vicini" alla nota corrente la consideriamo invariata.
    // Con 0.8 il confine tra due semitoni si sposta da 0.5 a 0.8 nella direzione di uscita.
    if (this.current && Math.abs(smoothed - this.current.midi) < this.hysteresisSemitones) {
      this.candidate = null;
      return events;
    }

    const rounded = Math.round(smoothed);
    if (this.candidate?.midi !== rounded) {
      this.candidate = { midi: rounded, sinceMs: nowMs };
      return events;
    }

    const interval = this.current ? Math.abs(rounded - this.current.midi) : 0;
    const isOctaveJump = interval > 0 && interval % 12 === 0;
    const requiredMs = isOctaveJump ? this.octaveConfirmMs : this.confirmMs;
    if (nowMs - this.candidate.sinceMs < requiredMs) return events;

    // Nota confermata. La si data dal momento in cui è comparsa (non da ora): durate più fedeli.
    const startMs = this.candidate.sinceMs;
    // `transition: true` segnala che la nota viene sostituita senza silenzio (legato):
    // il synth può fare glide invece di rilasciare e ri-attaccare.
    if (this.current) events.push(this.#endCurrent(startMs, true));
    this.current = { midi: rounded, startMs };
    this.candidate = null;
    events.push({
      type: 'noteOn',
      midi: rounded,
      name: midiToNoteName(rounded),
      hz: midiToHz(rounded),
      startMs,
    });
    return events;
  }

  /** Chiude l'eventuale nota aperta (es. allo Stop). */
  flush(nowMs) {
    const events = this.current ? [this.#endCurrent(this.lastVoicedMs ?? nowMs)] : [];
    this.reset();
    return events;
  }

  #processUnvoiced(nowMs, gateOpen) {
    this.candidate = null;
    if (!this.current) {
      this.history = [];
      return [];
    }
    const toleranceMs = gateOpen ? this.unvoicedHoldMs : this.releaseMs;
    if (nowMs - this.lastVoicedMs < toleranceMs) return [];

    // La nota finisce all'ultimo frame intonato, non adesso: la tolleranza non allunga la durata.
    const event = this.#endCurrent(this.lastVoicedMs);
    this.history = [];
    return [event];
  }

  #endCurrent(endMs, transition = false) {
    const { midi, startMs } = this.current;
    this.current = null;
    return {
      type: 'noteOff',
      midi,
      name: midiToNoteName(midi),
      startMs,
      endMs,
      durationMs: Math.max(0, endMs - startMs),
      transition,
    };
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
