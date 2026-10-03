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
    // voce originale nel riascolto: niente filtro né riverbero, come è stata registrata (solo il limiter)
    this.voiceBus = new Tone.Volume(0).connect(this.limiter);
    /** nodi delle riprese in riascolto (player e guadagni), liberati alla fine */
    this.clipNodes = [];
    /** @type {Map<string, { synth:{ node:any, base:number }|null, clips:any[] }>} volume di ogni voce nel riascolto */
    this.levels = new Map();

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
   * @param {{ at?:number|null, clips?:Array<{ buffer:AudioBuffer, at:number, from:number, to:number,
   *           mutes:Array<[number, number]> }> }} [options]
   *   at: istante dell'orologio audio (s) in cui far partire il tempo 0, es. il primo movimento dopo la
   *   battuta d'attacco del metronomo; default: subito.
   *   clips: riprese della voce originale (vedi ScoreDocument.playbackPlan): ognuna suona il suo tratto
   *   [from, to] (s della ripresa) col suo istante 0 al tempo `at`, zittita nei tratti `mutes`.
   *   Gli eventi `silent` (note suonate da una ripresa) servono solo a evidenziare le note.
   * @param {{ loop?:boolean, loopEnd?:number|null, autoStop?:boolean }} [more]
   *   loop: il riascolto ricomincia da capo arrivato a `loopEnd` (s; default: fine delle note), finché
   *   non si ferma o si spegne il loop (setLoop). autoStop false: nessuno stop programmato alla fine
   *   (esportazione audio: il rendering finisce da solo, e lo stop toccherebbe il Transport principale).
   */
  play(events, { at = null, clips = [], loop = false, loopEnd = null, autoStop = true } = {}) {
    this.stopPlayback();
    if (events.length === 0 && clips.length === 0) return;

    // Durante la performance live lookAhead è 0 (reattività massima). Per il riascolto
    // si torna a programmare gli eventi in anticipo: timing preciso anche se il thread è occupato.
    Tone.getContext().lookAhead = 0.1;

    // Un'istanza dello strumento per voce suonata dal synth. Il volume complessivo scende con il numero
    // di sorgenti (a potenza costante), così un coro di 4 voci non suona 4 volte più forte di una.
    const voiceIds = [...new Set(events.filter((ev) => !ev.silent).map((ev) => ev.voiceId ?? ''))];
    for (const voiceId of voiceIds) {
      const { instrument, gainDb = 0 } = events.find((ev) => (ev.voiceId ?? '') === voiceId && !ev.silent);
      const preset = INSTRUMENTS[instrument] ?? INSTRUMENTS[this.instrumentId];
      const synth = preset.create().connect(this.playBus);
      synth.volume.value = preset.gainDb + gainDb; // compensazione dello strumento + volume della voce
      synth.portamento = 0; // nel riascolto note pulite, come sono scritte
      this.playVoices.set(voiceId, synth);
      this.#level(voiceId).synth = { node: synth, base: preset.gainDb };
    }
    const sources = Math.max(1, voiceIds.length + clips.length);
    this.playBus.volume.value = -10 * Math.log10(sources);
    this.voiceBus.volume.value = -10 * Math.log10(sources);

    const token = ++this.playToken;
    const transport = Tone.getTransport();
    for (const clip of clips) this.#scheduleClip(clip, transport);

    // Staccato leggero (92%): due note uguali consecutive si sentono separate.
    this.part = new Tone.Part((time, ev) => {
      if (!ev.silent) this.playVoices.get(ev.voiceId ?? '')?.triggerAttackRelease(this.#freq(ev.midi), ev.duration * 0.92, time);
      // Draw esegue il callback quando la nota viene davvero sentita (non quando viene programmata).
      Tone.getDraw().schedule(() => {
        if (token === this.playToken) this.onPlaybackNote?.(ev.id ?? null, ev.voiceId ?? null);
      }, time);
    }, events.map((ev) => [ev.time, ev])).start(0);

    const end = Math.max(0, ...events.map((ev) => ev.time + ev.duration), ...clips.map((c) => c.at + c.to));
    // Il Transport ripete tutto ciò che è programmato fra 0 e loopEnd: note, riprese e zittimenti.
    this.loopEnd = loopEnd ?? end;
    transport.loopStart = 0;
    transport.loopEnd = this.loopEnd;
    transport.loop = loop;
    if (autoStop) {
      // Fine del riascolto: senza loop subito dopo l'ultima nota. Programmato sempre, e ripetuto a ogni
      // giro (schedule, non scheduleOnce): spegnendo il loop a metà, si ferma alla fine di quel giro.
      transport.schedule((time) => {
        // Draw allinea il callback al momento in cui l'audio viene davvero sentito.
        Tone.getDraw().schedule(() => {
          if (token === this.playToken && !Tone.getTransport().loop) this.stopPlayback(); // altrimenti fermato, sostituito o in loop
        }, time);
      }, Math.min(end + 0.3, loop ? this.loopEnd - 0.01 : Infinity));
    }

    transport.start(at ?? '+0.05');
    this.onPlaybackChange?.(true);
  }

  /**
   * Analizzatore collegato SOLO alla voce originale di una voce nel riascolto in corso (per il tuner:
   * analizzare il mix confonderebbe le altezze di più voci). null se la voce non suona una ripresa.
   * Si stacca da solo alla fine del riascolto (i nodi delle riprese vengono liberati).
   * @returns {AnalyserNode|null}
   */
  monitorVoice(voiceId) {
    const clips = this.levels.get(voiceId)?.clips ?? [];
    if (clips.length === 0) return null;
    const analyser = Tone.getContext().rawContext.createAnalyser();
    analyser.fftSize = 2048; // come il microfono (config.audio.fftSize)
    analyser.smoothingTimeConstant = 0;
    for (const volume of clips) volume.connect(analyser);
    return analyser;
  }

  /** Volume di una voce (dB) anche a riascolto in corso: synth e voce originale. */
  setVoiceVolume(voiceId, db) {
    const level = this.levels.get(voiceId);
    if (!level) return;
    if (level.synth) level.synth.node.volume.rampTo(level.synth.base + db, 0.05);
    for (const volume of level.clips) volume.volume.rampTo(db, 0.05);
  }

  /** Nodi del volume di una voce nel riascolto in corso (per setVoiceVolume). */
  #level(voiceId) {
    if (!this.levels.has(voiceId)) this.levels.set(voiceId, { synth: null, clips: [] });
    return this.levels.get(voiceId);
  }

  /** Accende o spegne il loop anche a riascolto in corso (spento: si ferma alla fine del giro). */
  setLoop(loop) {
    if (!this.part) return;
    const transport = Tone.getTransport();
    transport.loop = loop;
    if (!loop && transport.seconds >= this.loopEnd - 0.05) this.stopPlayback();
  }

  stopPlayback() {
    if (!this.part) return;
    this.playToken++;
    this.part.dispose();
    this.part = null;
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel(0);
    transport.loop = false;
    // Rilascio dolce, poi le istanze vengono liberate (dopo la coda del suono).
    const voices = [...this.playVoices.values()];
    this.playVoices.clear();
    this.levels.clear();
    for (const synth of voices) synth.triggerRelease(Tone.immediate());
    setTimeout(() => voices.forEach((synth) => synth.dispose()), 3000);
    // le riprese si fermano con il Transport; i loro nodi si liberano subito
    for (const node of this.clipNodes) node.dispose();
    this.clipNodes = [];
    Tone.getContext().lookAhead = 0;
    this.onPlaybackNote?.(null, null);
    this.onPlaybackChange?.(false);
  }

  /**
   * Una ripresa della voce originale sul Transport: parte, si ferma e riparte insieme alle note.
   * I tratti zittiti (note modificate a mano, suonate dal synth) hanno rampe di 15 ms: niente click.
   */
  #scheduleClip({ voiceId, buffer, at, from, to, mutes, gainDb = 0 }, transport) {
    // ripresa → zittimenti (0/1) → volume della voce → bus della voce originale
    const volume = new Tone.Volume(gainDb).connect(this.voiceBus);
    const gain = new Tone.Gain(1).connect(volume);
    const player = new Tone.Player(buffer).connect(gain).sync();
    this.clipNodes.push(player, gain, volume);
    this.#level(voiceId ?? '').clips.push(volume);

    let startAt = at + from; // tempo (s dal tempo 0) in cui inizia il tratto
    let offset = from; // da dove si legge la ripresa
    if (startAt < 0) {
      offset -= startAt; // si riparte a metà (riascolto da una nota selezionata)
      startAt = 0;
    }
    const duration = Math.min(to, buffer.duration) - offset;
    if (duration <= 0) return;
    player.start(startAt, offset, duration);

    const RAMP = 0.015;
    for (const [m0, m1] of mutes) {
      const t0 = at + m0;
      const t1 = at + m1;
      if (t1 <= 0) continue;
      transport.schedule((time) => {
        gain.gain.setValueAtTime(gain.gain.getValueAtTime(time), time);
        gain.gain.linearRampToValueAtTime(0, time + RAMP);
      }, Math.max(0, t0 - RAMP));
      transport.schedule((time) => {
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(1, time + RAMP);
      }, t1);
    }
  }

  #freq(midi) {
    return Tone.Frequency(midi + 12 * this.octave, 'midi').toFrequency();
  }

  dispose() {
    this.stopPlayback();
    for (const node of [this.liveVoice, this.liveBus, this.playBus, this.voiceBus, this.master, this.filter, this.reverb, this.limiter]) {
      node.dispose();
    }
  }
}
