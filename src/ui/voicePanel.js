import { MAX_VOICES, MAX_VOICE_DB, MIN_VOICE_DB } from '../music/scoreDocument.js';

/** "−6 dB", "0 dB", "+3 dB" (meno tipografico, come nel resto dell'interfaccia). */
export function formatDb(db) {
  if (db === 0) return '0 dB';
  return `${db > 0 ? '+' : '−'}${Math.abs(db)} dB`;
}
import { iconElement } from '../icons/index.js';

/**
 * Pannello "Voci" della partitura: una scheda per voce, tutto visibile (niente menu nascosti)
 *   riga 1: Attiva (dove si registra e cosa si modifica) · nome
 *   riga 2: Muto · Solo · strumento del riascolto (voce originale o synth)
 *   riga 3: Volume (cursore, in dB)
 *   riga 4: Chiave · Svuota la voce · Elimina la voce
 * e il pulsante "Aggiungi voce".
 *
 * Nome, chiave, svuota ed elimina sono contenuto (annullabili con Ctrl+Z); riascolto, muto, solo e
 * volume sono il mixer (salvati nel file, non annullabili). Il nome si conferma all'uscita dal campo o
 * con Invio.
 *
 * Il pannello si ridisegna a ogni modifica del documento: il controllo che aveva il focus lo ritrova.
 */

/** Valore del menu "riascolto" per la voce originale (non è uno strumento). */
const ORIGINAL = '__original';

const CLEF_OPTIONS = [
  ['auto', 'Automatica'],
  ['treble', 'Violino'],
  ['bass', 'Basso'],
];

/**
 * @param {import('../music/scoreDocument.js').ScoreDocument} doc
 * @param {{ list:HTMLElement, addButton:HTMLButtonElement, instruments:Record<string,{label:string}>,
 *           onStatus:(message:string) => void }} options
 */
export function createVoicePanel(doc, { list, addButton, instruments, onStatus, onVolumePreview = null }) {
  let recording = false;

  addButton.addEventListener('click', () => {
    const id = doc.addVoice();
    if (id) onStatus(`Aggiunta "${doc.voiceById(id).name}": è la voce attiva. Ctrl+Z per annullare.`);
  });

  function render() {
    // il focus si ritrova dopo il ridisegno: chiave = voce + controllo
    const focusKey = list.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    list.replaceChildren(...doc.voices.map((voice) => card(voice)));
    if (focusKey) list.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
    addButton.disabled = recording || doc.voices.length >= MAX_VOICES;
    addButton.title = doc.voices.length >= MAX_VOICES ? `Massimo ${MAX_VOICES} voci` : '';
  }

  function card(voice) {
    const active = voice.id === doc.voice.id;
    const key = (control) => `${voice.id}:${control}`;
    const el = document.createElement('div');
    el.className = `voice-row${active ? ' is-active' : ''}`;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', `Voce ${voice.name}`);

    // Riga 1: Attiva + nome
    const main = div('voice-main');
    const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'active-voice', checked: active });
    radio.disabled = recording;
    radio.dataset.focusKey = key('active');
    radio.setAttribute('aria-label', `Voce attiva: ${voice.name}`);
    radio.title = 'Voce attiva: qui registri e modifichi';
    radio.addEventListener('change', () => doc.setActiveVoice(voice.id));
    const radioWrap = Object.assign(document.createElement('label'), { className: 'voice-active' });
    radioWrap.append(radio);

    const name = Object.assign(document.createElement('input'), { type: 'text', value: voice.name, maxLength: 40 });
    name.className = 'voice-name';
    name.dataset.focusKey = key('name');
    name.setAttribute('aria-label', 'Nome della voce');
    name.addEventListener('change', () => doc.renameVoice(voice.id, name.value));
    name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());
    main.append(radioWrap, name);

    // Riga 2: Muto · Solo · cosa suona · Opzioni
    const mix = div('voice-mix');
    const mute = toggle('Muto', 'volume-x', voice.muted, `Muto: ${voice.name}`, key('mute'), () =>
      doc.setMix(voice.id, { muted: !voice.muted }),
    );
    const solo = toggle('Solo', 'headphones', voice.solo, `Solo: ${voice.name}`, key('solo'), () =>
      doc.setMix(voice.id, { solo: !voice.solo }),
    );
    // Strumento del riascolto, accanto a Solo: la voce originale (se c'è l'audio) o un suono del synth.
    // Il menu mostra già la scelta corrente: niente testo ripetuto accanto.
    const hasAudio = doc.hasAudio(voice.id);
    const playback = select(
      [
        ...(hasAudio ? [[ORIGINAL, 'Voce originale']] : []),
        ['', 'Synth: strumento generale'],
        ...Object.entries(instruments).map(([id, { label }]) => [id, `Synth: ${label}`]),
      ],
      hasAudio && voice.source === 'original' ? ORIGINAL : voice.instrument && instruments[voice.instrument] ? voice.instrument : '',
      key('playback'),
      (value) =>
        value === ORIGINAL
          ? doc.setMix(voice.id, { source: 'original' })
          : doc.setMix(voice.id, { source: 'synth', instrument: value || null }),
    );
    playback.className = 'voice-instrument';
    playback.setAttribute('aria-label', `Strumento di ${voice.name} nel riascolto`);
    playback.title = 'Con cosa suona questa voce quando premi Ascolta';
    mix.append(mute, solo, playback);

    el.append(main, mix, volumeRow(voice, key), editRow(voice, key));

    // Audio originale perso (pagina ricaricata): si dice, invece di passare al synth in silenzio.
    if (!hasAudio && doc.lostAudio(voice.id)) {
      el.append(
        Object.assign(document.createElement('p'), {
          className: 'voice-warning',
          textContent: 'Audio originale non più disponibile: si conserva solo finché la pagina resta aperta, o con File › Salva con l’audio originale.',
        }),
      );
    }
    return el;
  }

  /**
   * Volume della voce nel mix. Mentre si trascina il volume cambia subito nel suono (onVolumePreview),
   * senza ridisegnare il pannello (il cursore "salterebbe"); al rilascio si salva nella partitura.
   */
  function volumeRow(voice, key) {
    const row = Object.assign(document.createElement('label'), { className: 'inline-field voice-volume' });
    const slider = Object.assign(document.createElement('input'), {
      type: 'range',
      min: String(MIN_VOICE_DB),
      max: String(MAX_VOICE_DB),
      step: '1',
      value: String(voice.volumeDb),
    });
    slider.dataset.focusKey = key('volume');
    const readout = Object.assign(document.createElement('output'), { className: 'voice-volume-value' });
    const show = (db) => {
      const text = formatDb(db);
      readout.textContent = text;
      slider.setAttribute('aria-valuetext', text);
    };
    show(voice.volumeDb);
    slider.addEventListener('input', () => {
      show(Number(slider.value));
      onVolumePreview?.(voice.id, Number(slider.value));
    });
    slider.addEventListener('change', () => doc.setMix(voice.id, { volumeDb: Number(slider.value) }));
    slider.title = 'Volume di questa voce quando premi Ascolta e nell’audio esportato';
    row.append(Object.assign(document.createElement('span'), { textContent: 'Volume' }), slider, readout);
    return row;
  }

  /** Riga 3, sempre visibile: chiave, svuota, elimina. */
  function editRow(voice, key) {
    const row = div('voice-edit');
    const clef = select(CLEF_OPTIONS, voice.clef, key('clef'), (value) => doc.setVoiceClef(voice.id, value));
    // Svuota: cancella la trascrizione, la voce resta (si annulla con Ctrl+Z: niente conferma)
    const clear = Object.assign(document.createElement('button'), { type: 'button', className: 'voice-button' });
    clear.textContent = 'Svuota la voce';
    clear.dataset.focusKey = key('clear');
    clear.disabled = recording || voice.notes.length === 0;
    clear.title = voice.notes.length === 0 ? 'La voce è già vuota' : 'Cancella tutte le note della voce; nome e impostazioni restano';
    clear.addEventListener('click', () => {
      doc.clearVoice(voice.id);
      onStatus(`Voce "${voice.name}" svuotata. Ctrl+Z per annullare.`);
    });

    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'voice-button' });
    remove.append(...[iconElement('trash-2')].filter(Boolean), 'Elimina la voce');
    remove.dataset.focusKey = key('remove');
    remove.disabled = recording || doc.voices.length === 1;
    remove.title = doc.voices.length === 1 ? 'La partitura ha almeno una voce' : '';
    remove.addEventListener('click', () => {
      doc.removeVoice(voice.id);
      onStatus(`Voce "${voice.name}" eliminata. Ctrl+Z per annullare.`);
    });

    row.append(field('Chiave', clef), clear, remove);
    return row;
  }

  function select(choices, value, focusKey, onChange) {
    const el = document.createElement('select');
    el.dataset.focusKey = focusKey;
    for (const [v, text] of choices) el.add(new Option(text, v));
    el.value = value;
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }

  /** Etichetta visibile accanto al controllo (il nome accessibile viene dall'etichetta). */
  function field(label, control) {
    const el = Object.assign(document.createElement('label'), { className: 'inline-field' });
    el.append(Object.assign(document.createElement('span'), { textContent: label }), control);
    return el;
  }

  /** Pulsante a due stati con icona + testo; aria-pressed perché il nome NON cambia. */
  function toggle(text, icon, pressed, label, focusKey, onClick) {
    const el = Object.assign(document.createElement('button'), { type: 'button' });
    el.className = `voice-button voice-toggle${pressed ? ' is-on' : ''}`;
    el.append(...[iconElement(icon)].filter(Boolean), text);
    el.dataset.focusKey = focusKey;
    el.setAttribute('aria-pressed', String(pressed));
    el.setAttribute('aria-label', label);
    el.addEventListener('click', onClick);
    return el;
  }

  function div(className) {
    return Object.assign(document.createElement('div'), { className });
  }

  doc.addEventListener('change', render);
  render();

  return {
    /** Durante la registrazione la voce attiva e la struttura della partitura sono bloccate. */
    setRecording(value) {
      recording = value;
      render();
    },
  };
}
