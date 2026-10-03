/**
 * Collegamento al DOM. Nessuna logica audio: riceve dati e li mostra, inoltra le azioni dell'utente.
 */

import { setIcon } from '../icons/index.js';
import { TunerReadout } from '../music/tunerReadout.js';

const METER_FLOOR_DB = -80; // livello mostrato come "vuoto" nel VU meter

/** Testo e icona di un pulsante (l'icona è decorativa: il nome accessibile è il testo). */
function setButton(button, label, icon) {
  button.textContent = label;
  setIcon(button, icon);
}

/** Mappa dBFS [−80, 0] → percentuale [0, 100] per il VU meter. */
function dbToPercent(db) {
  if (!Number.isFinite(db)) return 0;
  return Math.min(100, Math.max(0, ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100));
}

/**
 * @param {{ onToggle:() => void, onHeadphonesChange:(v:boolean) => void,
 *           onAccompanyChange:(v:boolean) => void, accompany:boolean,
 *           onPlayToggle:() => void, onLoopChange:(v:boolean) => void, loop:boolean, onPreview:() => void,
 *           onSoundChange:(change:{ instrument?:string, octave?:number, brightness?:number, reverb?:number, volumeDb?:number }) => void,
 *           instruments:Record<string,{label:string}>, sound:object, gateOpenDb:number }} handlers
 */
export function createControls({
  onToggle,
  onHeadphonesChange,
  onAccompanyChange,
  accompany,
  onPlayToggle,
  onLoopChange,
  loop,
  onPreview,
  onSoundChange,
  instruments,
  sound,
  gateOpenDb,
}) {
  const $ = (id) => document.getElementById(id);
  const toggleBtn = $('mic-toggle');
  const statusEl = $('status');
  const errorEl = $('error');
  // tuner
  const tunerPanel = $('tuner-panel');
  const tunerSource = $('tuner-source');
  const noteEl = $('note-name');
  const sciEl = $('note-sci');
  const hzEl = $('note-hz');
  const markerEl = $('tuner-marker');
  const verdictEl = $('tuner-verdict');
  const writtenEl = $('tuner-written');
  const micLevel = $('mic-level');
  const readout = new TunerReadout();
  const meterFill = $('meter-fill');
  const gateLed = $('gate-led');
  const headphonesInput = $('headphones');
  const feedbackEl = $('feedback-reason');
  const beatEl = $('beat-indicator');
  const thresholdEl = $('meter-threshold');
  const levelEl = $('meter-label');

  thresholdEl.style.left = `${dbToPercent(gateOpenDb)}%`;

  toggleBtn.addEventListener('click', onToggle);
  headphonesInput.addEventListener('change', () => onHeadphonesChange(headphonesInput.checked));
  const accompanyInput = $('accompany');
  accompanyInput.checked = accompany;
  accompanyInput.addEventListener('change', () => onAccompanyChange(accompanyInput.checked));

  // ── Riascolto e suono ──
  const playBtn = $('play-score');
  playBtn.addEventListener('click', onPlayToggle);

  // Loop: pulsante a due stati (il nome resta "Loop": lo stato è in aria-pressed)
  const loopBtn = $('loop-toggle');
  loopBtn.setAttribute('aria-pressed', String(loop));
  loopBtn.addEventListener('click', () => {
    const next = loopBtn.getAttribute('aria-pressed') !== 'true';
    loopBtn.setAttribute('aria-pressed', String(next));
    onLoopChange(next);
  });
  $('preview-sound').addEventListener('click', onPreview);

  const instrumentSel = $('instrument');
  for (const [id, { label }] of Object.entries(instruments)) instrumentSel.add(new Option(label, id));

  /** Collega un controllo a una chiave delle impostazioni del suono. */
  const bindSound = (id, key, event = 'input') => {
    const el = $(id);
    el.value = String(sound[key]);
    el.addEventListener(event, () => {
      onSoundChange({ [key]: key === 'instrument' ? el.value : Number(el.value) });
    });
  };
  bindSound('instrument', 'instrument', 'change');
  bindSound('octave', 'octave', 'change');
  bindSound('brightness', 'brightness');
  bindSound('reverb', 'reverb');
  bindSound('volume', 'volumeDb');

  /** Mostra una lettura del tuner (null = nessuna nota). */
  function showReading(r) {
    if (!r) {
      noteEl.textContent = '–';
      sciEl.textContent = '';
      hzEl.textContent = '';
      markerEl.hidden = true;
      verdictEl.textContent = 'In attesa di una nota';
      verdictEl.className = 'tuner-verdict';
      return;
    }
    noteEl.textContent = r.italian;
    sciEl.textContent = r.scientific;
    hzEl.textContent = r.hz ? `${r.hz.toFixed(1)} Hz` : '';
    markerEl.hidden = false;
    markerEl.style.left = `${50 + Math.max(-50, Math.min(50, r.cents))}%`; // ±50 cent → 0–100%
    verdictEl.textContent = r.verdict.label;
    verdictEl.className = `tuner-verdict is-${r.verdict.level}`;
  }

  // Il pulsante cambia nome (Registra → Stop): niente aria-pressed, che con un nome che cambia
  // farebbe leggere "Stop, premuto".
  const STATES = {
    idle: { label: 'Registra', icon: 'mic', status: 'Pronto. Premi Registra e canta.', busy: false, running: false },
    starting: { label: 'Avvio…', icon: 'mic', status: 'Richiesta del permesso per il microfono…', busy: true, running: false },
    running: { label: 'Stop', icon: 'square', status: 'In registrazione: canta!', busy: false, running: true },
  };

  return {
    /** @param {'idle'|'starting'|'running'} state */
    setState(state) {
      const s = STATES[state];
      setButton(toggleBtn, s.label, s.icon);
      toggleBtn.disabled = s.busy;
      toggleBtn.classList.toggle('is-running', s.running);
      statusEl.textContent = s.status;
      if (state === 'idle') this.setTuner(null);
      else this.setTuner({ source: 'Microfono: la nota che stai cantando', mic: true });
    },

    /**
     * Tuner: visibile registrando (microfono, con il livello) e ascoltando (la voce attiva).
     * @param {null | { source:string, mic?:boolean }} mode null = nascosto
     */
    setTuner(mode) {
      tunerPanel.hidden = !mode;
      readout.reset();
      showReading(null);
      writtenEl.textContent = '';
      if (!mode) return;
      tunerSource.textContent = mode.source;
      micLevel.hidden = !mode.mic;
    },

    /**
     * Un frame di altezza per il tuner (microfono o voce in riascolto), ~60 volte al secondo.
     * @param {{ exactMidi:number|null, hz?:number|null, timeMs:number }} frame altezza reale (La = 440 Hz)
     */
    updatePitch(frame) {
      showReading(readout.update(frame));
    },

    /** Riascolto: la nota della partitura che sta suonando nella voce seguita dal tuner. */
    setWritten(text) {
      writtenEl.textContent = text;
    },

    showError(message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    },

    clearError() {
      errorEl.hidden = true;
      errorEl.textContent = '';
    },

    /** Frame del microfono (~60 fps): livello, soglia, e l'altezza per il tuner. */
    updateFrame(frame) {
      if (!frame) {
        meterFill.style.width = '0%';
        levelEl.textContent = 'Livello';
        gateLed.classList.remove('is-open');
        showReading(null);
        return;
      }
      meterFill.style.width = `${dbToPercent(frame.db)}%`;
      // Il gate è adattivo: il marcatore mostra la soglia di apertura del momento.
      thresholdEl.style.left = `${dbToPercent(frame.gateOpenDb)}%`;
      levelEl.textContent = Number.isFinite(frame.db)
        ? `${Math.round(frame.db)} / ${Math.round(frame.gateOpenDb)} dB`
        : `— / ${Math.round(frame.gateOpenDb)} dB`;
      gateLed.classList.toggle('is-open', frame.gateOpen);
      this.updatePitch({ exactMidi: frame.note?.exactMidi ?? null, hz: frame.note?.hz ?? null, timeMs: frame.timeMs });
    },

    /**
     * Indicatore visivo del metronomo: un pallino per movimento, il primo (accento) in arancione.
     * Durante la battuta di attacco mostra il conto alla rovescia nello stato.
     * @param {{ beat:number, accent:boolean, countIn:boolean }|null} info
     */
    setBeat(info, beatsPerMeasure = 4) {
      if (!info) {
        beatEl.hidden = true;
        beatEl.replaceChildren();
        return;
      }
      if (beatEl.children.length !== beatsPerMeasure) {
        beatEl.replaceChildren(
          ...Array.from({ length: beatsPerMeasure }, () => Object.assign(document.createElement('span'), { className: 'beat-dot' })),
        );
      }
      beatEl.hidden = false;
      beatEl.classList.toggle('is-count-in', info.countIn);
      const index = ((info.beat % beatsPerMeasure) + beatsPerMeasure) % beatsPerMeasure;
      [...beatEl.children].forEach((dot, i) => {
        dot.classList.toggle('is-on', i === index);
        dot.classList.toggle('is-accent', i === 0);
      });
      if (info.countIn) statusEl.textContent = `Attacco… ${-info.beat}`;
      else if (info.beat === 0) statusEl.textContent = 'Canta!';
    },

    setPlaying(playing) {
      setButton(playBtn, playing ? 'Stop' : 'Ascolta', playing ? 'square' : 'play');
      playBtn.classList.toggle('is-playing', playing);
    },

    setCanPlay(canPlay) {
      playBtn.disabled = !canPlay;
    },

    /** @param {import('../audio/feedbackGuard.js').FeedbackState} state */
    setFeedback(state) {
      headphonesInput.checked = state.liveSynthEnabled;
      // Solo l'avviso che serve (synth attivo con l'uscita sugli altoparlanti): niente etichette di stato.
      feedbackEl.textContent = state.warning ? state.reason : '';
      feedbackEl.hidden = !state.warning;
    },
  };
}
