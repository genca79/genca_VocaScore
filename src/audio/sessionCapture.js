import * as Tone from 'tone';

/**
 * Registrazione in memoria dell'audio di una sessione (solo nel browser: non viene mai salvato su
 * disco né inviato), usata dalla rifinitura dopo lo Stop. Viene liberata appena analizzata.
 */

const MODULE_URL = new URL('./captureProcessor.js', import.meta.url).href;
let moduleLoaded = null;

export class SessionCapture {
  /** @param {{ captureRate?:number, maxMinutes?:number }} [options] */
  constructor({ captureRate = 16000, maxMinutes = 10 } = {}) {
    this.captureRate = captureRate;
    this.maxMinutes = maxMinutes;
    this.node = null;
  }

  /** @param {import('./audioInput.js').AudioInput} audioInput */
  async start(audioInput) {
    const ctx = Tone.getContext();
    // Caricato direttamente sul contesto (e non con ctx.addAudioWorkletModule, che ne ricorda uno solo).
    moduleLoaded ??= ctx.rawContext.audioWorklet.addModule(MODULE_URL);
    await moduleLoaded;

    const factor = Math.max(1, Math.floor(ctx.sampleRate / this.captureRate));
    this.sampleRate = ctx.sampleRate / factor;
    this.maxSamples = Math.round(this.maxMinutes * 60 * this.sampleRate);
    this.chunks = [];
    this.length = 0;
    this.truncated = false;
    this.startCtxTime = null;
    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));

    // Nessuna uscita: il nodo non è collegato agli altoparlanti (niente rischio di Larsen)
    // ed è comunque elaborato dal browser finché process() restituisce true.
    this.node = ctx.createAudioWorkletNode('vocascore-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { factor },
    });
    this.node.port.onmessage = ({ data }) => {
      if (data.type === 'start') this.startCtxTime = data.time;
      else if (data.type === 'data') {
        if (this.length + data.samples.length > this.maxSamples) this.truncated = true;
        else {
          this.chunks.push(data.samples);
          this.length += data.samples.length;
        }
      } else if (data.type === 'end') this.resolveEnded();
    };
    this.input = audioInput;
    audioInput.addTap(this.node);
  }

  /**
   * performance.now() del primo campione catturato: la stessa base dei tempi del metronomo.
   * null finché il thread audio non ha elaborato il primo blocco.
   */
  get startPerfMs() {
    if (this.startCtxTime === null) return null;
    const raw = Tone.getContext().rawContext;
    return performance.now() - raw.currentTime * 1000 + this.startCtxTime * 1000;
  }

  /**
   * Copia dell'audio catturato finora, da `fromSample` in poi (trascrizione dal vivo, durante la
   * sessione). Il campione è un indice alla frequenza `sampleRate` della cattura.
   * @param {number} fromSample
   * @returns {Float32Array}
   */
  samplesFrom(fromSample) {
    const from = Math.max(0, Math.min(this.length, Math.round(fromSample)));
    const out = new Float32Array(this.length - from);
    let offset = 0; // posizione del chunk corrente nell'audio catturato
    for (const chunk of this.chunks) {
      const end = offset + chunk.length;
      if (end > from) out.set(chunk.subarray(Math.max(0, from - offset)), Math.max(0, offset - from));
      offset = end;
    }
    return out;
  }

  /**
   * Ferma la cattura e restituisce l'audio. Va chiamata PRIMA di spegnere il microfono.
   * @returns {Promise<{ samples:Float32Array, sampleRate:number, startPerfMs:number, truncated:boolean }|null>}
   */
  async stop() {
    if (!this.node) return null;
    const node = this.node;
    this.node = null;
    node.port.postMessage('stop');
    await Promise.race([this.ended, new Promise((r) => setTimeout(r, 1500))]);
    this.input.removeTap(node);
    node.port.onmessage = null;
    if (this.startCtxTime === null || this.length === 0) return null;

    const samples = new Float32Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];

    return {
      samples,
      sampleRate: this.sampleRate,
      startPerfMs: this.startPerfMs, // orologio audio → performance.now(), come il metronomo
      truncated: this.truncated,
    };
  }
}
