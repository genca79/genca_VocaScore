// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ScoreDocument } from '../src/music/scoreDocument.js';
import { createDocumentControls } from '../src/ui/documentControls.js';
import { createVoicePanel } from '../src/ui/voicePanel.js';
import { createControls } from '../src/ui/controls.js';
import { ScoreEditor } from '../src/ui/scoreEditor.js';
import { decorateIcons } from '../src/icons/index.js';

/**
 * L'interfaccia vera (index.html) con i moduli che la collegano al documento, in un DOM simulato:
 * verifica che ogni comando sia collegato (id giusti) e che i comportamenti dell'interfaccia
 * rivista funzionino. L'audio (microfono, synth) e il pentagramma non sono coinvolti.
 */
const PAGE = readFileSync(join(process.cwd(), 'index.html'), 'utf8')
  .replace(/^[\s\S]*<body>/, '')
  .replace(/<\/body>[\s\S]*$/, '')
  .replace(/<script[\s\S]*?<\/script>/g, '');

const INSTRUMENTS = { lead: { label: 'Synth Lead' }, organ: { label: 'Organo' } };
const $ = (id) => document.getElementById(id);
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

let doc;
let handlers;
let ui;
let editor;

beforeEach(() => {
  // happy-dom non ha il costruttore Option dei browser (usato per riempire i menu a tendina)
  globalThis.Option ??= function Option(text = '', value = text) {
    return Object.assign(document.createElement('option'), { text, value });
  };
  document.body.innerHTML = PAGE;
  decorateIcons(document);
  doc = new ScoreDocument();
  handlers = {
    onNew: vi.fn(),
    onOpen: vi.fn(),
    onLoadAudio: vi.fn(async () => {}),
    onSave: vi.fn(),
    onExportMusicXml: vi.fn(),
    onExportPdf: vi.fn(async () => {}),
    onExportAudio: vi.fn(async () => {}),
  };
  createDocumentControls(doc, handlers);
  createVoicePanel(doc, { list: $('voice-list'), addButton: $('add-voice'), instruments: INSTRUMENTS, onStatus: () => {} });
  ui = createControls({
    onToggle: vi.fn(),
    onHeadphonesChange: vi.fn(),
    onAccompanyChange: vi.fn(),
    accompany: true,
    onPlayToggle: vi.fn(),
    onLoopChange: vi.fn(),
    loop: false,
    onPreview: vi.fn(),
    onSoundChange: vi.fn(),
    instruments: INSTRUMENTS,
    sound: { instrument: 'lead', octave: 0, brightness: 0.8, reverb: 0.15, volumeDb: -8 },
    gateOpenDb: -50,
  });
  editor = new ScoreEditor(doc, { toolbars: [$('edit-toolbar'), $('history-toolbar')], info: $('selection-info') });
});

describe('barra in alto', () => {
  it('Registra ↔ Stop: testo e icona cambiano, il pannello di registrazione appare solo registrando', () => {
    ui.setState('idle');
    expect($('mic-toggle').textContent).toBe('Registra');
    expect($('tuner-panel').hidden).toBe(true);
    ui.setState('running');
    expect($('mic-toggle').textContent).toBe('Stop');
    expect($('mic-toggle').dataset.icon).toBe('square');
    expect($('mic-toggle').hasAttribute('aria-pressed')).toBe(false);
    expect($('tuner-panel').hidden).toBe(false);
  });

  it('Ascolta ↔ Stop', () => {
    ui.setPlaying(true);
    expect($('play-score').textContent).toBe('Stop');
    ui.setPlaying(false);
    expect($('play-score').textContent).toBe('Ascolta');
    expect($('play-score').querySelectorAll('svg')).toHaveLength(1);
  });

  it('Annulla e Ripeti in alto funzionano e si attivano solo quando serve', () => {
    const undo = document.querySelector('#history-toolbar [data-action="undo"]');
    expect(undo.disabled).toBe(true);
    doc.append({ midi: 60, beats: 1 });
    expect(undo.disabled).toBe(false);
    click(undo);
    expect(doc.notes).toHaveLength(0);
  });

  it('il campo del titolo ha un’etichetta visibile', () => {
    expect($('score-title').closest('label').textContent).toContain('Titolo');
  });
});

describe('menu File', () => {
  it('Salva e "Salva con l’audio originale" sono due scelte distinte; il menu si chiude dopo la scelta', () => {
    const menu = $('file-menu');
    menu.open = true;
    click($('save-score'));
    expect(handlers.onSave).toHaveBeenLastCalledWith({ includeAudio: false });
    expect(menu.open).toBe(false);
    menu.open = true;
    click($('save-score-audio'));
    expect(handlers.onSave).toHaveBeenLastCalledWith({ includeAudio: true });
    click($('export-musicxml'));
    expect(handlers.onExportMusicXml).toHaveBeenCalled();
  });

  it('un clic fuori chiude il menu', () => {
    const menu = $('file-menu');
    menu.open = true;
    click(document.body);
    expect(menu.open).toBe(false);
  });
});

describe('Impostazioni', () => {
  it('le opzioni usate di rado sono nella finestra, collegate al documento, con nomi chiari', () => {
    const dialog = $('settings-dialog');
    for (const id of ['grid', 'legato', 'refine', 'headphones', 'accompany', 'instrument', 'note-names']) {
      expect(dialog.contains($(id)), id).toBe(true);
    }
    expect([...$('grid').options].map((o) => o.text)).toEqual(['Automatica', 'Semiminime (1/4)', 'Crome (1/8)', 'Semicrome (1/16)']);
    $('grid').value = '0.5';
    $('grid').dispatchEvent(new Event('change'));
    expect(doc.settings.grid).toBe(0.5);
  });

  it('i pulsanti aprono e chiudono le finestre', () => {
    const dialog = $('settings-dialog');
    dialog.showModal ??= function () {
      this.open = true;
    };
    dialog.close ??= function () {
      this.open = false;
    };
    click($('open-settings'));
    expect(dialog.open).toBe(true);
    click(dialog.querySelector('[data-close]'));
    expect(dialog.open).toBe(false);
  });
});

describe('Voci', () => {
  it('una scheda per voce; Aggiungi voce; Muto con aria-pressed', () => {
    click($('add-voice'));
    expect($('voice-list').querySelectorAll('.voice-row')).toHaveLength(2);
    const second = doc.voices[1];
    const mute = $('voice-list').querySelectorAll('.voice-row')[1].querySelector('.voice-toggle');
    click(mute);
    expect(doc.voiceById(second.id).muted).toBe(true);
    const muteAfter = $('voice-list').querySelectorAll('.voice-row')[1].querySelector('.voice-toggle');
    expect(muteAfter.getAttribute('aria-pressed')).toBe('true');
  });

  it('niente menu nascosti: chiave, Svuota ed Elimina sono visibili nella scheda', () => {
    const row = $('voice-list').querySelector('.voice-row');
    expect(row.querySelector('details')).toBeNull();
    const edit = row.querySelector('.voice-edit');
    expect(edit.querySelector('label').textContent).toContain('Chiave');
    expect([...edit.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Svuota la voce', 'Elimina la voce']);
  });

  it('strumento di ogni voce in un menu accanto a Solo, con la voce originale se c’è', () => {
    const row = () => $('voice-list').querySelector('.voice-row');
    const menu = () => row().querySelector('.voice-mix > select.voice-instrument');
    expect(menu().previousElementSibling.textContent).toBe('Solo'); // subito dopo Solo
    expect(menu().selectedOptions[0].text).toBe('Synth: strumento generale');
    expect([...menu().options].map((o) => o.text)).not.toContain('Voce originale');

    const take = doc.addAudio({ sampleRate: 48000, samples: new Int16Array(48000) });
    doc.replaceRange(0, 0, [{ midi: 60, beats: 1, src: { take, start: 0.1, end: 0.5 } }]);
    expect(menu().selectedOptions[0].text).toBe('Voce originale'); // default quando c'è l'audio

    menu().value = 'organ';
    menu().dispatchEvent(new Event('change'));
    expect(doc.voice).toMatchObject({ source: 'synth', instrument: 'organ' });
    expect(menu().selectedOptions[0].text).toBe('Synth: Organo');
    menu().value = '__original';
    menu().dispatchEvent(new Event('change'));
    expect(doc.voice.source).toBe('original');
  });

  it('la chiave si cambia direttamente dalla scheda', () => {
    const clef = $('voice-list').querySelector('.voice-edit select');
    clef.value = 'bass';
    clef.dispatchEvent(new Event('change'));
    expect(doc.voice.clef).toBe('bass');
  });
});

describe('barra di modifica', () => {
  it('senza selezione: invito a cliccare una nota e comandi spenti; con selezione: nota descritta e comandi attivi', () => {
    const up = document.querySelector('[data-action="transpose"][data-value="1"]');
    expect($('selection-info').textContent).toMatch(/Clicca una nota/);
    expect(up.disabled).toBe(true);
    const id = doc.append({ midi: 64, beats: 1 });
    editor.select(id);
    expect($('selection-info').textContent).toBe('Nota selezionata: E4 · 1 ♩');
    expect(up.disabled).toBe(false);
    click(up);
    expect(doc.get(id).midi).toBe(65);
  });

  it('ogni pulsante della barra ha un nome distinto (le icone non contano)', () => {
    const names = [...document.querySelectorAll('#edit-toolbar button')].map((b) => b.textContent.trim());
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('Voci: svuota e audio perso', () => {
  const row = () => $('voice-list').querySelector('.voice-row');
  const button = (text) => [...row().querySelectorAll('.voice-edit button')].find((b) => b.textContent === text);

  it('"Svuota la voce" cancella le note, la voce resta; spento se la voce è vuota', () => {
    expect(button('Svuota la voce').disabled).toBe(true);
    doc.append({ midi: 60, beats: 1 });
    click(button('Svuota la voce'));
    expect(doc.voices).toHaveLength(1);
    expect(doc.voice.notes).toHaveLength(0);
    expect(button('Svuota la voce').disabled).toBe(true);
  });

  it('una voce con audio originale perso lo dice (e il menu non offre la voce originale)', () => {
    expect(row().querySelector('.voice-warning')).toBeNull();
    doc.replaceRange(0, 0, [{ midi: 60, beats: 1, src: { take: 'lost-1', start: 0, end: 0.5 } }]);
    expect(row().querySelector('.voice-warning').textContent).toMatch(/^Audio originale non più disponibile/);
    expect([...row().querySelector('.voice-instrument').options].map((o) => o.text)).not.toContain('Voce originale');
  });
});

describe('Loop ed esportazione audio', () => {
  it('Loop accanto ad Ascolta: pulsante a due stati, il nome resta "Loop"', () => {
    const loopBtn = $('loop-toggle');
    expect($('play-score').nextElementSibling).toBe(loopBtn);
    expect(loopBtn.getAttribute('aria-pressed')).toBe('false');
    click(loopBtn);
    expect(loopBtn.getAttribute('aria-pressed')).toBe('true');
    expect(loopBtn.textContent).toBe('Loop');
    click(loopBtn);
    expect(loopBtn.getAttribute('aria-pressed')).toBe('false');
  });

  it('"Esporta audio (WAV)" nel menu File; spento durante il rendering', async () => {
    let finish;
    handlers.onExportAudio = vi.fn(() => new Promise((r) => (finish = r)));
    document.body.innerHTML = PAGE; // nuovi controlli con il gestore aggiornato
    createDocumentControls(doc, handlers);
    const button = $('export-audio');
    expect($('file-menu').contains(button)).toBe(true);
    click(button);
    expect(handlers.onExportAudio).toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(button.disabled).toBe(false);
  });
});

describe('Voci: volume', () => {
  it('cursore con etichetta visibile e valore in dB; trascinando: anteprima senza ridisegno; al rilascio: salvato', () => {
    document.body.innerHTML = PAGE;
    const preview = vi.fn();
    createVoicePanel(doc, { list: $('voice-list'), addButton: $('add-voice'), instruments: INSTRUMENTS, onStatus: () => {}, onVolumePreview: preview });
    const row = () => $('voice-list').querySelector('.voice-volume');
    expect(row().textContent).toContain('Volume');
    expect(row().querySelector('output').textContent).toBe('0 dB');
    const slider = row().querySelector('input[type="range"]');

    slider.value = '-6';
    slider.dispatchEvent(new Event('input'));
    expect(preview).toHaveBeenLastCalledWith(doc.voice.id, -6);
    expect(row().querySelector('input')).toBe(slider); // nessun ridisegno durante il trascinamento
    expect(slider.getAttribute('aria-valuetext')).toBe('−6 dB');
    expect(doc.voice.volumeDb).toBe(0); // non ancora salvato

    slider.dispatchEvent(new Event('change'));
    expect(doc.voice.volumeDb).toBe(-6);
    expect(row().querySelector('output').textContent).toBe('−6 dB');
  });
});

describe('disposizione', () => {
  it('Importa audio è accanto a Registra (alternative), prima di Ascolta e Loop', () => {
    const order = [...document.querySelectorAll('.topbar .actions button')].map((b) => b.id).filter(Boolean);
    expect(order.slice(0, 4)).toEqual(['mic-toggle', 'load-audio', 'play-score', 'loop-toggle']);
    expect($('mic-toggle').parentElement).toBe($('load-audio').parentElement);
  });

  it('Muto, Solo e strumento nella stessa riga, che non va a capo', () => {
    const mix = $('voice-list').querySelector('.voice-mix');
    expect([...mix.children].map((c) => c.textContent || c.tagName)).toEqual(['Muto', 'Solo', expect.stringContaining('Synth')]);
    const css = readFileSync(join(process.cwd(), 'src', 'styles', 'main.css'), 'utf8');
    expect(css).toMatch(/\.voice-mix \{[^}]*flex-wrap: nowrap/);
  });
});

describe('tuner', () => {
  it('niente più etichette "Intonazione stimata" e "Synth muto"', () => {
    expect(document.body.textContent).not.toMatch(/Intonazione stimata|Synth muto/);
    expect($('tuning-info')).toBeNull();
    expect($('output-badge')).toBeNull();
  });

  it('registrando: fonte "Microfono", livello visibile; nota in italiano, barra e giudizio scritto', () => {
    ui.setState('running');
    expect($('tuner-source').textContent).toMatch(/^Microfono/);
    expect($('mic-level').hidden).toBe(false);
    ui.updateFrame({ db: -30, gateOpen: true, gateOpenDb: -50, timeMs: 0, note: { exactMidi: 69.3, hz: 447.7 } });
    expect($('note-name').textContent).toBe('La4');
    expect($('note-sci').textContent).toBe('A4');
    expect($('tuner-verdict').textContent).toBe('Crescente (+30 cent)');
    expect($('tuner-verdict').classList.contains('is-off')).toBe(true);
    expect($('tuner-marker').style.left).toBe('80%');
    expect($('note-hz').textContent).toBe('447.7 Hz');
  });

  it('ascoltando: fonte della voce, senza il livello del microfono; la nota della partitura accanto', () => {
    ui.setTuner({ source: 'Ascolto: Soprano, voce originale (intonazione reale)' });
    expect($('tuner-panel').hidden).toBe(false);
    expect($('mic-level').hidden).toBe(true);
    ui.updatePitch({ exactMidi: 64.05, hz: 331, timeMs: 0 });
    ui.setWritten('Nella partitura: Mi4');
    expect($('tuner-verdict').textContent).toBe('Intonato');
    expect($('tuner-written').textContent).toBe('Nella partitura: Mi4');
    ui.setTuner(null);
    expect($('tuner-panel').hidden).toBe(true);
  });

  it('l’avviso sugli altoparlanti compare solo quando serve', () => {
    ui.setFeedback({ liveSynthEnabled: false, warning: false, reason: 'Mentre canti il synth resta muto…' });
    expect($('feedback-reason').hidden).toBe(true);
    ui.setFeedback({ liveSynthEnabled: true, warning: true, reason: 'Attenzione: altoparlanti' });
    expect($('feedback-reason').hidden).toBe(false);
    expect($('feedback-reason').textContent).toBe('Attenzione: altoparlanti');
  });
});
