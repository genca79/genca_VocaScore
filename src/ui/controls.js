/**
 * Collegamento al DOM. Nessuna logica audio: riceve dati e li mostra, inoltra le azioni dell'utente.
 */

const METER_FLOOR_DB = -80; // livello mostrato come "vuoto" nel VU meter

/** Mappa dBFS [−80, 0] → percentuale [0, 100] per il VU meter. */
function dbToPercent(db) {
  if (!Number.isFinite(db)) return 0;
  return Math.min(100, Math.max(0, ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100));
}

/**
 * @param {{ onToggle:() => void, onHeadphonesChange:(v:boolean) => void,
 *           onAccompanyChange:(v:boolean) => void, accompany:boolean,
 *           onPlayToggle:() => void, onPreview:() => void,
 *           onSoundChange:(change:{ instrument?:string, octave?:number, brightness?:number, reverb?:number, volumeDb?:number }) => void,
 *           instruments:Record<string,{label:string}>, sound:object, gateOpenDb:number }} handlers
 */
export function createControls({
  onToggle,
  onHeadphonesChange,
  onAccompanyChange,
  accompany,
  onPlayToggle,
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
  const noteEl = $('note-name');
  const hzEl = $('note-hz');
  const centsEl = $('note-cents');
  const needleEl = $('tuner-needle');
  const meterFill = $('meter-fill');
  const gateLed = $('gate-led');
  const headphonesInput = $('headphones');
  const feedbackEl = $('feedback-reason');
  const outputBadge = $('output-badge');
  const beatEl = $('beat-indicator');
  const tuningEl = $('tuning-info');
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

  const STATES = {
    idle: { label: 'Avvia microfono', status: 'Microfono spento', busy: false, running: false },
    starting: { label: 'Avvio…', status: 'Richiesta del permesso per il microfono…', busy: true, running: false },
    running: { label: 'Ferma microfono', status: 'In ascolto: canta una nota!', busy: false, running: true },
  };

  return {
    /** @param {'idle'|'starting'|'running'} state */
    setState(state) {
      const s = STATES[state];
      toggleBtn.textContent = s.label;
      toggleBtn.disabled = s.busy;
      toggleBtn.classList.toggle('is-running', s.running);
      toggleBtn.setAttribute('aria-pressed', String(s.running));
      statusEl.textContent = s.status;
    },

    showError(message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    },

    clearError() {
      errorEl.hidden = true;
      errorEl.textContent = '';
    },

    /** Chiamata a ogni frame (~60 fps): solo assegnazioni economiche, niente layout pesanti. */
    updateFrame(frame) {
      if (!frame) {
        meterFill.style.width = '0%';
        levelEl.textContent = 'Livello';
        gateLed.classList.remove('is-open');
        noteEl.textContent = '–';
        hzEl.textContent = '— Hz';
        centsEl.textContent = '';
        needleEl.style.transform = 'translateX(-50%) rotate(0deg)';
        return;
      }
      meterFill.style.width = `${dbToPercent(frame.db)}%`;
      // Il gate è adattivo: il marcatore mostra la soglia di apertura del momento.
      thresholdEl.style.left = `${dbToPercent(frame.gateOpenDb)}%`;
      levelEl.textContent = Number.isFinite(frame.db)
        ? `${Math.round(frame.db)} / ${Math.round(frame.gateOpenDb)} dB`
        : `— / ${Math.round(frame.gateOpenDb)} dB`;
      gateLed.classList.toggle('is-open', frame.gateOpen);
      if (frame.note) {
        const { name, hz, cents } = frame.note;
        noteEl.textContent = name;
        hzEl.textContent = `${hz.toFixed(1)} Hz`;
        centsEl.textContent = `${cents > 0 ? '+' : ''}${cents} cent`;
        // ±50 cents → ±45° di rotazione dell'ago dell'accordatore
        needleEl.style.transform = `translateX(-50%) rotate(${cents * 0.9}deg)`;
        needleEl.classList.toggle('is-in-tune', Math.abs(cents) <= 10);
      } else {
        noteEl.textContent = '–';
        hzEl.textContent = '— Hz';
        centsEl.textContent = '';
      }
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
      playBtn.textContent = playing ? '■ Stop' : '▶ Riascolta';
      playBtn.classList.toggle('is-playing', playing);
      playBtn.setAttribute('aria-pressed', String(playing));
    },

    /** Scarto d'intonazione stimato (cents) e frequenza di riferimento corrispondente. */
    setTuning(cents) {
      if (cents === 0) {
        tuningEl.textContent = 'Intonazione: allineata a La = 440 Hz';
        tuningEl.classList.remove('is-active');
        return;
      }
      const a4 = 440 * 2 ** (cents / 1200);
      const sign = cents > 0 ? '+' : '−';
      tuningEl.textContent = `Intonazione stimata: ${sign}${Math.abs(cents)} cent (La = ${a4.toFixed(1)} Hz), compensata`;
      tuningEl.classList.add('is-active');
    },

    setCanPlay(canPlay) {
      playBtn.disabled = !canPlay;
    },

    /** @param {import('../audio/feedbackGuard.js').FeedbackState} state */
    setFeedback(state) {
      headphonesInput.checked = state.liveSynthEnabled;
      feedbackEl.textContent = state.reason;
      feedbackEl.classList.toggle('is-warning', state.warning);
      outputBadge.textContent = state.outputAllowed ? 'Synth attivo' : 'Synth muto';
      outputBadge.classList.toggle('is-on', state.outputAllowed);
    },
  };
}
