import * as Tone from 'tone';
import { DEFAULT_INSTRUMENT, INSTRUMENTS } from './instruments.js';

/**
 * Motore sonoro: due voci (live e riascolto) che condividono strumento ed effetti.
 *
 *   voce live      → liveBus (mute anti-Larsen) ┐
 *                                                ├→ master (volume) → filtro (brillantezza) → riverbero → limiter → uscita
 *   voce riascolto → playBus ───────────────────┘
 *
 * Perché due voci separate:
 *   - la voce live viene silenziata dal FeedbackGuard quando non ci sono cuffie;
 *   - il riascolto avviene a microfono spento, quindi non può innescare il Larsen e deve
 *     sentirsi anche dagli altoparlanti.
 */

/** Brillantezza [0, 1] → frequenza di taglio del filtro, su scala esponenziale (400 Hz – 18 kHz). */
function brightnessToHz(b) {
  return 400 * (18000 / 400) ** b;
}

export class SynthEngine {
  /**
   * @param {{ volumeDb?:number, portamento?:number, instrument?:string, octave?:number,
   *           brightness?:number, reverb?:number }} options
   */
  constructor({ volumeDb = -8, portamento = 0.03, instrument = DEFAULT_INSTRUMENT, octave = 0, brightness = 0.8, reverb = 0.15 } = {}) {
    // Il limiter impedisce picchi improvvisi in uscita: ultima rete di sicurezza contro il Larsen.
    this.limiter = new Tone.Limiter(-6).toDestination();
    this.reverb = new Tone.Reverb({ decay: 2.8, preDelay: 0.01, wet: reverb }).connect(this.limiter);
    this.filter = new Tone.Filter({ type: 'lowpass', frequency: brightnessToHz(brightness), rolloff: -12, Q: 0.5 }).connect(
      this.reverb,
    );
    this.master = new Tone.Volume(volumeDb).connect(this.filter);
    this.liveBus = new Tone.Volume(0).connect(this.master);
    this.playBus = new Tone.Volume(0).connect(this.master);

    this.portamento = portamento;
    this.octave = octave;
    this.liveMidi = null; // nota live che sta suonando
    this.part = null;
    this.playToken = 0;
    /** Notificato a ogni avvio/fine del riascolto (fine naturale, Stop o sostituzione). */
    this.onPlaybackChange = null;
    /** Notificato con l'id della nota che inizia a suonare nel riascolto (null alla fine). */
    this.onPlaybackNote = null;
    this.setInstrument(instrument);
  }

  // ── Impostazioni del suono ─────────────────────────────────────────────

  setInstrument(id) {
    const preset = INSTRUMENTS[id] ?? INSTRUMENTS[DEFAULT_INSTRUMENT];
    const wasLive = this.liveMidi;
    // Il riascolto in corso NON si ferma: il Part legge this.playVoice a ogni nota,
    // quindi le note successive useranno il nuovo strumento.
    this.liveVoice?.dispose();
    this.playVoice?.dispose();

    this.instrumentId = INSTRUMENTS[id] ? id : DEFAULT_INSTRUMENT;
    this.liveVoice = preset.create().connect(this.liveBus);
    this.liveVoice.volume.value = preset.gainDb;
    this.liveVoice.portamento = this.portamento; // glide nel legato dal vivo
    this.playVoice = preset.create().connect(this.playBus);
    this.playVoice.volume.value = preset.gainDb;
    this.playVoice.portamento = 0; // nel riascolto note pulite, come sono scritte

    // Se si cambia strumento mentre si canta, la nota corrente prosegue col nuovo timbro.
    this.liveMidi = null;
    if (wasLive !== null) this.liveNoteOn(wasLive);
  }

  /** Trasposizione di ottava in uscita (−2…+2): il pentagramma mostra comunque la nota cantata. */
  setOctave(octave) {
    this.octave = octave;
    if (this.liveMidi !== null) this.liveVoice.setNote(this.#freq(this.liveMidi));
  }

  setBrightness(value) {
    this.filter.frequency.rampTo(brightnessToHz(value), 0.05);
  }

  setReverb(wet) {
    this.reverb.wet.rampTo(wet, 0.05);
  }

  setVolume(db) {
    this.master.volume.rampTo(db, 0.05);
  }

  // ── Voce live ──────────────────────────────────────────────────────────

  /**
   * Non si chiama triggerAttackRelease a ogni frame (produrrebbe click e ri-attacchi continui):
   *   - noteOn con la voce ferma  → triggerAttack (attacco dell'inviluppo)
   *   - noteOn con la voce attiva → setNote (cambio di frequenza legato, con glide)
   */
  liveNoteOn(midi) {
    if (this.liveMidi !== null) this.liveVoice.setNote(this.#freq(midi));
    else this.liveVoice.triggerAttack(this.#freq(midi));
    this.liveMidi = midi;
  }

  liveNoteOff() {
    if (this.liveMidi === null) return;
    this.liveVoice.triggerRelease();
    this.liveMidi = null;
  }

  /** Il mute agisce sul bus live: la voce continua a "suonare" ma senza uscita. */
  setLiveMuted(muted) {
    this.liveBus.mute = muted;
  }

  // ── Riascolto ──────────────────────────────────────────────────────────

  get isPlaying() {
    return this.part !== null;
  }

  /**
   * Suona una sequenza di note sul Transport di Tone (scheduling a tempo di campione, senza jitter).
   * @param {Array<{ id?:string, time:number, duration:number, midi:number }>} events tempi in secondi
   */
  play(events) {
    this.stopPlayback();
    if (events.length === 0) return;

    // Durante la performance live lookAhead è 0 (reattività massima). Per il riascolto
    // si torna a programmare gli eventi in anticipo: timing preciso anche se il thread è occupato.
    Tone.getContext().lookAhead = 0.1;

    const token = ++this.playToken;
    const transport = Tone.getTransport();
    // Staccato leggero (92%): due note uguali consecutive si sentono separate.
    this.part = new Tone.Part((time, ev) => {
      this.playVoice.triggerAttackRelease(this.#freq(ev.midi), ev.duration * 0.92, time);
      // Draw esegue il callback quando la nota viene davvero sentita (non quando viene programmata).
      Tone.getDraw().schedule(() => {
        if (token === this.playToken) this.onPlaybackNote?.(ev.id ?? null);
      }, time);
    }, events.map((ev) => [ev.time, ev])).start(0);

    const last = events.at(-1);
    transport.scheduleOnce((time) => {
      // Draw allinea il callback al momento in cui l'audio viene davvero sentito.
      Tone.getDraw().schedule(() => {
        if (token === this.playToken) this.stopPlayback(); // altrimenti già fermato o sostituito
      }, time);
    }, last.time + last.duration + 0.3);

    transport.start('+0.05');
    this.onPlaybackChange?.(true);
  }

  stopPlayback() {
    if (!this.part) return;
    this.playToken++;
    this.part.dispose();
    this.part = null;
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel(0);
    this.playVoice.triggerRelease();
    Tone.getContext().lookAhead = 0;
    this.onPlaybackNote?.(null);
    this.onPlaybackChange?.(false);
  }

  #freq(midi) {
    return Tone.Frequency(midi + 12 * this.octave, 'midi').toFrequency();
  }

  dispose() {
    this.stopPlayback();
    for (const node of [this.liveVoice, this.playVoice, this.liveBus, this.playBus, this.master, this.filter, this.reverb, this.limiter]) {
      node.dispose();
    }
  }
}
