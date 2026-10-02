import * as Tone from 'tone';
import { DEFAULT_INSTRUMENT, INSTRUMENTS } from './instruments.js';

/**
 * Motore sonoro: la voce live e le voci del riascolto condividono gli effetti.
 *
 *   voce live                → liveBus (mute anti-Larsen) ┐
 *                                                          ├→ master (volume) → filtro → riverbero → limiter → uscita
 *   voci del riascolto (1/voce della partitura) → playBus ┘
 *
 * Perché bus separati:
 *   - la voce live viene silenziata dal FeedbackGuard quando non ci sono cuffie;
 *   - il riascolto avviene a microfono spento (o, registrando una nuova voce, in cuffia), quindi
 *     deve sentirsi anche dagli altoparlanti.
 *
 * Polifonia: gli strumenti sono monofonici (instruments.js), quindi nel riascolto ogni voce della
 * partitura ha la SUA istanza dello strumento, creata all'avvio e liberata alla fine. Come in un coro:
 * ogni voce canta una nota alla volta, tutte insieme fanno gli accordi.
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
    /** @type {Map<string, any>} istanze dello strumento del riascolto, una per voce della partitura */
    this.playVoices = new Map();
    this.playToken = 0;
    /** Notificato a ogni avvio/fine del riascolto (fine naturale, Stop o sostituzione). */
    this.onPlaybackChange = null;
    /** Notificato con (id della nota, id della voce) quando una nota inizia a suonare; (null, null) alla fine. */
    this.onPlaybackNote = null;
    this.setInstrument(instrument);
  }

  // ── Impostazioni del suono ─────────────────────────────────────────────

  /**
   * Strumento generale: voce live e voci della partitura senza uno strumento proprio.
   * Un riascolto in corso prosegue con gli strumenti con cui è partito.
   */
  setInstrument(id) {
    const preset = INSTRUMENTS[id] ?? INSTRUMENTS[DEFAULT_INSTRUMENT];
    const wasLive = this.liveMidi;
    this.liveVoice?.dispose();

    this.instrumentId = INSTRUMENTS[id] ? id : DEFAULT_INSTRUMENT;
    this.liveVoice = preset.create().connect(this.liveBus);
    this.liveVoice.volume.value = preset.gainDb;
    this.liveVoice.portamento = this.portamento; // glide nel legato dal vivo

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
    // Tone.immediate(): subito, anche mentre il riascolto (altre voci, registrando) usa il lookAhead.
    if (this.liveMidi !== null) this.liveVoice.setNote(this.#freq(midi), Tone.immediate());
    else this.liveVoice.triggerAttack(this.#freq(midi), Tone.immediate());
    this.liveMidi = midi;
  }

  liveNoteOff() {
    if (this.liveMidi === null) return;
    this.liveVoice.triggerRelease(Tone.immediate());
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
   * Suona le note (di una o più voci, in polifonia) sul Transport di Tone: scheduling a tempo di
   * campione, senza jitter.
   * @param {Array<{ id?:string, voiceId?:string, instrument?:string|null, time:number, duration:number, midi:number }>} events
   *   tempi in secondi; le note con lo stesso voiceId suonano sulla stessa istanza (monofonica);
   *   instrument null/assente = strumento generale
   * @param {{ at?:number|null }} [options] at: istante dell'orologio audio (s) in cui far partire il
   *   tempo 0, es. il primo movimento dopo la battuta d'attacco del metronomo; default: subito
   */
  play(events, { at = null } = {}) {
    this.stopPlayback();
    if (events.length === 0) return;

    // Durante la performance live lookAhead è 0 (reattività massima). Per il riascolto
    // si torna a programmare gli eventi in anticipo: timing preciso anche se il thread è occupato.
    Tone.getContext().lookAhead = 0.1;

    // Un'istanza dello strumento per voce. Il volume complessivo scende con il numero di voci
    // (a potenza costante), così un coro di 4 voci non suona 4 volte più forte di una.
    const voiceIds = [...new Set(events.map((ev) => ev.voiceId ?? ''))];
    for (const voiceId of voiceIds) {
      const instrument = events.find((ev) => (ev.voiceId ?? '') === voiceId).instrument;
      const preset = INSTRUMENTS[instrument] ?? INSTRUMENTS[this.instrumentId];
      const synth = preset.create().connect(this.playBus);
      synth.volume.value = preset.gainDb;
      synth.portamento = 0; // nel riascolto note pulite, come sono scritte
      this.playVoices.set(voiceId, synth);
    }
    this.playBus.volume.value = -10 * Math.log10(voiceIds.length);

    const token = ++this.playToken;
    const transport = Tone.getTransport();
    // Staccato leggero (92%): due note uguali consecutive si sentono separate.
    this.part = new Tone.Part((time, ev) => {
      this.playVoices.get(ev.voiceId ?? '')?.triggerAttackRelease(this.#freq(ev.midi), ev.duration * 0.92, time);
      // Draw esegue il callback quando la nota viene davvero sentita (non quando viene programmata).
      Tone.getDraw().schedule(() => {
        if (token === this.playToken) this.onPlaybackNote?.(ev.id ?? null, ev.voiceId ?? null);
      }, time);
    }, events.map((ev) => [ev.time, ev])).start(0);

    const end = Math.max(...events.map((ev) => ev.time + ev.duration));
    transport.scheduleOnce((time) => {
      // Draw allinea il callback al momento in cui l'audio viene davvero sentito.
      Tone.getDraw().schedule(() => {
        if (token === this.playToken) this.stopPlayback(); // altrimenti già fermato o sostituito
      }, time);
    }, end + 0.3);

    transport.start(at ?? '+0.05');
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
    // Rilascio dolce, poi le istanze vengono liberate (dopo la coda del suono).
    const voices = [...this.playVoices.values()];
    this.playVoices.clear();
    for (const synth of voices) synth.triggerRelease(Tone.immediate());
    setTimeout(() => voices.forEach((synth) => synth.dispose()), 3000);
    Tone.getContext().lookAhead = 0;
    this.onPlaybackNote?.(null, null);
    this.onPlaybackChange?.(false);
  }

  #freq(midi) {
    return Tone.Frequency(midi + 12 * this.octave, 'midi').toFrequency();
  }

  dispose() {
    this.stopPlayback();
    for (const node of [this.liveVoice, this.liveBus, this.playBus, this.master, this.filter, this.reverb, this.limiter]) {
      node.dispose();
    }
  }
}
