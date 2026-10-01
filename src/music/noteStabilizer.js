import { midiToHz, midiToNoteName } from './noteUtils.js';

/**
 * Trasforma la sequenza "rumorosa" di pitch per frame in eventi di nota discreti (analisi DAL VIVO).
 *
 * La voce non è mai perfettamente stabile: vibrato (±30–50 cents a 5–7 Hz), glissando
 * di attacco, respiro, cali di volume e piccoli errori del detector produrrebbero decine
 * di note spurie al secondo. I meccanismi che li assorbono:
 *   1. Filtro mediano sugli ultimi N valori: elimina i picchi isolati.
 *   2. Centro della nota: l'altezza di una nota è la MEDIANA dei suoi campioni dopo l'attacco, non
 *      il valore dei primi frame (dove la voce sta ancora "arrivando" sulla nota). L'isteresi confronta
 *      la voce con questo centro, e il noteOff riporta l'altezza definitiva calcolata sull'intera nota.
 *   3. Isteresi: per lasciare la nota bisogna allontanarsi dal centro di oltre `hysteresisSemitones`.
 *   4. Conferma a tempo: una nuova nota deve restare stabile per `confirmMs`.
 *      Un salto di esattamente un'ottava (l'errore tipico dei pitch detector) richiede `octaveConfirmMs`.
 *   5. Tolleranza ai buchi: frame senza pitch non chiudono subito la nota.
 *      - gate chiuso (silenzio):           la nota si chiude dopo `releaseMs`;
 *      - gate aperto ma pitch incerto
 *        (respiro, consonante, raucedine): la nota resta viva fino a `unvoicedHoldMs`.
 *   6. Sillabe ripetute: più sillabe cantate sulla STESSA nota ("la-la-la") non cambiano l'altezza,
 *      ma ognuna produce un calo di volume (la consonante) seguito da una risalita. Un calo di almeno
 *      `dipDb` rispetto al picco recente, seguito entro `maxDipMs` da una risalita di `riseDb`, chiude
 *      la nota e ne apre una nuova uguale.
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
    attackMs = 70,
    dipDb = 6,
    riseDb = 4,
    maxDipMs = 300,
    peakDecayDbPerSec = 4,
  } = {}) {
    Object.assign(this, {
      medianWindow,
      confirmMs,
      octaveConfirmMs,
      hysteresisSemitones,
      releaseMs,
      unvoicedHoldMs,
      attackMs,
      dipDb,
      riseDb,
      maxDipMs,
      peakDecayDbPerSec,
    });
    this.reset();
  }

  reset() {
    this.history = [];
    this.current = null; // { midi, startMs, samples: [{ t, m }] }
    this.candidate = null; // { midi, sinceMs }
    this.lastVoicedMs = null;
    this.env = null; // inviluppo di volume della nota corrente
  }

  /**
   * @param {number|null} exactMidi MIDI continuo del frame (già corretto per l'intonazione), o null se non c'è pitch
   * @param {number} nowMs timestamp del frame
   * @param {boolean} [gateOpen] stato del noise gate (distingue silenzio da pitch incerto)
   * @param {number|null} [db] livello del frame in dBFS (per riconoscere le sillabe ripetute)
   * @returns {Array<{type:'noteOn'|'noteOff'} & object>}
   */
  process(exactMidi, nowMs, gateOpen = exactMidi != null, db = null) {
    const syllable = this.#trackEnvelope(db, nowMs, exactMidi != null);
    if (exactMidi == null) return this.#processUnvoiced(nowMs, gateOpen);

    const events = [];
    this.lastVoicedMs = nowMs;
    this.history.push(exactMidi);
    if (this.history.length > this.medianWindow) this.history.shift();
    const smoothed = median(this.history);

    if (this.current) {
      const center = this.#center();
      const near = Math.abs(smoothed - center) < this.hysteresisSemitones;

      // Nuova sillaba sulla stessa nota: si chiude la nota all'inizio del calo e se ne apre una uguale.
      if (syllable && near) {
        events.push(this.#endCurrent(syllable.startMs, false));
        events.push(this.#startNote(Math.round(smoothed), nowMs));
        this.current.samples.push({ t: nowMs, m: exactMidi });
        return events;
      }

      this.current.samples.push({ t: nowMs, m: exactMidi });
      if (near) {
        this.candidate = null;
        return events;
      }
    }

    const rounded = Math.round(smoothed);
    if (this.candidate?.midi !== rounded) {
      this.candidate = { midi: rounded, sinceMs: nowMs };
      return events;
    }

    const reference = this.current ? Math.round(this.#center()) : rounded;
    const interval = Math.abs(rounded - reference);
    const isOctaveJump = interval > 0 && interval % 12 === 0;
    const requiredMs = isOctaveJump ? this.octaveConfirmMs : this.confirmMs;
    if (nowMs - this.candidate.sinceMs < requiredMs) return events;

    // Nota confermata. La si data dal momento in cui è comparsa (non da ora): durate più fedeli.
    const startMs = this.candidate.sinceMs;
    // `transition: true` segnala che la nota viene sostituita senza silenzio (legato):
    // il synth può fare glide invece di rilasciare e ri-attaccare.
    if (this.current) {
      // i campioni dal cambio in poi appartengono alla nota nuova
      this.current.samples = this.current.samples.filter((s) => s.t < startMs);
      events.push(this.#endCurrent(startMs, true));
    }
    events.push(this.#startNote(rounded, startMs));
    this.current.samples.push({ t: nowMs, m: exactMidi });
    this.candidate = null;
    return events;
  }

  /** Chiude l'eventuale nota aperta (es. allo Stop). */
  flush(nowMs) {
    const events = this.current ? [this.#endCurrent(this.lastVoicedMs ?? nowMs)] : [];
    this.reset();
    return events;
  }

  #startNote(midi, startMs) {
    this.current = { midi, startMs, samples: [] };
    this.env = null;
    return { type: 'noteOn', midi, name: midiToNoteName(midi), hz: midiToHz(midi), startMs };
  }

  /**
   * Centro della nota: mediana dei campioni dopo l'attacco (finché non ce ne sono, tutti i campioni;
   * se non ce n'è nessuno, l'altezza con cui la nota è stata confermata).
   */
  #center() {
    const { samples, startMs, midi } = this.current;
    if (samples.length === 0) return midi;
    const stable = samples.filter((s) => s.t - startMs >= this.attackMs);
    return median((stable.length >= 3 ? stable : samples).map((s) => s.m));
  }

  /**
   * Inviluppo di volume della nota corrente e riconoscimento delle sillabe.
   * Il picco "si scarica" lentamente (peakDecayDbPerSec): un diminuendo graduale non è un calo.
   * @returns {{ startMs:number }|null} il calo appena concluso, se è iniziata una nuova sillaba
   */
  #trackEnvelope(db, nowMs, voiced) {
    if (!this.current || db == null || !Number.isFinite(db)) return null;
    if (!this.env) {
      this.env = { peak: db, lastMs: nowMs, dip: null };
      return null;
    }
    const env = this.env;
    const dt = Math.max(0, nowMs - env.lastMs);
    env.lastMs = nowMs;
    env.peak = Math.max(db, env.peak - (this.peakDecayDbPerSec * dt) / 1000);

    if (!env.dip) {
      if (db <= env.peak - this.dipDb) env.dip = { startMs: nowMs, minDb: db };
      return null;
    }
    env.dip.minDb = Math.min(env.dip.minDb, db);
    if (nowMs - env.dip.startMs > this.maxDipMs) {
      // calo troppo lungo per essere una consonante (es. diminuendo, fine frase): nessuna nuova sillaba
      env.dip = null;
      env.peak = db;
      return null;
    }
    if (voiced && db >= env.dip.minDb + this.riseDb) {
      const dip = env.dip;
      env.dip = null;
      env.peak = db;
      return dip;
    }
    return null;
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
    const { startMs } = this.current;
    // Altezza definitiva: centro calcolato sull'intera nota (esclusa la coda, dove la voce si spegne).
    const tailCut = this.current.samples.filter((s) => endMs - s.t >= 40);
    if (tailCut.length >= 3) this.current.samples = tailCut;
    const center = this.#center();
    const midi = Math.round(center);
    this.current = null;
    this.env = null;
    return {
      type: 'noteOff',
      midi,
      center,
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
