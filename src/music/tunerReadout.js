import { midiToItalianName, midiToNoteName } from './noteUtils.js';
import { median } from './pitchCenter.js';

/**
 * Lettura del tuner, comprensibile e stabile, da una sequenza di frame (~60 al secondo) di altezza.
 *
 * Il valore grezzo del rilevatore oscilla: vibrato della voce (±20–50 cent a 5–7 Hz), piccolo rumore,
 * qualche errore d'ottava isolato. Mostrato così, l'indicatore trema e il giudizio cambia di continuo.
 * Come un accordatore:
 *   1. mediana degli ultimi frame: un frame sbagliato (es. un'ottava sopra) non passa;
 *   2. media esponenziale nel TEMPO (costante `tauMs`, ~250 ms), non per frame: uguale a 60 o 144 Hz.
 *      Il vibrato (periodo ~180 ms) viene attenuato a pochi cent; si legge l'altezza centrale;
 *   3. isteresi sul nome: la nota mostrata cambia solo quando la voce se ne allontana di oltre
 *      `switchSemitones` (0,65): una voce a +48 cent non salta avanti e indietro fra due note;
 *   4. scatto: se la voce resta lontana dal valore mostrato (oltre `jumpSemitones`) per `jumpMs`,
 *      è una nota nuova cantata davvero: la lettura riparte da lì, senza trascinare la precedente;
 *   5. tenuta: un breve buco senza altezza (consonante, respiro) non cancella la lettura (`holdMs`).
 *
 * Il giudizio è in parole, oltre che a colori (WCAG 1.4.1): "Intonato", "Un po' crescente (+18 cent)",
 * "Calante (−32 cent)". Soglie: ±10 cent intonato (non distinguibile per la maggior parte degli
 * ascoltatori), ±25 "un po'", oltre fuori.
 *
 * Modulo puro (nessun DOM): l'interfaccia mostra ciò che restituisce `update`.
 */

export const IN_TUNE_CENTS = 10;
export const NEAR_CENTS = 25;

/**
 * Giudizio sull'intonazione.
 * @param {number} cents scarto dalla nota mostrata (di solito in [−50, 50]; con l'isteresi fino a ±65)
 * @returns {{ level:'ok'|'near'|'off', label:string }}
 */
export function tuningVerdict(cents) {
  const c = Math.round(cents);
  if (Math.abs(c) <= IN_TUNE_CENTS) return { level: 'ok', label: 'Intonato' };
  const amount = `${c > 0 ? '+' : '−'}${Math.abs(c)} cent`;
  const direction = c > 0 ? 'crescente' : 'calante';
  if (Math.abs(c) <= NEAR_CENTS) return { level: 'near', label: `Un po’ ${direction} (${amount})` };
  return { level: 'off', label: `${direction[0].toUpperCase()}${direction.slice(1)} (${amount})` };
}

export class TunerReadout {
  /**
   * @param {{ tauMs?:number, medianWindow?:number, switchSemitones?:number, jumpSemitones?:number,
   *           jumpMs?:number, holdMs?:number }} [options]
   */
  constructor({ tauMs = 250, medianWindow = 5, switchSemitones = 0.65, jumpSemitones = 0.8, jumpMs = 90, holdMs = 300 } = {}) {
    Object.assign(this, { tauMs, medianWindow, switchSemitones, jumpSemitones, jumpMs, holdMs });
    this.reset();
  }

  reset() {
    this.recent = []; // ultimi valori grezzi (per la mediana)
    this.smoothed = null; // altezza continua smorzata
    this.midi = null; // nota mostrata
    this.hz = null;
    this.lastMs = null;
    this.lastVoicedMs = -Infinity;
    this.awaySinceMs = null; // da quando la voce è lontana dal valore mostrato
  }

  /**
   * @param {{ exactMidi:number|null, hz?:number|null, timeMs:number }} frame
   *   exactMidi: altezza continua (MIDI con decimali) o null se il frame non ha altezza
   * @returns {null | { midi:number, italian:string, scientific:string, cents:number, hz:number|null,
   *                    verdict:{ level:'ok'|'near'|'off', label:string } }}
   *   null = nessuna nota da mostrare (silenzio oltre la tenuta)
   */
  update({ exactMidi, hz = null, timeMs }) {
    if (exactMidi === null || exactMidi === undefined || !Number.isFinite(exactMidi)) {
      if (this.midi === null || timeMs - this.lastVoicedMs > this.holdMs) {
        this.reset();
        return null;
      }
      return this.#readout(); // tenuta: l'ultima lettura resta
    }

    // 1. mediana: via gli errori isolati
    this.recent.push(exactMidi);
    if (this.recent.length > this.medianWindow) this.recent.shift();
    const value = median(this.recent);

    if (this.smoothed === null) {
      this.smoothed = value;
    } else {
      // 4. scatto su una nota nuova, tenuta per jumpMs
      if (Math.abs(value - this.smoothed) > this.jumpSemitones) {
        this.awaySinceMs ??= timeMs;
        if (timeMs - this.awaySinceMs >= this.jumpMs) {
          this.smoothed = value;
          this.recent = [exactMidi];
          this.awaySinceMs = null;
        }
      } else {
        this.awaySinceMs = null;
        // 2. media esponenziale nel tempo: alpha = 1 − e^(−dt/τ)
        const dt = Math.max(0, timeMs - (this.lastMs ?? timeMs));
        this.smoothed += (value - this.smoothed) * (1 - Math.exp(-dt / this.tauMs));
      }
    }
    this.lastMs = timeMs;

    // 3. isteresi sul nome della nota
    if (this.midi === null || Math.abs(this.smoothed - this.midi) > this.switchSemitones) {
      this.midi = Math.round(this.smoothed);
    }
    this.hz = hz;
    this.lastVoicedMs = timeMs;
    return this.#readout();
  }

  #readout() {
    const cents = Math.round((this.smoothed - this.midi) * 100);
    return {
      midi: this.midi,
      italian: midiToItalianName(this.midi),
      scientific: midiToNoteName(this.midi),
      cents,
      hz: this.hz,
      verdict: tuningVerdict(cents),
    };
  }
}
