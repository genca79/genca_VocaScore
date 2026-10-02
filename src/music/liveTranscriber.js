/**
 * Trascrizione DAL VIVO con lo stesso algoritmo della rifinitura e di "Carica Audio ALA"
 * (offlineTranscriber.js), applicato all'audio della sessione mentre si canta.
 *
 * A ogni giro (~0,5 s) si rianalizza l'audio dagli ultimi `contextSec` secondi fino all'ultimo campione
 * catturato. Tutte le note di quel tratto sono PROVVISORIE: vengono ricalcolate al giro dopo, con più
 * contesto. Sul tratto recente il pentagramma mostra quindi esattamente ciò che darebbe l'analisi del
 * file intero, comprese le decisioni che dipendono da ciò che viene DOPO (entrate "da fuori", sillabe,
 * intonazione di chi canta stimata su tutte le note del tratto).
 * Le note che escono dal tratto (più vecchie di `contextSec`) diventano DEFINITIVE e non si
 * ricalcolano più: così il costo di ogni giro resta limitato anche in una sessione lunga.
 *
 * Differenze che restano rispetto all'analisi dell'intera registrazione (disponibile allo Stop):
 *   - l'intonazione è stimata sugli ultimi `contextSec` secondi, non su tutta la sessione;
 *   - la prima nota dopo il punto di taglio non "vede" la precedente (per le entrate conta come inizio
 *     di un gruppo).
 * Il rumore di fondo invece è condiviso tra i giri: il più basso misurato fa da tetto (floorCapDb),
 * perché un tratto tutto cantato non contiene abbastanza silenzio per stimarlo.
 *
 * È un modulo puro: chi lo usa esegue la trascrizione (in un Web Worker) e passa qui il risultato.
 */
export class LiveTranscriber {
  /** @param {{ contextSec?:number, silenceMarginSec?:number }} [options] */
  constructor({ contextSec = 12, silenceMarginSec = 0.5 } = {}) {
    this.contextSec = contextSec;
    this.silenceMarginSec = silenceMarginSec;
    /** @type {Array<{ midi:number, start:number, end:number, transition:boolean }>} tempi in s dall'inizio */
    this.final = [];
    this.provisional = [];
    /** Inizio dell'audio da analizzare al prossimo giro (s dall'inizio della sessione). */
    this.windowStartSec = 0;
    /** Rumore di fondo più basso misurato finora (dBFS), da passare come floorCapDb. */
    this.floorCapDb = undefined;
  }

  /** Tutte le note finora: definitive + provvisorie, in ordine. */
  get notes() {
    return [...this.final, ...this.provisional];
  }

  /**
   * @param {{ notes:Array<{ midi:number, start:number, end:number, transition:boolean }>, floorDb?:number|null }} result
   *   trascrizione dell'audio da `fromSec` (tempi relativi all'inizio dell'audio analizzato)
   * @param {number} fromSec inizio dell'audio analizzato (s dall'inizio della sessione): windowStartSec
   * @param {number} endSec fine dell'audio analizzato (s dall'inizio della sessione)
   * @param {{ final?:boolean }} [options] final: ultimo giro (allo Stop), tutte le note diventano definitive
   */
  accept(result, fromSec, endSec, { final = false } = {}) {
    if (Number.isFinite(result.floorDb)) this.floorCapDb = Math.min(this.floorCapDb ?? Infinity, result.floorDb);
    const notes = result.notes.map((n) => ({ ...n, start: n.start + fromSec, end: n.end + fromSec }));
    if (final) {
      this.final.push(...notes);
      this.provisional = [];
      return;
    }

    // Diventano definitive le note che al prossimo giro uscirebbero dal tratto analizzato.
    const freezeBefore = endSec - this.contextSec;
    let k = 0;
    while (k < notes.length && notes[k].end <= freezeBefore) k++;
    this.final.push(...notes.slice(0, k));
    this.provisional = notes.slice(k);

    if (k > 0) {
      // Il prossimo giro parte dopo l'ultima nota definitiva: a metà del silenzio che la segue
      // (al massimo 0,1 s dopo), o subito alla sua fine se è legata alla successiva.
      const last = notes[k - 1];
      const gapEnd = notes[k]?.start ?? endSec;
      this.windowStartSec = Math.max(this.windowStartSec, last.end + Math.min(0.1, Math.max(0, gapEnd - last.end) / 2));
    } else if (notes.length === 0) {
      // Nessuna nota nel tratto: è tutto silenzio fino a poco prima della fine (una nota che stesse
      // iniziando proprio ora cade nel margine e verrà analizzata al prossimo giro).
      this.windowStartSec = Math.max(this.windowStartSec, endSec - this.silenceMarginSec);
    }
  }
}
