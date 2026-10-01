/**
 * AudioWorklet di cattura: registra l'audio del microfono durante la sessione, per la rifinitura
 * dopo lo Stop. Gira sul thread audio (nessun campione perso anche se la pagina è occupata).
 *
 * Decimazione: si conserva un campione ogni `factor` facendo la media del gruppo (filtro passa-basso
 * elementare + sottocampionamento). A 48 kHz con factor 3 → 16 kHz: la voce (fondamentale ≤ 1.1 kHz)
 * è rappresentata senza problemi e la memoria si riduce a un terzo.
 *
 * Se il microfono si scollega per un istante (es. cambio di stream per la cancellazione dell'eco)
 * si registra silenzio: la linea del tempo resta continua.
 */
const BLOCK = 8192;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.factor = Math.max(1, Math.floor(options.processorOptions?.factor ?? 1));
    this.block = new Float32Array(BLOCK);
    this.n = 0;
    this.acc = 0;
    this.count = 0;
    this.started = false;
    this.active = true;
    this.port.onmessage = (e) => {
      if (e.data !== 'stop') return;
      this.flush();
      this.port.postMessage({ type: 'end' });
      this.active = false;
    };
  }

  flush() {
    if (this.n === 0) return;
    const out = this.block.slice(0, this.n);
    this.port.postMessage({ type: 'data', samples: out }, [out.buffer]);
    this.n = 0;
  }

  process(inputs) {
    if (!this.active) return false;
    const channel = inputs[0]?.[0];
    const length = channel ? channel.length : 128;
    if (!this.started) {
      this.started = true;
      // currentTime (orologio audio) del primo campione catturato: serve ad allineare la registrazione
      this.port.postMessage({ type: 'start', time: currentTime });
    }
    for (let i = 0; i < length; i++) {
      this.acc += channel ? channel[i] : 0;
      if (++this.count === this.factor) {
        this.block[this.n++] = this.acc / this.factor;
        this.acc = 0;
        this.count = 0;
        if (this.n === BLOCK) {
          const out = this.block;
          this.port.postMessage({ type: 'data', samples: out }, [out.buffer]);
          this.block = new Float32Array(BLOCK);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('vocascore-capture', CaptureProcessor);
