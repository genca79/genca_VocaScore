import { GRID_OPTIONS, MAX_BPM, MIN_BPM } from '../music/scoreDocument.js';
import { TIME_SIGNATURES } from '../music/notation.js';
import { AUDIO_FILE_ACCEPT } from '../music/audioFile.js';

/**
 * Controlli del documento: titolo, BPM, tempo (indicazione di misura), quantizzazione, metronomo,
 * nomi delle note, e i comandi Nuovo / Apri / Importa audio / Salva / MusicXML / PDF.
 * (La chiave è per voce: vedi voicePanel.js.)
 *
 * I campi si aggiornano dal documento a ogni modifica (anche dopo annulla o apri).
 * Il titolo si conferma all'uscita dal campo o con Invio: così ogni lettera digitata
 * non diventa un passo di "annulla".
 */
export function createDocumentControls(doc, { onNew, onOpen, onLoadAudio, onSave, onExportMusicXml, onExportPdf, onExportAudio }) {
  const $ = (id) => document.getElementById(id);
  const title = $('score-title');
  const bpm = $('bpm');
  const timeSignature = $('time-signature');
  const names = $('note-names');
  const grid = $('grid');
  const metronome = $('metronome');
  const refine = $('refine');
  const legato = $('legato');
  const fileInput = $('open-file');
  const status = $('score-status');

  bpm.min = String(MIN_BPM);
  bpm.max = String(MAX_BPM);
  for (const ts of TIME_SIGNATURES) timeSignature.add(new Option(ts, ts));
  for (const g of GRID_OPTIONS) grid.add(new Option(g.label, String(g.value)));
  grid.addEventListener('change', () => doc.setSettings({ grid: grid.value === 'auto' ? 'auto' : Number(grid.value) }));
  metronome.addEventListener('change', () => doc.setSettings({ metronome: metronome.checked }));
  refine.addEventListener('change', () => doc.setSettings({ refine: refine.checked }));
  legato.addEventListener('change', () => doc.setSettings({ legato: legato.checked }));

  title.addEventListener('change', () => doc.setSettings({ title: title.value }));
  title.addEventListener('keydown', (e) => e.key === 'Enter' && title.blur());
  bpm.addEventListener('change', () => doc.setSettings({ bpm: Number(bpm.value) }));
  timeSignature.addEventListener('change', () => doc.setSettings({ timeSignature: timeSignature.value }));
  names.addEventListener('change', () => doc.setSettings({ showNoteNames: names.checked }));

  // Menu File: si chiude dopo ogni scelta, con Esc e cliccando fuori.
  const fileMenu = $('file-menu');
  const closeMenu = () => (fileMenu.open = false);
  fileMenu.addEventListener('click', (e) => e.target.closest('.menu-list button') && closeMenu());
  document.addEventListener('click', (e) => fileMenu.open && !fileMenu.contains(e.target) && closeMenu());
  fileMenu.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !fileMenu.open) return;
    closeMenu();
    fileMenu.querySelector('summary').focus();
  });

  // Finestre Impostazioni e Aiuto (dialog nativo: Esc chiude, il focus torna al pulsante)
  for (const [buttonId, dialogId] of [
    ['open-settings', 'settings-dialog'],
    ['open-help', 'help-dialog'],
  ]) {
    const dialog = $(dialogId);
    $(buttonId).addEventListener('click', () => dialog.showModal());
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  }

  $('new-score').addEventListener('click', onNew);
  $('save-score').addEventListener('click', () => onSave({ includeAudio: false }));
  $('save-score-audio').addEventListener('click', () => onSave({ includeAudio: true }));
  $('export-musicxml').addEventListener('click', onExportMusicXml);
  // Esportazioni che richiedono qualche secondo (PDF: carica jsPDF; audio: rendering del mix):
  // il pulsante resta spento durante l'attesa, niente doppio clic.
  for (const [id, run] of [
    ['export-pdf', onExportPdf],
    ['export-audio', onExportAudio],
  ]) {
    const button = $(id);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await run();
      } finally {
        button.disabled = false;
      }
    });
  }
  $('open-score').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const [file] = fileInput.files;
    fileInput.value = ''; // permette di riaprire lo stesso file
    if (file) onOpen(file);
  });

  const audioButton = $('load-audio');
  const audioInput = $('load-audio-file');
  audioInput.accept = AUDIO_FILE_ACCEPT;
  audioButton.addEventListener('click', () => audioInput.click());
  audioInput.addEventListener('change', async () => {
    const files = [...audioInput.files];
    audioInput.value = ''; // permette di ricaricare gli stessi file
    if (files.length === 0) return;
    // decodifica e trascrizione richiedono qualche secondo: niente secondo caricamento nel frattempo
    audioButton.disabled = true;
    try {
      await onLoadAudio(files);
    } finally {
      audioButton.disabled = false;
    }
  });

  const sync = () => {
    const s = doc.settings;
    if (document.activeElement !== title) title.value = s.title;
    bpm.value = String(s.bpm);
    timeSignature.value = s.timeSignature;
    names.checked = s.showNoteNames;
    grid.value = String(s.grid);
    metronome.checked = s.metronome;
    refine.checked = s.refine;
    legato.checked = s.legato;
  };
  doc.addEventListener('change', sync);
  sync();

  let statusTimer = null;
  return {
    /**
     * Durante la registrazione BPM, tempo, griglia e metronomo sono bloccati:
     * la sessione in corso usa i valori con cui è iniziata.
     */
    setRecording(recording) {
      for (const el of [bpm, timeSignature, grid, metronome, refine, legato]) el.disabled = recording;
    },

    /** Messaggio temporaneo sotto la barra (es. "Spartito salvato"). */
    showStatus(message, { error = false, sticky = false, durationMs } = {}) {
      status.textContent = message;
      status.classList.toggle('is-error', error);
      clearTimeout(statusTimer);
      if (!sticky) statusTimer = setTimeout(() => (status.textContent = ''), durationMs ?? (error ? 8000 : 4000));
    },
  };
}
