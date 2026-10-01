import * as Tone from 'tone';

/**
 * Metronomo con battuta di attacco (count-in).
 *
 * Scheduling "a due orologi": un timer JS ogni 25 ms programma in anticipo, sull'orologio audio
 * (preciso al campione), i click dei prossimi 120 ms. Così il tempo resta esatto anche se il thread
 * principale è occupato (analisi della voce, disegno del pentagramma).
 *
 * Anti-Larsen: il click è un suono brevissimo e fisso, non segue la voce, quindi non può innescare
 * un anello di retroazione. Le sue frequenze (1200 e 1800 Hz) sono sopra l'estensione analizzata dal
 * pitch detector (max 1100 Hz): anche se il microfono lo sente, non viene scambiato per una nota.
 */
export class Metronome {
  constructor({ volumeDb = -12 } = {}) {
    this.output = new Tone.Volume(volumeDb).toDestination();
    this.click = new Tone.Synth({
      oscillator: { type: 'square' },
      envelope: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.01 },
    }).connect(this.output);
    this.timer = null;
    this.visualTimers = new Set();
  }

  /**
   * @param {{ bpm:number, beatsPerMeasure:number, countInBeats:number,
   *           onBeat?:(info:{ beat:number, accent:boolean, countIn:boolean }) => void }} options
   *   `beat` è negativo durante la battuta di attacco (−4, −3, −2, −1), poi 0, 1, 2…
   * @returns {number} istante (performance.now(), ms) in cui si SENTE il primo movimento dopo l'attacco
   */
  start({ bpm, beatsPerMeasure, countInBeats, onBeat }) {
    this.stop();
    const ctx = Tone.getContext();
    const raw = ctx.rawContext;
    // Ritardo tra la programmazione di un suono e il momento in cui esce dalle casse.
    const outputLatencyMs = ((raw.outputLatency || 0) + (raw.baseLatency || 0)) * 1000;
    const beatSec = 60 / bpm;
    const startTime = ctx.currentTime + 0.15;
    let beat = -countInBeats;
    let next = startTime;

    const schedule = () => {
      while (next < ctx.currentTime + 0.12) {
        const inMeasure = ((beat % beatsPerMeasure) + beatsPerMeasure) % beatsPerMeasure;
        const accent = inMeasure === 0;
        this.click.triggerAttackRelease(accent ? 1800 : 1200, 0.03, next, accent ? 1 : 0.6);

        // Indicatore visivo sincronizzato con il suono (che esce dopo outputLatencyMs).
        const info = { beat, accent, countIn: beat < 0 };
        const id = setTimeout(() => {
          this.visualTimers.delete(id);
          onBeat?.(info);
        }, Math.max(0, (next - ctx.currentTime) * 1000 + outputLatencyMs));
        this.visualTimers.add(id);

        beat++;
        next += beatSec;
      }
    };
    schedule();
    this.timer = setInterval(schedule, 25);

    // Conversione orologio audio → performance.now(), il riferimento dei timestamp della voce.
    const firstBeatTime = startTime + countInBeats * beatSec;
    return performance.now() + (firstBeatTime - ctx.currentTime) * 1000 + outputLatencyMs;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const id of this.visualTimers) clearTimeout(id);
    this.visualTimers.clear();
  }

  get isRunning() {
    return this.timer !== null;
  }

  dispose() {
    this.stop();
    this.click.dispose();
    this.output.dispose();
  }
}
