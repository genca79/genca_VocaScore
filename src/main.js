/**
 * Orchestratore: crea i moduli e li collega tramite eventi. Non contiene logica di dominio.
 *
 *   Microfono ─┬→ AnalyserNode → [rAF] → NoiseGate → passa-basso → MPM → hzToNote − intonazione → NoteStabilizer
 *              │                                         (istantaneo: nota rilevata, accordatore)  └→ SynthEngine (voce live)
 *              └→ SessionCapture (AudioWorklet, in memoria)
 *                   ├─ ogni 0,5 s → Web Worker (trascrizione) → LiveTranscriber → anteprima sul pentagramma
 *                   └─ allo Stop  → Web Worker (intera registrazione) → ScoreDocument.replaceRange (annullabile)
 *
 *   File audio (Importa audio) → Web Worker (stessa trascrizione) → ScoreDocument.replaceRange
 *   ScoreDocument → ScoreRenderer (+ ScoreEditor) · riascolto · bozza · MusicXML · PDF
 */
import './styles/main.css';
import * as Tone from 'tone';
import { CONFIG } from './config.js';
import { bus } from './core/eventBus.js';
import { initAudioContext } from './audio/audioContext.js';
import { AudioInput } from './audio/audioInput.js';
import { NoiseGate } from './audio/noiseGate.js';
import { PitchAnalyzer } from './audio/pitchDetector.js';
import { FeedbackGuard } from './audio/feedbackGuard.js';
import { hzToNote, midiToHz, midiToItalianName } from './music/noteUtils.js';
import { NoteStabilizer } from './music/noteStabilizer.js';
import { TuningEstimator } from './music/tuning.js';
import { transcribeInWorker } from './music/offlineClient.js';
import { SessionCapture } from './audio/sessionCapture.js';
import { MAX_VOICES, ScoreDocument } from './music/scoreDocument.js';
import { restToCompleteMeasure } from './music/recorder.js';
import { decodeAudioFile, titleFromFileName } from './music/audioFile.js';
import { writeTranscription, writeTranscriptionVoices } from './music/rhythm.js';
import { LiveTranscriber } from './music/liveTranscriber.js';
import { timeSignatureInfo } from './music/notation.js';
import { SynthEngine } from './output/synth.js';
import { Metronome } from './output/metronome.js';
import { INSTRUMENTS } from './output/instruments.js';
import { ScoreRenderer } from './output/scoreRenderer.js';
import { exportPdf } from './output/pdfExporter.js';
import { renderMix } from './output/mixExport.js';
import { encodeWav } from './storage/wav.js';
import { toMusicXML } from './music/musicxml.js';
import { loadDraft, readJsonFile, saveDraft, saveFile } from './storage/fileStorage.js';
import { fromPcm16 } from './storage/pcm.js';
import { createControls } from './ui/controls.js';
import { createDocumentControls } from './ui/documentControls.js';
import { ScoreEditor } from './ui/scoreEditor.js';
import { createVoicePanel } from './ui/voicePanel.js';
import { decorateIcons } from './icons/index.js';

// Icone decorative accanto ai testi dei pulsanti statici (data-icon in index.html).
decorateIcons(document);

const SOUND_STORAGE_KEY = 'vocascore.sound';
const ACCOMPANY_STORAGE_KEY = 'vocascore.accompany';
const LOOP_STORAGE_KEY = 'vocascore.loop';

// ── Modello e moduli ───────────────────────────────────────────────────────
const doc = new ScoreDocument();
const stabilizer = new NoteStabilizer(CONFIG.stabilizer);
const tuning = new TuningEstimator(CONFIG.tuning);
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
/** @type {SessionCapture|null} audio della sessione (in memoria): base della trascrizione */
let capture = null;
let state = 'idle';

/**
 * Registrazione in corso, nella voce `voiceId` (la voce attiva all'avvio). Le note trascritte sono
 * un'ANTEPRIMA (non entrano nello spartito né nella cronologia di annulla): vengono scritte tutte
 * insieme allo Stop, in coda alla voce.
 * @type {null | { voiceId:string, settings:object, t0Ms:number|null, live:LiveTranscriber,
 *                 preview:Array<object>, busy:boolean, timer:number }}
 */
let session = null;
/** Sessione appena fermata: la sua anteprima resta visibile finché lo spartito non è scritto. */
let finishing = null;
/** Registrando una nuova voce, si sentono le altre (solo in cuffia). Preferenza ricordata nel browser. */
let accompany = loadFlag(ACCOMPANY_STORAGE_KEY, true);
/** Ascolto in loop (preferenza ricordata nel browser). */
let loop = loadFlag(LOOP_STORAGE_KEY, false);

// Stato della vista dello spartito
const playing = new Map(); // id voce → id della nota che sta suonando nel riascolto
let fontsReady = false; // prima del font musicale VexFlow misurerebbe i glifi in modo errato

const score = new ScoreRenderer(document.getElementById('score'), {
  interactive: true,
  onSelect: (id) => editor.select(id),
});
const editor = new ScoreEditor(doc, {
  toolbars: [document.getElementById('edit-toolbar'), document.getElementById('history-toolbar')],
  info: document.getElementById('selection-info'),
  onSelectionChange: renderScore,
});

const ui = createControls({
  onToggle: () => (state === 'running' ? stop() : start()),
  onHeadphonesChange: (value) => guard.setLiveSynth(value),
  onAccompanyChange: (value) => {
    accompany = value;
    saveFlag(ACCOMPANY_STORAGE_KEY, value);
  },
  accompany,
  onPlayToggle: togglePlayback,
  onLoopChange: (value) => {
    loop = value;
    saveFlag(LOOP_STORAGE_KEY, value);
    engine?.setLoop(value); // vale anche per il riascolto in corso
  },
  loop,
  onPreview: previewSound,
  onSoundChange: applySoundChange,
  instruments: INSTRUMENTS,
  sound,
  gateOpenDb: gate.openDb,
});

const docUi = createDocumentControls(doc, {
  onNew: () => {
    engine?.stopPlayback();
    stop(); // la registrazione in corso viene scritta prima di svuotare
    doc.clear();
    docUi.showStatus('Nuova partitura. Ctrl+Z per tornare alla precedente.');
  },
  onOpen: openScore,
  onLoadAudio: loadAudio,
  onSave: ({ includeAudio }) =>
    exportFile(
      'vocascore',
      () => JSON.stringify(doc.toJSON({ includeAudio }), null, 2),
      includeAudio ? 'Partitura salvata con l’audio originale.' : 'Partitura salvata.',
    ),
  onExportMusicXml: () => exportFile('musicxml', () => toMusicXML(doc), 'MusicXML esportato.'),
  onExportPdf: () => exportFile('pdf', () => exportPdf(doc), 'PDF creato.'),
  onExportAudio: exportAudio,
});

const voicePanel = createVoicePanel(doc, {
  list: document.getElementById('voice-list'),
  addButton: document.getElementById('add-voice'),
  instruments: INSTRUMENTS,
  onStatus: (message) => docUi.showStatus(message),
  // trascinando il cursore del volume, il riascolto in corso cambia subito
  onVolumePreview: (voiceId, db) => engine?.setVoiceVolume(voiceId, db),
});

function renderScore() {
  if (!fontsReady) return;
  const view = { selectedId: editor.selectedId, playingIds: new Set(playing.values()), followEnd: state === 'running' };
  // Durante la registrazione: partitura + anteprima della sessione in coda alla sua voce
  // (in arancione, non selezionabile).
  const s = session ?? finishing;
  if (!s || s.preview.length === 0) {
    score.render(doc, view);
    return;
  }
  const voices = doc.voices.map((v) => (v.id === s.voiceId ? { ...v, notes: [...v.notes, ...s.preview] } : v));
  score.render({ settings: doc.settings, voices, activeVoiceId: doc.voice.id }, view);
}

// ── Collegamenti tra moduli ────────────────────────────────────────────────
// Lo stabilizzatore dal vivo guida solo il synth e l'intonazione mostrata: le note dello spartito
// vengono dalla trascrizione dell'audio della sessione (vedi updateLive).
bus.on('note:on', (note) => engine?.liveNoteOn(note.midi));

bus.on('note:off', (note) => {
  // In una transizione legata il synth non rilascia: il noteOn successivo farà glide.
  if (!note.transition) engine?.liveNoteOff();
  // Il centro della nota (corretto) + la correzione in uso = altezza realmente cantata.
  // (La stima serve al synth dal vivo; il tuner mostra lo scarto reale da La = 440 Hz.)
  tuning.observe(note.center + tuning.offset, note.durationMs / 1000);
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
  // la bozza ricorda quali note venivano da una registrazione (non l'audio, troppo grande per il browser)
  autosaveTimer = setTimeout(() => saveDraft(doc.toJSON({ keepSources: true })), CONFIG.score.autosaveMs);
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
  ui.updateFrame({ ...frame, note }); // l'accordatore mostra lo scarto REALE da La = 440 Hz
  // Alla trascrizione arriva l'altezza corretta per l'intonazione di chi canta.
  const corrected = note ? note.exactMidi - tuning.offset : null;
  // gateOpen distingue il silenzio vero (chiude la nota presto) da un frame incerto
  // a voce presente, come respiro o consonante; il volume serve a riconoscere le sillabe ripetute.
  emitNoteEvents(stabilizer.process(corrected, frame.timeMs, frame.gateOpen, frame.db));
}

/** Sblocca l'audio (va chiamata in un gesto dell'utente) e crea il motore sonoro alla prima occorrenza. */
async function ensureAudio() {
  const ctx = await initAudioContext();
  if (!engine) {
    engine = new SynthEngine({ ...CONFIG.synth, ...sound });
    engine.onPlaybackChange = (isPlaying) => {
      ui.setPlaying(isPlaying);
      if (!isPlaying) stopPlaybackTuner();
    };
    engine.onPlaybackNote = (id, voiceId) => {
      if (id === null && voiceId === null) playing.clear(); // fine del riascolto
      else playing.set(voiceId, id);
      if (id !== null && voiceId === tunerVoice?.id) showPlayingNote(id);
      renderScore();
    };
    // La voce live nasce MUTA: si attiva solo quando il FeedbackGuard conferma le cuffie.
    engine.setLiveMuted(!guard.state.outputAllowed);
    metronome = new Metronome();
  }
  return ctx;
}

/**
 * Avvia il metronomo: una battuta di attacco, poi il primo movimento è l'inizio della griglia.
 * @returns {{ t0Ms:number, t0Ctx:number }} primo movimento (performance.now() e orologio audio)
 */
function startMetronome() {
  const { bpm, timeSignature } = doc.settings;
  const beatsPerMeasure = Math.round(timeSignatureInfo(timeSignature).measureBeats);
  return metronome.start({
    bpm,
    beatsPerMeasure,
    countInBeats: beatsPerMeasure,
    onBeat: (info) => ui.setBeat(info, beatsPerMeasure),
  });
}

/** Ci sono note in voci diverse da `voiceId`? (registrazione di una voce che si aggiunge alle altre) */
function hasOtherVoices(voiceId) {
  return doc.voices.some((v) => v.id !== voiceId && v.notes.some((n) => n.midi !== null));
}

/**
 * Le altre voci suonano mentre si registra, partendo insieme al primo movimento del metronomo, dal
 * punto in cui la nuova voce verrà scritta. Solo se l'utente lo vuole e l'uscita NON risulta sugli
 * altoparlanti: altrimenti finirebbero nel microfono e verrebbero trascritte nella voce.
 * @returns {string|null} avviso per l'utente, se le altre voci non vengono suonate
 */
function startAccompaniment(voiceId, startBeat, t0Ctx) {
  if (!accompany) return null;
  if (guard.state.autoDetected === false) {
    return 'L’uscita audio sembra sugli altoparlanti: le altre voci non vengono suonate (finirebbero nel microfono). Usa le cuffie per sentirle.';
  }
  const { events, clips } = playbackFor(null, { fromBeat: startBeat, excludeVoiceId: voiceId });
  engine.play(events, { at: t0Ctx, clips });
  return null;
}

/**
 * Note trascritte della sessione (s dall'inizio della cattura) → note scritte, con il metronomo
 * della sessione o con il tempo rilevato. I tempi passano sull'orologio di performance.now(), lo
 * stesso del metronomo, togliendo la latenza del microfono.
 */
function writeSession(s, notes, startPerfMs, take = null) {
  return writeTranscription(notes, {
    settings: s.settings,
    t0Ms: s.t0Ms,
    originMs: startPerfMs - CONFIG.offline.inputLatencyMs,
    take,
  });
}

// ── Voce originale ─────────────────────────────────────────────────────────
/** AudioBuffer di ogni ripresa, creati alla prima riproduzione (l'audio è in PCM 16 bit nel documento). */
const takeBuffers = new Map();

function bufferFor(take) {
  if (!takeBuffers.has(take)) {
    const { sampleRate, samples } = doc.audio.get(take);
    const buffer = Tone.getContext().rawContext.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(fromPcm16(samples), 0);
    takeBuffers.set(take, buffer);
  }
  return takeBuffers.get(take);
}

/**
 * Cosa suonare: note per il synth e riprese della voce originale (vedi ScoreDocument.playbackPlan).
 * @param {string|null} fromId
 * @param {{ fromBeat?:number, excludeVoiceId?:string|null }} [options]
 */
function playbackFor(fromId, options = {}) {
  const { events, clips } = doc.playbackPlan(fromId, options);
  return { events, clips: clips.map((clip) => ({ ...clip, buffer: bufferFor(clip.take) })) };
}

/** Conserva l'audio originale di una ripresa (se c'è); restituisce l'id da collegare alle note. */
function keepAudio(original) {
  return original && original.samples.length > 0 ? doc.addAudio(original) : null;
}

/**
 * Giro di trascrizione dal vivo: l'audio catturato dall'inizio del tratto ancora provvisorio passa
 * dallo stesso algoritmo della rifinitura (Web Worker); il risultato diventa l'anteprima.
 * Un giro alla volta: se il precedente non è finito si salta (il prossimo avrà più audio).
 */
async function updateLive() {
  const s = session;
  if (!s || s.busy || !capture || capture.startPerfMs === null) return;
  const sr = capture.sampleRate;
  const fromSample = Math.round(s.live.windowStartSec * sr);
  const samples = capture.samplesFrom(fromSample);
  if (samples.length < sr * 0.3) return;
  const startPerfMs = capture.startPerfMs;
  s.busy = true;
  try {
    const result = await transcribeInWorker(samples, sr, { floorCapDb: s.live.floorCapDb });
    if (session !== s) return; // sessione fermata nel frattempo: ci pensa finishSession
    s.live.accept(result, fromSample / sr, (fromSample + samples.length) / sr);
    s.preview = toPreview(s, writeSession(s, s.live.notes, startPerfMs).written);
    renderScore();
  } catch (err) {
    console.warn('Trascrizione dal vivo non riuscita:', err);
  } finally {
    s.busy = false;
  }
}

/** Note scritte della sessione → anteprima in coda alla sua voce (da una battuta nuova). */
function toPreview(s, written) {
  const rest = restToCompleteMeasure(doc.voiceById(s.voiceId)?.notes ?? [], doc.settings.timeSignature);
  const notes = rest > 0 ? [{ midi: null, beats: rest }, ...written] : written;
  return notes.map((n, i) => ({ ...n, id: `live-${i}`, live: true }));
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

    // 4. Cattura dell'audio della sessione (solo in memoria): è la base della trascrizione.
    capture = new SessionCapture(CONFIG.offline);
    try {
      await capture.start(input);
    } catch (err) {
      console.error(err);
      throw new Error('Questo browser non permette di registrare l’audio della sessione (AudioWorklet).');
    }

    // 5. Metronomo (e altre voci), trascrizione periodica e loop di analisi istantanea (synth, nota rilevata).
    // Si registra nella voce attiva, in coda alle sue note (da una battuta nuova). Se ci sono già altre
    // voci il metronomo è sempre attivo: senza un tempo comune la nuova voce non si allineerebbe.
    const voiceId = doc.voice.id;
    const { bpm, grid, timeSignature, legato, refine } = doc.settings;
    const others = hasOtherVoices(voiceId);
    const beat0 = doc.settings.metronome || others ? startMetronome() : null;
    const notes = doc.voice.notes;
    const startBeat = notes.reduce((sum, n) => sum + n.beats, 0) + restToCompleteMeasure(notes, timeSignature);
    session = {
      voiceId,
      settings: { bpm, grid, timeSignature, legato, refine },
      t0Ms: beat0?.t0Ms ?? null,
      live: new LiveTranscriber({ contextSec: CONFIG.live.contextSec }),
      preview: [],
      busy: false,
      timer: setInterval(updateLive, CONFIG.live.updateMs),
    };
    if (others) {
      const warning = startAccompaniment(voiceId, startBeat, beat0.t0Ctx);
      const forced = doc.settings.metronome ? '' : ' Metronomo attivato per allinearla alle altre voci.';
      docUi.showStatus(`Registrazione in "${doc.voice.name}".${forced}${warning ? ` ${warning}` : ''}`, { durationMs: 8000 });
    }
    docUi.setRecording(true);
    voicePanel.setRecording(true);
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
    clearInterval(session?.timer);
    session = null;
    capture?.stop();
    capture = null;
    input?.stop();
    input = null;
    metronome?.stop();
    engine?.stopPlayback();
    docUi.setRecording(false);
    voicePanel.setRecording(false);
    ui.setBeat(null);
    setState('idle');
    ui.showError(err?.message ?? String(err));
  }
}

function stop() {
  if (state !== 'running') return;
  analyzer?.stop();
  analyzer = null;
  emitNoteEvents(stabilizer.flush(performance.now())); // chiude la nota del synth
  const s = session;
  session = null;
  clearInterval(s.timer);
  const captured = capture?.stop(); // prima di spegnere il microfono
  capture = null;
  metronome?.stop();
  engine?.stopPlayback(); // le altre voci, se suonavano
  ui.setBeat(null);
  docUi.setRecording(false);
  voicePanel.setRecording(false);
  engine?.liveNoteOff();
  input?.stop();
  input = null;
  setState('idle');
  ui.updateFrame(null);
  finishing = s; // l'anteprima resta visibile fino alla scrittura
  finishSession(s, captured);
}

// ── Fine sessione: scrittura nello spartito ────────────────────────────────

/**
 * Allo Stop le note della sessione entrano nello spartito, in coda e in un'unica modifica annullabile:
 *   - "Rifinisci allo Stop" attivo: dall'analisi dell'INTERA registrazione, esattamente come
 *     "Importa audio" su un file (intonazione e contesto di tutta la sessione);
 *   - spento: dalla trascrizione fatta durante il canto, completata con un ultimo giro.
 * Tempo (metronomo spento → rilevato) e quantizzazione (Auto → per movimento) come in writeTranscription.
 *
 * @param {NonNullable<typeof session>} s sessione appena fermata
 * @param {Promise<{ samples:Float32Array, sampleRate:number, startPerfMs:number, truncated:boolean }|null>} capturedPromise
 */
async function finishSession(s, capturedPromise) {
  try {
    const captured = await capturedPromise;
    if (!captured || captured.samples.length < captured.sampleRate * 0.3) return;
    const sr = captured.sampleRate;
    let notes = null;
    let tuningOffset = 0;
    let refined = false;

    if (s.settings.refine) {
      docUi.showStatus('Rifinitura della trascrizione…', { sticky: true });
      try {
        const result = await transcribeInWorker(captured.samples.slice(), sr, {}, (p) =>
          docUi.showStatus(`Rifinitura della trascrizione… ${Math.round(p * 100)}%`, { sticky: true }),
        );
        notes = result.notes;
        tuningOffset = result.tuningOffset;
        refined = true;
      } catch (err) {
        console.error(err);
        docUi.showStatus(`Rifinitura non riuscita (${err.message}): uso la trascrizione dal vivo.`, { error: true });
      }
    }
    if (!notes) {
      // Ultimo giro dal vivo sul tratto ancora provvisorio, poi tutto diventa definitivo.
      const fromSample = Math.round(s.live.windowStartSec * sr);
      const result = await transcribeInWorker(captured.samples.slice(fromSample), sr, { floorCapDb: s.live.floorCapDb });
      s.live.accept(result, fromSample / sr, captured.samples.length / sr, { final: true });
      notes = s.live.notes;
    }
    if (notes.length === 0) {
      docUi.showStatus('Nessuna nota riconosciuta nella registrazione.');
      return;
    }
    const label = [refined ? 'Trascrizione rifinita.' : 'Trascrizione completata.'];
    if (captured.truncated) label.push(`Trascritti solo i primi ${CONFIG.offline.maxMinutes} minuti.`);
    // La voce della sessione potrebbe essere stata eliminata nel frattempo (es. Ctrl+Z): si scrive nella voce attiva.
    const voiceId = doc.voiceById(s.voiceId) ? s.voiceId : doc.voice.id;
    const take = keepAudio(captured.original); // voce originale per il riascolto (solo in memoria)
    commitTranscription(writeSession(s, notes, captured.startPerfMs, take), { tuningOffset, label: label.join(' '), voiceId });
  } catch (err) {
    console.error(err);
    docUi.showStatus(`Trascrizione non riuscita: ${err.message}`, { error: true });
  } finally {
    if (finishing === s) finishing = null;
    renderScore();
  }
}

/**
 * Scrive una trascrizione in coda a una voce, da una battuta nuova, in un'unica modifica annullabile.
 * Se la partitura è vuota il tempo rilevato diventa il suo; `title` si usa se non ne ha uno.
 * @param {{ written:Array<{ midi:number|null, beats:number }>, detectedBpm:number|null }} transcription
 * @param {{ label:string, tuningOffset?:number, title?:string|null, voiceId?:string }} options
 */
function commitTranscription({ written, detectedBpm }, { label, tuningOffset = 0, title = null, voiceId = doc.voice.id }) {
  if (!written.some((n) => n.midi !== null)) {
    docUi.showStatus('Nessuna nota riconosciuta.');
    return;
  }
  const notes = doc.voiceById(voiceId).notes;
  const start = notes.length;
  const rest = restToCompleteMeasure(notes, doc.settings.timeSignature);
  const patch = tempoAndTitle(detectedBpm, title);
  doc.replaceRange(start, start, [...(rest > 0 ? [{ midi: null, beats: rest }] : []), ...written], patch, voiceId);
  docUi.showStatus(transcriptionMessage(label, detectedBpm, patch, tuningOffset), { durationMs: 10000 });
}

/** Partitura vuota: il tempo rilevato diventa il suo; titolo proposto se non ne ha uno. */
function tempoAndTitle(detectedBpm, title) {
  const patch = {};
  if (detectedBpm && doc.isEmpty) patch.bpm = Math.round(detectedBpm);
  if (title && !doc.settings.title) patch.title = title;
  return patch;
}

/** Messaggio di stato dopo una trascrizione: tempo rilevato e intonazione compensata. */
function transcriptionMessage(label, detectedBpm, patch, tuningOffset) {
  const parts = [label];
  if (detectedBpm) {
    const bpm = Math.round(detectedBpm);
    parts.push(patch.bpm ? `Tempo rilevato: ${bpm} BPM.` : `Tempo rilevato: ${bpm} BPM (la partitura resta a ${doc.settings.bpm}).`);
  }
  const cents = Math.round(tuningOffset * 100);
  if (cents) parts.push(`Intonazione compensata: ${cents > 0 ? '+' : '−'}${Math.abs(cents)} cent.`);
  parts.push('Ctrl+Z per annullare.');
  return parts.join(' ');
}

// ── Riascolto e suono ──────────────────────────────────────────────────────

/**
 * Riascolta la partitura in polifonia (dalla nota selezionata, se c'è): tutte le voci udibili insieme,
 * ognuna col suo strumento, ai BPM correnti. Il microfono viene fermato prima: il riascolto può uscire
 * dagli altoparlanti (senza microfono non c'è rischio di Larsen) e non deve essere ri-trascritto.
 */
async function togglePlayback() {
  if (engine?.isPlaying && state !== 'running') {
    engine.stopPlayback();
    return;
  }
  if (doc.isEmpty) return;
  stop();
  await ensureAudio();
  const { events, clips } = playbackFor(editor.selectedId);
  // In loop il giro dura fino alla fine della battuta dell'ultima nota (vedi ScoreDocument.loopSeconds).
  engine.play(events, { clips, loop, loopEnd: doc.loopSeconds(editor.selectedId) });
  startPlaybackTuner();
}

// ── Tuner durante l'ascolto ────────────────────────────────────────────────
/** Voce seguita dal tuner nell'ascolto in corso: { id, original } (null se nessuna). */
let tunerVoice = null;
/** @type {PitchAnalyzer|null} analisi dell'audio della voce originale seguita */
let playbackAnalyzer = null;

/**
 * Il tuner segue la voce attiva (o, se non si sente, la prima voce udibile con note):
 *   - voce originale: si analizza in tempo reale il SUO audio (non il mix), come il microfono;
 *   - synth: si mostra la nota suonata, che è sempre intonata.
 */
function startPlaybackTuner() {
  const audible = doc.audibleVoices.filter((v) => v.notes.some((n) => n.midi !== null));
  const voice = audible.find((v) => v.id === doc.voice.id) ?? audible[0];
  if (!voice) return;
  const analyser = engine.monitorVoice(voice.id);
  tunerVoice = { id: voice.id, original: Boolean(analyser) };
  ui.setTuner({
    source: analyser
      ? `Ascolto: ${voice.name}, voce originale (intonazione reale)`
      : `Ascolto: ${voice.name}, synth (le note del synth sono sempre intonate)`,
  });
  if (!analyser) return;
  playbackAnalyzer = new PitchAnalyzer(analyser, analyser.context.sampleRate, {
    gate: new NoiseGate(CONFIG.gate),
    pitch: CONFIG.pitch,
    minClarity: CONFIG.pitch.minClarity,
    onFrame: ({ hz, timeMs }) => {
      const note = hz !== null ? hzToNote(hz) : null;
      ui.updatePitch({ exactMidi: note?.exactMidi ?? null, hz, timeMs });
    },
  });
  playbackAnalyzer.start();
}

/** Nota della partitura che sta suonando nella voce seguita. */
function showPlayingNote(id) {
  const note = doc.get(id);
  if (!note || note.midi === null) return;
  if (tunerVoice.original) {
    ui.setWritten(`Nella partitura: ${midiToItalianName(note.midi)}`);
  } else {
    ui.updatePitch({ exactMidi: note.midi, hz: midiToHz(note.midi), timeMs: performance.now() });
  }
}

function stopPlaybackTuner() {
  playbackAnalyzer?.stop();
  playbackAnalyzer = null;
  if (!tunerVoice) return;
  tunerVoice = null;
  if (state !== 'running') ui.setTuner(null); // registrando, il tuner resta sul microfono
}

/**
 * Esporta il mix in WAV, come lo si sente con Ascolta dall'inizio: voci originali e synth, Muto e Solo,
 * strumenti ed effetti. Il rendering è "offline": più veloce del tempo reale, senza suonare nulla.
 */
async function exportAudio() {
  if (doc.isEmpty) {
    docUi.showStatus('La partitura è vuota: non c’è niente da esportare.');
    return;
  }
  docUi.showStatus('Creazione dell’audio del mix…', { sticky: true });
  await exportFile(
    'wav',
    async () => {
      const { events, clips } = playbackFor(null);
      const mix = await renderMix({ events, clips, sound: { ...CONFIG.synth, ...sound } });
      return new Blob([encodeWav(mix)], { type: 'audio/wav' });
    },
    'Audio del mix esportato (WAV).',
  );
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
    docUi.showStatus(`Aperto "${file.name}". Ctrl+Z per tornare alla partitura precedente.`);
  } catch (err) {
    console.error(err);
    docUi.showStatus(`Impossibile aprire il file: ${err.message}`, { error: true });
  }
}

/**
 * "Importa audio": trascrive uno o più file audio scelti dall'utente (vedi music/audioFile.js),
 * come registrazioni a metronomo spento (tempo rilevato dagli attacchi). Un'unica modifica annullabile.
 *   - un file: le note si aggiungono in coda alla voce attiva, da una battuta nuova;
 *   - più file: una voce per file (col nome del file, poi rinominabile), tutte dalla battuta 1. I file
 *     partono insieme (stessa esecuzione): tempo rilevato su tutte le voci, zero comune.
 * @param {File[]} files
 */
async function loadAudio(files) {
  engine?.stopPlayback();
  stop();
  const free = MAX_VOICES - doc.voices.length + (doc.voice.notes.length === 0 ? 1 : 0);
  if (files.length > 1 && files.length > free) {
    docUi.showStatus(`Troppi file: la partitura può avere al massimo ${MAX_VOICES} voci (posti liberi: ${free}).`, { error: true });
    return;
  }
  let current = '';
  try {
    const revision = doc.revision;
    const results = [];
    const originals = []; // voce originale di ogni file (48 kHz), conservata solo se la trascrizione viene scritta
    for (const [i, file] of files.entries()) {
      current = `"${file.name}"`;
      const step = files.length > 1 ? `File ${i + 1} di ${files.length}: ` : '';
      docUi.showStatus(`${step}lettura di ${current}…`, { sticky: true });
      const audio = await decodeAudioFile(file, { maxMinutes: CONFIG.offline.maxMinutes });
      originals.push(audio.original);
      results.push(
        await transcribeInWorker(audio.samples, audio.sampleRate, {}, (p) =>
          docUi.showStatus(`${step}trascrizione di ${current}… ${Math.round(p * 100)}%`, { sticky: true }),
        ),
      );
    }
    current = '';
    const empty = files.filter((_, i) => results[i].notes.length === 0).map((f) => `"${f.name}"`);
    if (empty.length === files.length) {
      docUi.showStatus(`Nessuna nota riconosciuta in ${empty.join(', ')}.`, { error: true });
      return;
    }
    if (doc.revision !== revision) {
      docUi.showStatus('La partitura è stata modificata nel frattempo: trascrizione annullata.');
      return;
    }

    const takes = originals.map((original, i) => (results[i].notes.length > 0 ? keepAudio(original) : null));
    if (files.length === 1) {
      const transcription = writeTranscription(results[0].notes, { settings: doc.settings, take: takes[0] });
      const count = transcription.written.filter((n) => n.midi !== null).length;
      commitTranscription(transcription, {
        label: `Trascritto "${files[0].name}": ${count} note.`,
        tuningOffset: results[0].tuningOffset,
        title: titleFromFileName(files[0].name),
      });
      return;
    }

    const { voices, detectedBpm } = writeTranscriptionVoices(
      results.map((r) => r.notes),
      { settings: doc.settings, takes },
    );
    const patch = tempoAndTitle(detectedBpm, null);
    doc.importVoices(
      files.map((file, i) => ({ name: titleFromFileName(file.name), notes: voices[i] })),
      patch,
    );
    let label = `Trascritti ${files.length} file: una voce per file (i nomi si cambiano in "Voci").`;
    if (empty.length > 0) label += ` Nessuna nota in ${empty.join(', ')}: voce vuota.`;
    docUi.showStatus(transcriptionMessage(label, detectedBpm, patch, 0), { durationMs: 12000 });
  } catch (err) {
    console.error(err);
    docUi.showStatus(`Impossibile trascrivere ${current || 'i file'}: ${err.message}`, { error: true });
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

/** Preferenza sì/no ricordata nel browser (default se assente o se lo storage non è disponibile). */
function loadFlag(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

function saveFlag(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignorato: la preferenza semplicemente non verrà ricordata
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
    // L'audio originale vive solo in memoria: dopo un ricaricamento quelle voci suonano col synth.
    const lost = doc.voices.filter((v) => doc.lostAudio(v.id)).map((v) => `"${v.name}"`);
    if (lost.length > 0) {
      docUi.showStatus(
        `L’audio originale di ${lost.join(', ')} non c’è più: si conserva solo finché la pagina resta aperta, ` +
          'o salvando con File › Salva con l’audio originale. Nel riascolto quelle voci usano il synth.',
        { sticky: true },
      );
    }
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
