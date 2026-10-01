/**
 * Stima dell'intonazione di riferimento di chi canta.
 *
 * Molti cantanti sono sistematicamente un po' calanti o crescenti rispetto a La = 440 Hz. Se lo
 * scarto si avvicina a mezzo semitono, ogni nota cade vicino al confine tra due note e viene
 * arrotondata a caso. Si stima quindi lo scarto medio (offset, in semitoni) e lo si sottrae prima
 * di arrotondare.
 *
 * ── Perché una media "circolare" ─────────────────────────────────────────
 * Lo scarto di una nota dal semitono più vicino sta in [−0.5, +0.5). Una nota a +0.49 e una a −0.49
 * sono quasi identiche (entrambe a metà tra due note), ma la loro media aritmetica (0) direbbe
 * "intonato". Trattando lo scarto come un angolo su un cerchio (θ = 2π · scarto) e mediando i
 * vettori (cos θ, sin θ), la media è corretta anche a cavallo del confine:
 *
 *     offset = atan2( Σ w·sin θ , Σ w·cos θ ) / 2π
 *
 * La lunghezza del vettore medio (0…1) indica quanto gli scarti sono coerenti: se è bassa
 * (scarti sparsi) non si corregge nulla.
 */

/** Media circolare pesata degli scarti (in semitoni) → { offset, coherence }. */
export function circularMeanOffset(values, weights = null) {
  let s = 0;
  let c = 0;
  let total = 0;
  values.forEach((v, i) => {
    const w = weights ? weights[i] : 1;
    const theta = 2 * Math.PI * v; // il periodo di 1 semitono rende irrilevante la parte intera
    s += w * Math.sin(theta);
    c += w * Math.cos(theta);
    total += w;
  });
  if (total === 0) return { offset: 0, coherence: 0 };
  return { offset: Math.atan2(s, c) / (2 * Math.PI), coherence: Math.hypot(s, c) / total };
}

/**
 * Stima incrementale durante il canto: ogni nota completata contribuisce con il suo centro
 * (MIDI continuo). Le note più vecchie pesano sempre meno (decadimento esponenziale), così la stima
 * segue un cantante che si "sposta" nel corso del brano.
 */
export class TuningEstimator {
  /**
   * @param {{ minNotes?:number, decay?:number, maxOffset?:number, minCoherence?:number, flipGuard?:number }} [options]
   *   Vicino a ±0.5 semitoni lo scarto è AMBIGUO: −0.47 rispetto a un Do equivale a +0.53 rispetto a
   *   un Si, e dai soli dati non si può sapere quale delle due fosse l'intenzione.
   *   - ambiguous: una stima oltre questa soglia non viene usata (né per scegliere la direzione né
   *     per cambiarla): si aspetta che i dati indichino una direzione chiara;
   *   - flipGuard: una volta scelta una direzione, la stima non salta al lato opposto se il nuovo
   *     valore supera questa soglia: la trascrizione resta coerente invece di oscillare di un semitono.
   */
  constructor({ minNotes = 3, decay = 0.85, maxOffset = 0.4, minCoherence = 0.5, flipGuard = 0.35, ambiguous = 0.45 } = {}) {
    Object.assign(this, { minNotes, decay, maxOffset, minCoherence, flipGuard, ambiguous });
    this.reset();
  }

  reset() {
    this.s = 0;
    this.c = 0;
    this.weight = 0;
    this.count = 0;
    this.applied = 0;
  }

  /**
   * @param {number} centerMidi altezza centrale della nota (MIDI continuo, non corretto)
   * @param {number} [weight] es. proporzionale alla durata: le note lunghe sono più affidabili
   */
  observe(centerMidi, weight = 1) {
    const theta = 2 * Math.PI * centerMidi;
    this.s = this.s * this.decay + weight * Math.sin(theta);
    this.c = this.c * this.decay + weight * Math.cos(theta);
    this.weight = this.weight * this.decay + weight;
    this.count++;
    this.#update();
  }

  /** Scarto applicato, in semitoni (0 finché i dati sono pochi o incoerenti). */
  get offset() {
    return this.applied;
  }

  #update() {
    if (this.count < this.minNotes || this.weight === 0) return;
    const coherence = Math.hypot(this.s, this.c) / this.weight;
    if (coherence < this.minCoherence) return; // scarti sparsi: si mantiene la stima precedente
    const estimate = Math.atan2(this.s, this.c) / (2 * Math.PI);
    if (Math.abs(estimate) > this.ambiguous) return; // zona ambigua: nessuna decisione
    const flips = this.applied !== 0 && Math.sign(estimate) !== Math.sign(this.applied);
    if (flips && Math.abs(estimate) > this.flipGuard) return;
    this.applied = Math.max(-this.maxOffset, Math.min(this.maxOffset, estimate));
  }

  /** Scarto in cents (arrotondato), per la UI. */
  get cents() {
    return Math.round(this.offset * 100);
  }
}
