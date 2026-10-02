import { MAX_VOICES } from '../music/scoreDocument.js';

/**
 * Pannello "Voci" della partitura: una riga per voce con
 *   Attiva (dove si registra e cosa si modifica) · nome · chiave · strumento · Muto · Solo · Elimina
 * e il pulsante "Aggiungi voce".
 *
 * Nome e chiave sono contenuto (annullabili con Ctrl+Z); strumento, muto e solo sono il mixer del
 * riascolto (salvati nel file, non annullabili). Il nome si conferma all'uscita dal campo o con Invio.
 *
 * Il pannello si ridisegna a ogni modifica del documento; il controllo che aveva il focus lo ritrova.
 */

const CLEF_OPTIONS = [
  ['auto', 'Chiave auto'],
  ['treble', 'Violino'],
  ['bass', 'Basso'],
];

/**
 * @param {import('../music/scoreDocument.js').ScoreDocument} doc
 * @param {{ list:HTMLElement, addButton:HTMLButtonElement, instruments:Record<string,{label:string}>,
 *           onStatus:(message:string) => void }} options
 */
export function createVoicePanel(doc, { list, addButton, instruments, onStatus }) {
  let recording = false;

  addButton.addEventListener('click', () => {
    const id = doc.addVoice();
    if (id) onStatus(`Aggiunta "${doc.voiceById(id).name}": è la voce attiva. Ctrl+Z per annullare.`);
  });

  function render() {
    // il focus si ritrova dopo il ridisegno: chiave = voce + controllo
    const focusKey = list.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
    list.replaceChildren(...doc.voices.map((voice) => row(voice)));
    if (focusKey) list.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
    addButton.disabled = recording || doc.voices.length >= MAX_VOICES;
    addButton.title = doc.voices.length >= MAX_VOICES ? `Massimo ${MAX_VOICES} voci` : 'Aggiungi una voce vuota alla partitura';
  }

  function row(voice) {
    const multi = doc.voices.length > 1;
    const active = voice.id === doc.voice.id;
    const el = document.createElement('div');
    el.className = `voice-row${active ? ' is-active' : ''}`;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', `Voce ${voice.name}`);
    const key = (control) => `${voice.id}:${control}`;

    // Attiva (radio): dove si registra e cosa si modifica
    const activeLabel = document.createElement('label');
    activeLabel.className = 'voice-active';
    const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'active-voice', checked: active });
    radio.disabled = recording;
    radio.dataset.focusKey = key('active');
    radio.setAttribute('aria-label', `Voce attiva: ${voice.name}`);
    radio.addEventListener('change', () => doc.setActiveVoice(voice.id));
    activeLabel.append(radio, Object.assign(document.createElement('span'), { textContent: 'Attiva' }));

    // Nome
    const name = Object.assign(document.createElement('input'), { type: 'text', value: voice.name, maxLength: 40 });
    name.className = 'voice-name';
    name.dataset.focusKey = key('name');
    name.setAttribute('aria-label', 'Nome della voce');
    name.addEventListener('change', () => doc.renameVoice(voice.id, name.value));
    name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());

    // Chiave
    const clef = select(
      CLEF_OPTIONS,
      voice.clef,
      `Chiave di ${voice.name}`,
      key('clef'),
      (value) => doc.setVoiceClef(voice.id, value),
    );

    // Strumento del riascolto
    const instrument = select(
      [['', 'Suono generale'], ...Object.entries(instruments).map(([id, { label }]) => [id, label])],
      voice.instrument && instruments[voice.instrument] ? voice.instrument : '',
      `Strumento di ${voice.name} nel riascolto`,
      key('instrument'),
      (value) => doc.setMix(voice.id, { instrument: value || null }),
    );

    // Muto / Solo (pulsanti a due stati)
    const mute = toggle('Muto', voice.muted, `Muto: ${voice.name}`, key('mute'), () => doc.setMix(voice.id, { muted: !voice.muted }));
    const solo = toggle('Solo', voice.solo, `Solo: ${voice.name}`, key('solo'), () => doc.setMix(voice.id, { solo: !voice.solo }));

    // Elimina (non l'ultima voce, non durante la registrazione)
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Elimina' });
    remove.className = 'voice-button';
    remove.dataset.focusKey = key('remove');
    remove.setAttribute('aria-label', `Elimina la voce ${voice.name}`);
    remove.disabled = recording || !multi;
    remove.addEventListener('click', () => {
      doc.removeVoice(voice.id);
      onStatus(`Voce "${voice.name}" eliminata. Ctrl+Z per annullare.`);
    });

    el.append(activeLabel, name, clef, instrument, mute, solo, remove);
    return el;
  }

  function select(options, value, label, focusKey, onChange) {
    const el = document.createElement('select');
    el.className = 'voice-select';
    el.dataset.focusKey = focusKey;
    el.setAttribute('aria-label', label);
    for (const [v, text] of options) el.add(new Option(text, v));
    el.value = value;
    el.addEventListener('change', () => onChange(el.value));
    return el;
  }

  function toggle(text, pressed, label, focusKey, onClick) {
    const el = Object.assign(document.createElement('button'), { type: 'button', textContent: text });
    el.className = `voice-button voice-toggle${pressed ? ' is-on' : ''}`;
    el.dataset.focusKey = focusKey;
    el.setAttribute('aria-pressed', String(pressed));
    el.setAttribute('aria-label', label);
    el.addEventListener('click', onClick);
    return el;
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
