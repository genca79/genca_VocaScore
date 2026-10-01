import { GRID_OPTIONS, MAX_BPM, MIN_BPM } from '../music/scoreDocument.js';
import { TIME_SIGNATURES } from '../music/notation.js';

/**
 * Controlli del documento: titolo, BPM, tempo (indicazione di misura), chiave, quantizzazione,
 * metronomo, nomi delle note, e i comandi Nuovo / Apri / Salva / MusicXML / PDF.
 *
 * I campi si aggiornano dal documento a ogni modifica (anche dopo annulla o apri).
 * Il titolo si conferma all'uscita dal campo o con Invio: così ogni lettera digitata
 * non diventa un passo di "annulla".
 */
export function createDocumentControls(doc, { onNew, onOpen, onSave, onExportMusicXml, onExportPdf }) {
  const $ = (id) => document.getElementById(id);
  const title = $('score-title');
  const bpm = $('bpm');
  const timeSignature = $('time-signature');
  const clef = $('clef');
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
  grid.addEventListener('change', () => doc.setSettings({ grid: Number(grid.value) }));
  metronome.addEventListener('change', () => doc.setSettings({ metronome: metronome.checked }));
  refine.addEventListener('change', () => doc.setSettings({ refine: refine.checked }));
  legato.addEventListener('change', () => doc.setSettings({ legato: legato.checked }));

  title.addEventListener('change', () => doc.setSettings({ title: title.value }));
  title.addEventListener('keydown', (e) => e.key === 'Enter' && title.blur());
  bpm.addEventListener('change', () => doc.setSettings({ bpm: Number(bpm.value) }));
  timeSignature.addEventListener('change', () => doc.setSettings({ timeSignature: timeSignature.value }));
  clef.addEventListener('change', () => doc.setSettings({ clef: clef.value }));
  names.addEventListener('change', () => doc.setSettings({ showNoteNames: names.checked }));

  $('new-score').addEventListener('click', onNew);
  $('save-score').addEventListener('click', onSave);
  $('export-musicxml').addEventListener('click', onExportMusicXml);
  const pdfButton = $('export-pdf');
  pdfButton.addEventListener('click', async () => {
    // la prima esportazione carica jsPDF: si evita il doppio clic durante l'attesa
    pdfButton.disabled = true;
    try {
      await onExportPdf();
    } finally {
      pdfButton.disabled = false;
    }
  });
  $('open-score').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const [file] = fileInput.files;
    fileInput.value = ''; // permette di riaprire lo stesso file
    if (file) onOpen(file);
  });

  const sync = () => {
    const s = doc.settings;
    if (document.activeElement !== title) title.value = s.title;
    bpm.value = String(s.bpm);
    timeSignature.value = s.timeSignature;
    clef.value = s.clef;
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
