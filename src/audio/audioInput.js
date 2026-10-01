/**
 * Gestione del microfono: permessi, vincoli DSP, errori e ciclo di vita dello stream.
 */

/** Errore con un codice stabile e un messaggio pronto per la UI. */
export class AudioInputError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'AudioInputError';
    this.code = code;
    this.cause = cause;
  }
}

/** Traduce gli errori DOMException di getUserMedia in messaggi comprensibili. */
function mapGetUserMediaError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new AudioInputError(
        'PERMISSION_DENIED',
        "Accesso al microfono negato. Abilitalo dall'icona del lucchetto nella barra degli indirizzi e riprova.",
        err,
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new AudioInputError('NO_DEVICE', 'Nessun microfono trovato. Collegane uno e riprova.', err);
    case 'NotReadableError':
    case 'AbortError':
      return new AudioInputError(
        'DEVICE_BUSY',
        "Il microfono è in uso da un'altra applicazione o non risponde. Chiudila e riprova.",
        err,
      );
    default:
      return new AudioInputError('UNKNOWN', `Impossibile avviare il microfono: ${err?.message ?? err}`, err);
  }
}

export class AudioInput {
  /**
   * @param {BaseAudioContext} audioContext contesto condiviso (vedi audioContext.js)
   * @param {{ fftSize:number, constraints:MediaTrackConstraints }} options
   */
  constructor(audioContext, { fftSize, constraints }) {
    this.ctx = audioContext;
    this.fftSize = fftSize;
    this.constraints = constraints;
    this.stream = null;
    this.source = null;
    this.analyser = null;
    /** Nodi aggiuntivi che ricevono il microfono (es. la cattura per la rifinitura). */
    this.taps = new Set();
    /** Chiamata se il dispositivo sparisce durante l'uso (es. cuffie USB scollegate). */
    this.onEnded = null;
  }

  /** Collega un nodo al microfono; resta collegato anche se lo stream viene riaperto. */
  addTap(node) {
    this.taps.add(node);
    this.source?.connect(node);
  }

  removeTap(node) {
    this.taps.delete(node);
    try {
      this.source?.disconnect(node);
    } catch {
      // già scollegato
    }
  }

  get isActive() {
    return this.stream !== null;
  }

  /** Impostazioni realmente applicate dal browser (i vincoli sono solo "desideri"). */
  get trackSettings() {
    return this.stream?.getAudioTracks()[0]?.getSettings() ?? {};
  }

  /** @returns {Promise<AnalyserNode>} */
  async start() {
    if (this.isActive) return this.analyser;

    if (!window.isSecureContext) {
      throw new AudioInputError(
        'INSECURE_CONTEXT',
        "Il microfono è disponibile solo su HTTPS o su localhost. Apri l'app da un indirizzo sicuro.",
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new AudioInputError('UNSUPPORTED', "Questo browser non supporta l'accesso al microfono.");
    }

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    // Nessuno smoothing: ci servono i campioni grezzi nel dominio del tempo, non lo spettro mediato.
    this.analyser.smoothingTimeConstant = 0;

    try {
      this.#attachStream(await navigator.mediaDevices.getUserMedia({ audio: this.constraints, video: false }));
    } catch (err) {
      this.analyser = null;
      throw mapGetUserMediaError(err);
    }
    return this.analyser;
  }

  /**
   * Attiva/disattiva la cancellazione dell'eco senza fermare l'analisi.
   *
   * Perché disattivarla: l'AEC del browser sottrae dal microfono ciò che esce dagli altoparlanti.
   * Se il synth suona la STESSA nota che stai cantando, l'AEC scambia la voce per eco e la attenua:
   * il gate si chiude, il synth tace, la voce torna, il gate si riapre… e una nota lunga si spezza
   * in tante note. In cuffia non c'è eco da cancellare, quindi l'AEC è solo dannosa.
   *
   * Chromium non sempre applica il cambio con applyConstraints(): in quel caso si riapre lo
   * stream sullo stesso dispositivo e lo si ricollega allo stesso AnalyserNode (il loop non si ferma).
   */
  async setEchoCancellation(enabled) {
    if (!this.isActive || this.trackSettings.echoCancellation === enabled) return;
    this.constraints = { ...this.constraints, echoCancellation: enabled };

    const track = this.stream.getAudioTracks()[0];
    try {
      await track.applyConstraints(this.constraints);
      if (track.getSettings().echoCancellation === enabled) return;
    } catch {
      // ignorato: si passa alla riapertura dello stream
    }

    const { deviceId } = this.trackSettings;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...this.constraints, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      video: false,
    });
    if (!this.isActive) {
      stream.getTracks().forEach((t) => t.stop()); // stop() chiamato nel frattempo
      return;
    }
    this.#detachStream();
    this.#attachStream(stream);
  }

  #attachStream(stream) {
    this.stream = stream;
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      if (this.stream !== stream) return; // stream già sostituito
      this.stop();
      this.onEnded?.(new AudioInputError('DEVICE_LOST', 'Il microfono è stato scollegato.'));
    });
    this.source = this.ctx.createMediaStreamSource(stream);
    // IMPORTANTE (anti-Larsen): il microfono va SOLO ai nodi di analisi e MAI a ctx.destination.
    // Collegarlo all'uscita creerebbe un anello diretto microfono → altoparlante → microfono.
    this.source.connect(this.analyser);
    for (const tap of this.taps) this.source.connect(tap);
  }

  #detachStream() {
    this.stream?.getTracks().forEach((t) => t.stop()); // spegne anche l'indicatore del microfono nel browser
    this.source?.disconnect();
    this.stream = null;
    this.source = null;
  }

  stop() {
    this.#detachStream();
    this.analyser = null;
    this.taps.clear();
  }
}
