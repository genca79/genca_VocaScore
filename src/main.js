/**
 * Orchestratore: crea i moduli e li collega tramite eventi. Non contiene logica di dominio.
 *
 *   Microfono → AnalyserNode → [rAF] → NoiseGate → MPM → hzToNote → NoteStabilizer
 *                                                                   ├→ SynthEngine (voce live, filtrata da FeedbackGuard)
 *                                                                   └→ Recorder → ScoreDocument ─┬→ ScoreRenderer (+ ScoreEditor)
 *                                                                                                ├→ SynthEngine (riascolto)
 *                                                                                                ├→ salvataggio / bozza
 *                                                                                                └→ ScorePrinter (PDF)
 */
import './styles/main.css';
import { CONFIG } from './config.js';
import { bus } from './core/eventBus.js';
import { initAudioContext } from './audio/audioContext.js';
import { AudioInput } from './audio/audioInput.js';
import { NoiseGate } from './audio/noiseGate.js';
import { PitchAnalyzer } from './audio/pitchDetector.js';
import { FeedbackGuard } from './audio/feedbackGuard.js';
import { hzToNote } from './music/noteUtils.js';
import { NoteStabilizer } from './music/noteStabilizer.js';
import { ScoreDocument } from './music/scoreDocument.js';
import { Recorder } from './music/recorder.js';
import { timeSignatureInfo } from './music/notation.js';
import { SynthEngine } from './output/synth.js';
import { Metronome } from './output/metronome.js';
import { INSTRUMENTS } from './output/instruments.js';
import { ScoreRenderer } from './output/scoreRenderer.js';
import { exportPdf } from './output/pdfExporter.js';
import { toMusicXML } from './music/musicxml.js';
import { loadDraft, readJsonFile, saveDraft, saveFile } from './storage/fileStorage.js';
import { createControls } from './ui/controls.js';
import { createDocumentControls } from './ui/documentControls.js';
import { ScoreEditor } from './ui/scoreEditor.js';

const SOUND_STORAGE_KEY = 'vocascore.sound';

// ── Modello e moduli ───────────────────────────────────────────────────────
const doc = new ScoreDocument();
const recorder = new Recorder(doc, CONFIG.score);
const stabilizer = new NoteStabilizer(CONFIG.stabilizer);
const gate = new NoiseGate(CONFIG.gate);
const guard = new FeedbackGuard((state) => bus.emit('feedback', state));
const sound = loadSoundSettings();

/** @type {SynthEngine|null} creato al primo gesto audio: Tone richiede un AudioContext sbloccato */
let engine = null;
/** @type {Metronome|null} */
let metronome = null;
/** @type {AudioInput|null} */
let input = null;
/** @type {PitchAnalyzer|null} */
let analyzer = null;
let state = 'idle';

// Stato della vista dello spartito
let pending = null; // nota in corso: { midi, startMs }
let playingId = null;
let liveTimer = null;
let fontsReady = false; // prima del font musicale VexFlow misurerebbe i glifi in modo errato

const score = new ScoreRenderer(document.getElementById('score'), {
  interactive: true,
  onSelect: (id) => editor.select(id),
});
const editor = new ScoreEditor(doc, {
  toolbar: document.getElementById('edit-toolbar'),
  info: document.getElementById('selection-info'),
  onSelectionChange: renderScore,
});

const ui = createControls({
  onToggle: () => (state === 'running' ? stop() : start()),
  onHeadphonesChange: (value) => guard.setLiveSynth(value),
  onPlayToggle: togglePlayback,
  onPreview: previewSound,
  onSoundChange: applySoundChange,
  instruments: INSTRUMENTS,
  sound,
  gateOpenDb: gate.openDb,
});

const docUi = createDocumentControls(doc, {
  onNew: () => {
    engine?.stopPlayback();
    doc.clear();
    docUi.showStatus('Nuovo spartito. Ctrl+Z per tornare al precedente.');
  },
  onOpen: openScore,
  onSave: () => exportFile('vocascore', () => JSON.stringify(doc.toJSON(), null, 2), 'Spartito salvato.'),
  onExportMusicXml: () => exportFile('musicxml', () => toMusicXML(doc), 'MusicXML esportato.'),
  onExportPdf: () => exportFile('pdf', () => exportPdf(doc), 'PDF creato.'),
});

function renderScore() {
  if (!fontsReady) return;
  const view = { selectedId: editor.selectedId, playingId, followEnd: state === 'running' };
  if (pending) view.pending = { midi: pending.midi, beats: recorder.liveBeats(performance.now()) };
  score.render(doc, view);
}

// ── Collegamenti tra moduli ────────────────────────────────────────────────
bus.on('note:on', (note) => {
  engine?.liveNoteOn(note.midi);
  recorder.noteStarted(note.startMs);
  pending = { midi: note.midi, startMs: note.startMs };
  // la nota in corso si allunga in tempo reale sul pentagramma
  clearInterval(liveTimer);
  liveTimer = setInterval(renderScore, CONFIG.score.liveRedrawMs);
  renderScore();
});

bus.on('note:off', (note) => {
  // In una transizione legata il synth non rilascia: il noteOn successivo farà glide.
  if (!note.transition) engine?.liveNoteOff();
  pending = null;
  clearInterval(liveTimer);
  recorder.noteEnded(note); // → doc 'change' → renderScore
});

bus.on('feedback', (feedbackState) => {
  engine?.setLiveMuted(!feedbackState.outputAllowed);
  syncEchoCancellation(feedbackState.disableEchoCancellation);
  ui.setFeedback(feedbackState);
});

let autosaveTimer = null;
doc.addEventListener('change', () => {
  renderScore();
  ui.setCanPlay(!doc.isEmpty);
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => saveDraft(doc.toJSON()), CONFIG.score.autosaveMs);
});

/**
 * In cuffia l'AEC non serve e anzi attenua la voce quando il synth suona la stessa nota
 * (vedi AudioInput.setEchoCancellation). Altrimenti resta attiva come difesa anti-Larsen.
 * Le richieste sono messe in coda: più eventi 'feedback' ravvicinati non si sovrappongono.
 */
let aecQueue = Promise.resolve();
function syncEchoCancellation(disable) {
  aecQueue = aecQueue
    .then(() => input?.setEchoCancellation(!disable))
    .catch((err) => console.warn('Impossibile cambiare la cancellazione dell’eco:', err));
}

function emitNoteEvents(events) {
  for (const ev of events) bus.emit(ev.type === 'noteOn' ? 'note:on' : 'note:off', ev);
}

function setState(next) {
  state = next;
  ui.setState(next);
}

/** Callback del loop di analisi, ~60 volte al secondo. */
function onFrame(frame) {
  const note = frame.hz !== null ? hzToNote(frame.hz) : null;
  ui.updateFrame({ ...frame, note });
  // gateOpen distingue il silenzio vero (chiude la nota presto) da un frame incerto
  // a voce presente, come respiro o consonante (la nota resta viva più a lungo).
  emitNoteEvents(stabilizer.process(note ? note.exactMidi : null, frame.timeMs, frame.gateOpen));
}

/** Sblocca l'audio (va chiamata in un gesto dell'utente) e crea il motore sonoro alla prima occorrenza. */
async function ensureAudio() {
  const ctx = await initAudioContext();
  if (!engine) {
    engine = new SynthEngine({ ...CONFIG.synth, ...sound });
    engine.onPlaybackChange = (playing) => ui.setPlaying(playing);
    engine.onPlaybackNote = (id) => {
      playingId = id;
      renderScore();
    };
    // La voce live nasce MUTA: si attiva solo quando il FeedbackGuard conferma le cuffie.
    engine.setLiveMuted(!guard.state.outputAllowed);
    metronome = new Metronome();
  }
  return ctx;
}

/**
 * Avvia la sessione di registrazione: con il metronomo, una battuta di attacco e poi il primo
 * movimento diventa l'inizio della griglia; senza, la griglia parte dalla prima nota cantata.
 */
function beginRecordingSession() {
  const { bpm, timeSignature, metronome: useMetronome } = doc.settings;
  if (!useMetronome) {
    recorder.beginSession(null);
    return;
  }
  const beatsPerMeasure = Math.round(timeSignatureInfo(timeSignature).measureBeats);
  const t0 = metronome.start({
    bpm,
    beatsPerMeasure,
    countInBeats: beatsPerMeasure,
    onBeat: (info) => ui.setBeat(info, beatsPerMeasure),
  });
  recorder.beginSession(t0);
}

// ── Ciclo di vita del microfono ────────────────────────────────────────────
async function start() {
  if (state !== 'idle') return;
  setState('starting');
  ui.clearError();
  try {
    // 1. Sblocco dell'audio (deve avvenire nel gesto dell'utente, cioè questo click).
    const ctx = await ensureAudio();
    // Il riascolto si ferma: dagli altoparlanti finirebbe nel microfono e verrebbe trascritto.
    engine.stopPlayback();

    // 2. Microfono.
    input = new AudioInput(ctx, CONFIG.audio);
    input.onEnded = (err) => {
      stop();
      ui.showError(err.message);
    };
    const analyser = await input.start();

    // 3. Rilevazione delle cuffie: solo ora i nomi dei dispositivi sono leggibili (dopo il permesso).
    await guard.init(); // emette 'feedback' → imposta mute della voce live e AEC

    // 4. Loop di analisi. Le nuove note vengono aggiunte in coda allo spartito.
    beginRecordingSession();
    docUi.setRecording(true);
    analyzer = new PitchAnalyzer(analyser, ctx.sampleRate, {
      gate,
      pitch: CONFIG.pitch,
      minClarity: CONFIG.pitch.minClarity,
      onFrame,
    });
    analyzer.start();
    setState('running');
  } catch (err) {
    console.error(err);
    input?.stop();
    input = null;
    metronome?.stop();
    recorder.endSession();
    docUi.setRecording(false);
    ui.setBeat(null);
    setState('idle');
    ui.showError(err?.message ?? String(err));
  }
}

function stop() {
  if (state !== 'running') return;
  analyzer?.stop();
  analyzer = null;
  emitNoteEvents(stabilizer.flush(performance.now())); // prima di endSession: la nota aperta va scritta
  recorder.endSession();
  metronome?.stop();
  ui.setBeat(null);
  docUi.setRecording(false);
  engine?.liveNoteOff();
  input?.stop();
  input = null;
  setState('idle');
  ui.updateFrame(null);
}

// ── Riascolto e suono ──────────────────────────────────────────────────────

/**
 * Riascolta lo spartito (dalla nota selezionata, se c'è) con lo strumento scelto e ai BPM correnti.
 * Il microfono viene fermato prima: il riascolto può uscire dagli altoparlanti (senza microfono
 * non c'è rischio di Larsen) e non deve essere ri-trascritto.
 */
async function togglePlayback() {
  if (engine?.isPlaying) {
    engine.stopPlayback();
    return;
  }
  if (doc.isEmpty) return;
  stop();
  await ensureAudio();
  engine.play(doc.playbackEvents(editor.selectedId));
}

/** Breve arpeggio (Do–Mi–Sol–Do) per sentire lo strumento senza dover cantare. */
async function previewSound() {
  stop();
  await ensureAudio();
  const step = 0.32;
  engine.play([60, 64, 67, 72].map((midi, i) => ({ time: i * step, duration: i === 3 ? step * 3 : step, midi })));
}

function applySoundChange(change) {
  Object.assign(sound, change);
  saveSoundSettings();
  if (!engine) return; // verranno applicate alla creazione del motore
  if ('instrument' in change) engine.setInstrument(change.instrument);
  if ('octave' in change) engine.setOctave(change.octave);
  if ('brightness' in change) engine.setBrightness(change.brightness);
  if ('reverb' in change) engine.setReverb(change.reverb);
  if ('volumeDb' in change) engine.setVolume(change.volumeDb);
}

// ── File ───────────────────────────────────────────────────────────────────
/**
 * Genera e salva un file (spartito, MusicXML o PDF), sempre sul dispositivo dell'utente.
 * @param {'vocascore'|'musicxml'|'pdf'} type
 * @param {() => string|Blob|Promise<Blob>} produce
 */
async function exportFile(type, produce, successMessage) {
  try {
    const content = await produce();
    if (await saveFile(content, doc.settings.title, type)) docUi.showStatus(successMessage);
  } catch (err) {
    console.error(err);
    docUi.showStatus(`Esportazione non riuscita: ${err.message}`, { error: true });
  }
}

async function openScore(file) {
  try {
    engine?.stopPlayback();
    stop();
    doc.load(await readJsonFile(file));
    docUi.showStatus(`Aperto "${file.name}". Ctrl+Z per tornare allo spartito precedente.`);
  } catch (err) {
    console.error(err);
    docUi.showStatus(`Impossibile aprire il file: ${err.message}`, { error: true });
  }
}

/** Le preferenze del suono restano nel browser (localStorage): nessun dato lascia il dispositivo. */
function loadSoundSettings() {
  const defaults = {
    instrument: CONFIG.synth.instrument,
    octave: CONFIG.synth.octave,
    brightness: CONFIG.synth.brightness,
    reverb: CONFIG.synth.reverb,
    volumeDb: CONFIG.synth.volumeDb,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(SOUND_STORAGE_KEY) ?? '{}');
    const merged = { ...defaults, ...saved };
    if (!INSTRUMENTS[merged.instrument]) merged.instrument = defaults.instrument;
    return merged;
  } catch {
    return defaults; // storage non disponibile (es. navigazione privata restrittiva)
  }
}

function saveSoundSettings() {
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(sound));
  } catch {
    // ignorato: le preferenze semplicemente non verranno ricordate
  }
}

// rAF si sospende quando la scheda è nascosta: la nota resterebbe "appesa" e il microfono
// continuerebbe ad ascoltare senza che l'utente lo veda. Meglio fermare tutto.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'running') {
    stop();
    ui.showError('Microfono fermato perché la scheda è passata in background.');
  }
});

// ── Avvio della pagina ─────────────────────────────────────────────────────
ui.setState('idle');
ui.setFeedback(guard.state);

// Ripristino della bozza salvata automaticamente (se valida).
const draft = loadDraft();
if (draft) {
  try {
    doc.load(draft);
    doc.clearHistory();
  } catch (err) {
    console.warn('Bozza non valida, ignorata:', err);
  }
}
ui.setCanPlay(!doc.isEmpty);

ScoreRenderer.loadFonts()
  .then(() => {
    fontsReady = true;
    score.observeResize();
    renderScore();
  })
  .catch((err) => {
    console.error(err);
    ui.showError('Impossibile inizializzare il pentagramma.');
  });
