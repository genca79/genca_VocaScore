/**
 * Prevenzione del Larsen (feedback acustico).
 *
 * Il Larsen nasce quando l'uscita del synth rientra nel microfono: il detector "sente" il synth,
 * il synth suona quello che sente e il ciclo si autoalimenta. Le difese sono su più livelli:
 *   1. echoCancellation di getUserMedia, attiva salvo synth abilitato in cuffia (audioInput.js);
 *   2. il microfono non è mai collegato all'uscita (audioInput.js);
 *   3. QUESTO MODULO: il synth suona mentre si canta SOLO su consenso esplicito dell'utente
 *      ("Suona synth mentre canti (solo con cuffie)"), mai in automatico;
 *   4. un Limiter in uscita (synth.js).
 *
 * Rilevamento delle cuffie: nessuna API web lo dice con certezza. Dopo il permesso del microfono
 * enumerateDevices() espone i nomi dei dispositivi e in Chromium/Edge l'uscita predefinita ha id
 * "default" e un nome tipo "Predefinito - Cuffie (Realtek…)". È un'euristica, quindi NON accende
 * il synth da sola: serve a mostrare un avviso se l'utente lo abilita mentre l'uscita sembra
 * sugli altoparlanti, e a decidere se si può spegnere la cancellazione dell'eco.
 */

const HEADPHONE_PATTERN = /head(phone|set)|cuffi|auricolar|earphone|earbud|airpods|buds|hands-?free|bluetooth/i;
const SPEAKER_PATTERN = /speaker|altoparlant|casse|monitor|hdmi|display/i;

export class FeedbackGuard {
  /** @param {(state: FeedbackState) => void} onChange */
  constructor(onChange) {
    this.onChange = onChange;
    this.liveSynthEnabled = false;
    this.autoDetected = null; // true = cuffie, false = altoparlanti, null = sconosciuto
    this.outputLabel = '';
    this.handleDeviceChange = () => this.detect();
  }

  /** Avvia la rilevazione e resta in ascolto di collegamenti e scollegamenti. */
  async init() {
    navigator.mediaDevices?.addEventListener('devicechange', this.handleDeviceChange);
    await this.detect();
  }

  dispose() {
    navigator.mediaDevices?.removeEventListener('devicechange', this.handleDeviceChange);
  }

  /** Scelta dell'utente: suonare il synth mentre canta. */
  setLiveSynth(enabled) {
    this.liveSynthEnabled = enabled;
    this.#emit();
  }

  async detect() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.label);
      // Firefox/Safari non elencano le uscite: stato "sconosciuto".
      const active = outputs.find((d) => d.deviceId === 'default') ?? outputs[0];
      if (!active) {
        this.autoDetected = null;
        this.outputLabel = '';
      } else {
        this.outputLabel = active.label;
        this.autoDetected = HEADPHONE_PATTERN.test(active.label) && !SPEAKER_PATTERN.test(active.label);
      }
    } catch {
      this.autoDetected = null;
    }
    this.#emit();
  }

  /** @returns {FeedbackState} */
  get state() {
    const enabled = this.liveSynthEnabled;
    const speakers = this.autoDetected === false;
    const device = this.outputLabel ? ` (${this.outputLabel})` : '';
    let reason;
    if (!enabled) {
      reason =
        'Mentre canti il synth resta muto. Attivalo solo con le cuffie: dagli altoparlanti rientrerebbe nel microfono (effetto Larsen).';
    } else if (speakers) {
      reason = `Attenzione: l'uscita audio sembra sugli altoparlanti${device}. Usa le cuffie per evitare l'effetto Larsen.`;
    } else if (this.autoDetected === true) {
      reason = `Synth attivo mentre canti. Cuffie rilevate${device}.`;
    } else {
      reason = 'Synth attivo mentre canti. Assicurati di usare le cuffie.';
    }
    return {
      outputAllowed: enabled,
      // In cuffia l'AEC è dannosa (attenua la voce quando il synth suona la stessa nota): la si spegne
      // solo se il synth è abilitato e l'uscita NON sembra sugli altoparlanti.
      disableEchoCancellation: enabled && !speakers,
      warning: enabled && speakers,
      autoDetected: this.autoDetected,
      liveSynthEnabled: enabled,
      outputLabel: this.outputLabel,
      reason,
    };
  }

  #emit() {
    this.onChange?.(this.state);
  }
}

/**
 * @typedef {{ outputAllowed:boolean, disableEchoCancellation:boolean, warning:boolean,
 *             autoDetected:boolean|null, liveSynthEnabled:boolean, outputLabel:string, reason:string }} FeedbackState
 */
