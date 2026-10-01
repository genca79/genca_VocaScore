/**
 * Noise gate: decide se il segnale è abbastanza forte da meritare la pitch detection.
 */

/**
 * RMS (Root Mean Square) = sqrt( (1/N) · Σ x[i]² )
 * È il "volume medio" della finestra: a differenza del picco non è influenzato da un singolo campione.
 * Con campioni float in [−1, 1], una sinusoide a piena scala ha RMS = 1/√2 ≈ 0.707.
 */
export function computeRms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

/**
 * RMS lineare → decibel relativi al fondo scala (dBFS): dB = 20 · log10(rms).
 * Si usa 20 (e non 10) perché l'RMS è un'ampiezza e la potenza è proporzionale al suo quadrato.
 * 0 dBFS = fondo scala; −20 dBFS = ampiezza 1/10; il silenzio digitale tende a −∞.
 */
export function rmsToDb(rms) {
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

const DB_FLOOR = -100; // limite inferiore pratico (evita −∞ quando lo stream è ancora muto)
// Sotto questo livello è silenzio DIGITALE (stream non ancora partito, microfono disattivato), non il
// rumore della stanza: non va usato per stimare il rumore di fondo, altrimenti la soglia di chiusura
// finirebbe sotto il ronzio reale e il gate resterebbe aperto sul ronzio dopo il canto.
const DIGITAL_SILENCE_DB = -90;

/**
 * Gate ADATTIVO con isteresi e tempo di tenuta.
 *
 * Le soglie non sono fisse: ogni microfono e ogni stanza hanno un rumore di fondo diverso
 * (un portatile senza AGC può dare la voce a −50 dBFS, un microfono USB a −20).
 * Il gate stima il rumore di fondo ("noise floor") e apre a `floor + openAboveFloorDb`.
 *
 * Stima del floor (min-tracking asimmetrico):
 *   - se il livello scende sotto il floor, il floor lo segue in fretta (costante di tempo `floorFallMs`);
 *   - se il livello è sopra, il floor sale lentamente (`floorRiseDbPerSec`), ma SOLO a gate chiuso:
 *     mentre si canta non deve "imparare" la voce come rumore.
 *
 * Isteresi: si apre sopra `floor + openAboveFloorDb` e si chiude sotto `floor + closeAboveFloorDb`.
 * Con una soglia sola un segnale che oscilla attorno ad essa aprirebbe e chiuderebbe il gate
 * a ogni frame ("chattering"). L'hold copre le consonanti e i cali brevi tra due vocali.
 */
export class NoiseGate {
  constructor({
    openAboveFloorDb = 10,
    closeAboveFloorDb = 4,
    minOpenDb = -65,
    maxOpenDb = -35,
    holdMs = 250,
    floorFallMs = 150,
    floorRiseDbPerSec = 2,
  } = {}) {
    if (closeAboveFloorDb > openAboveFloorDb) throw new RangeError('closeAboveFloorDb deve essere <= openAboveFloorDb');
    Object.assign(this, { openAboveFloorDb, closeAboveFloorDb, minOpenDb, maxOpenDb, holdMs, floorFallMs, floorRiseDbPerSec });
    this.reset();
  }

  reset() {
    this.isOpen = false;
    this.floorDb = null;
    this.lastAboveCloseMs = -Infinity;
    this.lastMs = null;
  }

  /**
   * Soglia di apertura corrente. Limitata a [minOpenDb, maxOpenDb]: in una stanza
   * silenziosissima il gate non diventa ipersensibile, in una rumorosa non diventa sordo.
   */
  get openDb() {
    const floor = this.floorDb ?? this.minOpenDb - this.openAboveFloorDb;
    return Math.min(this.maxOpenDb, Math.max(this.minOpenDb, floor + this.openAboveFloorDb));
  }

  get closeDb() {
    return this.openDb - (this.openAboveFloorDb - this.closeAboveFloorDb);
  }

  /**
   * @param {number} db livello del frame in dBFS
   * @param {number} nowMs timestamp del frame
   * @returns {boolean} true se il gate è aperto
   */
  process(db, nowMs) {
    const level = Math.max(DB_FLOOR, db);
    const dtMs = this.lastMs === null ? 0 : Math.max(0, nowMs - this.lastMs);
    this.lastMs = nowMs;
    this.#updateFloor(level, dtMs);

    if (level >= this.closeDb) this.lastAboveCloseMs = nowMs;

    if (!this.isOpen && level >= this.openDb) {
      this.isOpen = true;
    } else if (this.isOpen && nowMs - this.lastAboveCloseMs > this.holdMs) {
      this.isOpen = false;
    }
    return this.isOpen;
  }

  #updateFloor(level, dtMs) {
    if (level < DIGITAL_SILENCE_DB) return;
    if (this.floorDb === null) {
      this.floorDb = level;
    } else if (level < this.floorDb) {
      // Filtro esponenziale indipendente dal frame rate: alpha = 1 − e^(−dt/τ)
      const alpha = 1 - Math.exp(-dtMs / this.floorFallMs);
      this.floorDb += (level - this.floorDb) * alpha;
    } else if (!this.isOpen) {
      this.floorDb = Math.min(level, this.floorDb + (this.floorRiseDbPerSec * dtMs) / 1000);
    }
  }
}
