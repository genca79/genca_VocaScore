import { detectPitchMPM } from '../audio/pitchDetector.js';
import { computeRms, rmsToDb } from '../audio/noiseGate.js';
import { lowpass } from '../audio/lowpass.js';
import { hzToMidi } from './noteUtils.js';
import { circularMeanOffset } from './tuning.js';
import { median, vibratoCenter } from './pitchCenter.js';

/**
 * Trascrizione OFFLINE di una registrazione completa (eseguita in un Web Worker dopo lo Stop).
 *
 * Il vantaggio rispetto all'analisi dal vivo è il contesto: per decidere che cosa succede in un
 * istante si può guardare anche ciò che viene DOPO. Fasi:
 *
 *   1. Analisi per frame (finestra 64 ms, passo 10 ms): volume e pitch MPM. Il tempo di ogni frame
 *      è il CENTRO della finestra, quindi nessun ritardo di analisi da compensare.
 *   2. Soglia di silenzio dal rumore di fondo dell'intera registrazione (10° percentile).
 *   3. Pitch: correzione degli errori d'ottava rispetto al contesto (±150 ms) e mediana CENTRATA.
 *   4. Intonazione di riferimento: media circolare degli scarti sui CENTRI delle note, ottenute da una
 *      prima segmentazione senza correzione (vedi tuning.js).
 *   5. Segmentazione con l'algoritmo di Viterbi: tra tutte le sequenze possibili di "note" e
 *      "silenzio", trova quella di costo minimo. Il costo premia l'aderenza al pitch misurato e
 *      penalizza ogni cambio di nota: vibrato e piccole scivolate costano meno di un cambio, quindi
 *      non creano note spurie; un cambio vero e tenuto sì.
 *   6. Sillabe ripetute sulla stessa nota: cali di volume con risalita su ENTRAMBI i lati.
 *   7. Altezza di ogni nota: mediana della parte stabile (senza attacco e coda), corretta per
 *      l'intonazione di chi canta.
 *   8. Pulizia: note troppo brevi assorbite dalla vicina o scartate se isolate; entrate "da fuori"
 *      (la voce attacca sopra o sotto la nota e la raggiunge dopo 100–200 ms) assorbite nella nota.
 */

export const OFFLINE_DEFAULTS = Object.freeze({
  windowSec: 0.064,
  hopSec: 0.01,
  minHz: 65,
  maxHz: 1100,
  peakThreshold: 0.9,
  minClarity: 0.75,
  lowpassHz: 2500, // passa-basso prima di MPM, come dal vivo (vedi audio/lowpass.js)
  gateAboveFloorDb: 10,
  minGateDb: -65,
  maxGateDb: -35,
  sigma: 0.4, // tolleranza del pitch attorno alla nota (semitoni): copre il vibrato
  maxEmission: 4, // costo massimo per frame "stonato" (limita il peso dei frame anomali)
  changeCost: 10, // costo di un cambio di nota
  silenceCost: 3, // costo di un passaggio nota ↔ silenzio
  dipDb: 6,
  maxDipSec: 0.3,
  minNoteSec: 0.07,
  maxGlideSec: 0.2, // entrata "da fuori" più lunga di così: è una nota vera (0 = disattivato)
  maxGlideSemitones: 2,
  maxGlideGapSec: 0.08, // buco con suono presente tra entrata e nota (la scivolata abbassa la chiarezza)
  maxTuningOffset: 0.4, // oltre ±40 cents lo scarto è ambiguo di un semitono (vedi tuning.js)
  tuning: true,
});

/**
 * @param {Float32Array} samples audio mono
 * @param {number} sampleRate
 * @param {Partial<typeof OFFLINE_DEFAULTS> & { floorCapDb?:number }} [options]
 *   Il rumore di fondo è il 10° percentile dei frame di QUESTO audio: va bene per una registrazione
 *   intera, non per un pezzo breve tutto cantato (dal vivo, vedi liveTranscriber.js), dove il percentile
 *   cadrebbe sul canto e la soglia di silenzio sarebbe troppo alta. floorCapDb (dBFS) è il fondo già
 *   misurato in precedenza: quello stimato qui non può superarlo.
 * @param {(fraction:number) => void} [onProgress]
 * @returns {{ notes: Array<{ midi:number, start:number, end:number, transition:boolean }>, tuningOffset:number,
 *             floorDb:number|null }} tempi in secondi dall'inizio dell'audio; floorDb = rumore di fondo usato
 */
export function transcribeOffline(samples, sampleRate, options = {}, onProgress = null) {
  const o = { ...OFFLINE_DEFAULTS, ...options };
  const { frames, floorDb } = analyzeFrames(samples, sampleRate, o, onProgress);
  if (frames.length === 0) return { notes: [], tuningOffset: 0, floorDb };

  smoothPitch(frames);
  // Intonazione in due passate: prima una segmentazione senza correzione, per trovare le note e il
  // loro centro; poi lo scarto medio sui CENTRI (sui singoli frame il vibrato lo renderebbe illeggibile).
  const tuningOffset = o.tuning ? estimateTuning(frames, o) : 0;
  const labels = viterbi(frames, tuningOffset, o);
  let notes = toSegments(labels.states, labels.lo, frames);
  notes = splitSyllables(notes, frames, o);
  refinePitch(notes, frames, tuningOffset);
  notes = cleanUp(notes, frames, o);

  const half = o.hopSec / 2;
  const out = notes.map((n) => ({
    midi: n.midi,
    start: frames[n.i0].t - half,
    end: frames[n.i1].t + half,
    syllable: n.syllable,
  }));
  return {
    notes: out.map((n, i) => ({
      midi: n.midi,
      start: n.start,
      end: n.end,
      // legato verso la nota successiva (nessun silenzio in mezzo, e non è una nuova sillaba)
      transition: Boolean(out[i + 1] && out[i + 1].start - n.end < 0.03 && !out[i + 1].syllable),
    })),
    tuningOffset,
    floorDb,
  };
}

// ── 1–2. Analisi per frame e soglia di silenzio ────────────────────────────
function analyzeFrames(samples, sr, o, onProgress) {
  const win = Math.round(o.windowSec * sr);
  const hop = Math.round(o.hopSec * sr);
  const frames = [];
  for (let s = 0; s + win <= samples.length; s += hop) {
    frames.push({ t: (s + win / 2) / sr, s, db: rmsToDb(computeRms(samples.subarray(s, s + win))) });
  }
  if (frames.length === 0) return { frames, floorDb: o.floorCapDb ?? null };

  const dbs = frames.map((f) => f.db).filter(Number.isFinite).sort((a, b) => a - b);
  let floor = dbs.length ? dbs[Math.floor(dbs.length * 0.1)] : -100;
  if (Number.isFinite(o.floorCapDb)) floor = Math.min(floor, o.floorCapDb);
  const gate = Math.min(o.maxGateDb, Math.max(o.minGateDb, floor + o.gateAboveFloorDb));

  // Il pitch si calcola solo dove c'è suono: nei silenzi si risparmia la parte costosa.
  // MPM lavora sul segnale filtrato; il volume (db) resta quello del segnale intero.
  const pitchOptions = { minHz: o.minHz, maxHz: o.maxHz, peakThreshold: o.peakThreshold };
  const voiceBand = lowpass(samples, sr, o.lowpassHz);
  frames.forEach((f, i) => {
    f.active = f.db >= gate - 4; // c'è suono (anche non intonato: consonanti, respiro)
    f.m = NaN;
    f.clarity = 0;
    if (f.db >= gate) {
      const r = detectPitchMPM(voiceBand.subarray(f.s, f.s + win), sr, pitchOptions);
      if (r && r.clarity >= o.minClarity) {
        f.m = hzToMidi(r.hz);
        f.clarity = r.clarity;
      }
    }
    if (onProgress && i % 500 === 0) onProgress(i / frames.length);
  });
  return { frames, floorDb: floor };
}

// ── 3. Pitch: errori d'ottava e mediana centrata ───────────────────────────
function smoothPitch(frames) {
  const n = frames.length;
  const raw = frames.map((f) => f.m);
  // Errore d'ottava: un frame a ±12 semitoni dal contesto (±150 ms) viene riportato nell'ottava giusta.
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(raw[i])) continue;
    const context = [];
    for (let j = Math.max(0, i - 15); j <= Math.min(n - 1, i + 15); j++) if (j !== i && !Number.isNaN(raw[j])) context.push(raw[j]);
    if (context.length < 6) continue;
    const d = raw[i] - median(context);
    if (Math.abs(d - 12) < 0.7) frames[i].m = raw[i] - 12;
    else if (Math.abs(d + 12) < 0.7) frames[i].m = raw[i] + 12;
  }
  // Mediana centrata su 5 frame (50 ms): usa anche i frame successivi, impossibile dal vivo.
  const fixed = frames.map((f) => f.m);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(fixed[i])) {
      frames[i].p = NaN;
      continue;
    }
    const w = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) if (!Number.isNaN(fixed[j])) w.push(fixed[j]);
    frames[i].p = median(w);
  }
}

// ── 4. Intonazione di riferimento ──────────────────────────────────────────
/**
 * Scarto medio sui centri delle note (mediana della parte stabile), pesati per durata.
 * Le note si ottengono da una prima segmentazione senza correzione: anche se qualche nota risulta
 * sbagliata di un semitono, il suo centro (e quindi lo scarto) è comunque misurato correttamente.
 */
function estimateTuning(frames, o) {
  const { states, lo } = viterbi(frames, 0, o);
  const notes = toSegments(states, lo, frames);
  const centers = [];
  const weights = [];
  for (const note of notes) {
    const { values, times } = stableValues(note, frames, 0);
    if (values.length < 8) continue; // note troppo brevi: centro poco affidabile
    centers.push(vibratoCenter(values, times));
    weights.push(values.length);
  }
  if (centers.length < 3) return 0;
  const { offset, coherence } = circularMeanOffset(centers, weights);
  if (coherence < 0.5) return 0;
  return Math.max(-o.maxTuningOffset, Math.min(o.maxTuningOffset, offset));
}

/**
 * Pitch (corretto di `offset`) della parte stabile di una nota, con i tempi in ms:
 * senza attacco (20%, max 100 ms) e coda (10%, max 40 ms).
 */
function stableValues(note, frames, offset) {
  const len = note.i1 - note.i0 + 1;
  const skipStart = Math.min(Math.floor(len * 0.2), 10);
  const skipEnd = Math.min(Math.floor(len * 0.1), 4);
  const values = [];
  const times = [];
  for (let i = note.i0 + skipStart; i <= note.i1 - skipEnd; i++) {
    if (Number.isNaN(frames[i].p)) continue;
    values.push(frames[i].p - offset);
    times.push(frames[i].t * 1000);
  }
  return { values, times };
}

// ── 5. Segmentazione con Viterbi ───────────────────────────────────────────
/**
 * Stati: 0 = silenzio, k ≥ 1 = nota MIDI (lo + k − 1).
 * Costo di emissione di un frame in uno stato:
 *   - frame intonato in una nota:     ½·((pitch − nota)/σ)², limitato a maxEmission
 *   - frame intonato nel silenzio:    3 (è suono: va spiegato da una nota)
 *   - frame con suono ma non intonato (consonante): nota 1.0 / silenzio 0.5 → le consonanti brevi
 *     restano dentro la nota, una pausa non intonata più lunga di ~120 ms diventa silenzio
 *   - frame silenzioso:               nota 4 / silenzio 0
 * Costo di transizione: restare 0; cambiare nota `changeCost`; nota ↔ silenzio `silenceCost`.
 *
 * Il minimo su tutte le provenienze si calcola in O(K) per frame invece di O(K²): da uno stato si
 * arriva restando, dal silenzio, oppure dalla nota di costo minimo (+ changeCost).
 */
function viterbi(frames, offset, o) {
  const xs = frames.map((f) => f.p - offset);
  let min = Infinity;
  let max = -Infinity;
  for (const x of xs) {
    if (Number.isNaN(x)) continue;
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (min === Infinity) return { states: new Int16Array(frames.length), lo: 0 };
  const lo = Math.floor(min) - 1;
  const hi = Math.ceil(max) + 1;
  const K = hi - lo + 2; // + silenzio
  const F = frames.length;
  const back = new Int16Array(F * K);
  let cost = new Float64Array(K);
  let next = new Float64Array(K);

  const emission = (f, x, k) => {
    const voiced = !Number.isNaN(x);
    if (k === 0) return voiced ? 3 : f.active ? 0.5 : 0;
    if (voiced) {
      const d = (x - (lo + k - 1)) / o.sigma;
      return Math.min((d * d) / 2, o.maxEmission);
    }
    return f.active ? 1 : 4;
  };

  for (let k = 0; k < K; k++) cost[k] = emission(frames[0], xs[0], k) + (k === 0 ? 0 : o.silenceCost);

  for (let i = 1; i < F; i++) {
    let bestNote = 1;
    for (let k = 2; k < K; k++) if (cost[k] < cost[bestNote]) bestNote = k;
    for (let k = 0; k < K; k++) {
      let best = cost[k];
      let from = k;
      if (k === 0) {
        if (cost[bestNote] + o.silenceCost < best) {
          best = cost[bestNote] + o.silenceCost;
          from = bestNote;
        }
      } else {
        if (cost[0] + o.silenceCost < best) {
          best = cost[0] + o.silenceCost;
          from = 0;
        }
        if (bestNote !== k && cost[bestNote] + o.changeCost < best) {
          best = cost[bestNote] + o.changeCost;
          from = bestNote;
        }
      }
      next[k] = best + emission(frames[i], xs[i], k);
      back[i * K + k] = from;
    }
    [cost, next] = [next, cost];
  }

  // Ricostruzione all'indietro del percorso di costo minimo.
  const states = new Int16Array(F);
  let k = 0;
  for (let j = 1; j < K; j++) if (cost[j] < cost[k]) k = j;
  for (let i = F - 1; i >= 0; i--) {
    states[i] = k;
    k = back[i * K + k];
  }
  return { states, lo };
}

function toSegments(states, lo, frames) {
  const notes = [];
  let i = 0;
  while (i < states.length) {
    if (states[i] === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < states.length && states[j + 1] === states[i]) j++;
    // i bordi della nota si stringono sui frame che hanno davvero suono
    let a = i;
    let b = j;
    while (a < b && !frames[a].active) a++;
    while (b > a && !frames[b].active) b--;
    notes.push({ midi: lo + states[i] - 1, i0: a, i1: b, syllable: false });
    i = j + 1;
  }
  return notes;
}

// ── 6. Sillabe ripetute ────────────────────────────────────────────────────
function splitSyllables(notes, frames, o) {
  const env = frames.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let j = i - 1; j <= i + 1; j++) {
      const db = frames[j]?.db;
      if (Number.isFinite(db)) {
        s += db;
        c++;
      }
    }
    return c ? s / c : -100;
  });
  const minFrames = Math.ceil(o.minNoteSec / o.hopSec);
  const maxDipFrames = Math.round(o.maxDipSec / o.hopSec);
  const out = [];

  for (const note of notes) {
    let start = note.i0;
    let syllable = note.syllable;
    for (let j = note.i0 + minFrames; j <= note.i1 - minFrames; j++) {
      if (!(env[j] <= env[j - 1] && env[j] < env[j + 1])) continue; // minimo locale
      let left = -Infinity;
      let right = -Infinity;
      for (let k = Math.max(start, j - 15); k <= j; k++) left = Math.max(left, env[k]);
      for (let k = j; k <= Math.min(note.i1, j + 15); k++) right = Math.max(right, env[k]);
      const ref = Math.min(left, right);
      if (ref - env[j] < o.dipDb) continue;
      // larghezza del calo: una consonante è breve, un respiro lungo no
      let a = j;
      let b = j;
      while (a > start && env[a - 1] < ref - 3) a--;
      while (b < note.i1 && env[b + 1] < ref - 3) b++;
      if (b - a > maxDipFrames || j - start < minFrames) continue;
      out.push({ midi: note.midi, i0: start, i1: Math.max(start, a - 1), syllable });
      start = Math.min(note.i1, b + 1);
      syllable = true;
      j = start + minFrames - 1;
    }
    out.push({ midi: note.midi, i0: start, i1: note.i1, syllable });
  }
  return out;
}

// ── 7. Altezza definitiva di ogni nota ─────────────────────────────────────
function refinePitch(notes, frames, offset) {
  for (const note of notes) {
    const { values, times } = stableValues(note, frames, offset);
    if (values.length > 0) {
      note.midi = Math.round(vibratoCenter(values, times));
      continue;
    }
    const all = [];
    for (let i = note.i0; i <= note.i1; i++) if (!Number.isNaN(frames[i].p)) all.push(frames[i].p - offset);
    if (all.length > 0) note.midi = Math.round(median(all));
  }
}

// ── 8. Pulizia ─────────────────────────────────────────────────────────────
function cleanUp(notes, frames, o) {
  const minFrames = Math.ceil(o.minNoteSec / o.hopSec);
  const list = notes.map((n) => ({ ...n }));
  const adjacent = (a, b) => a && b && b.i0 - a.i1 <= 3;

  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n.i1 - n.i0 + 1 >= minFrames) continue;
    const prev = list[i - 1];
    const nextNote = list[i + 1];
    const toPrev = adjacent(prev, n);
    const toNext = adjacent(n, nextNote);
    if (toPrev || toNext) {
      // nota brevissima attaccata a un'altra: è un passaggio della voce → la si assorbe nella vicina più simile
      const target =
        toPrev && toNext
          ? Math.abs(prev.midi - n.midi) <= Math.abs(nextNote.midi - n.midi)
            ? prev
            : nextNote
          : toPrev
            ? prev
            : nextNote;
      if (target === prev) prev.i1 = n.i1;
      else nextNote.i0 = n.i0;
      list.splice(i, 1);
      i--;
    } else if ((n.i1 - n.i0 + 1) * o.hopSec < 0.04) {
      list.splice(i, 1); // rumore isolato
      i--;
    }
  }

  absorbOnsetGlides(list, frames, o);

  // Note consecutive con la stessa altezza e senza una nuova sillaba in mezzo: una sola nota.
  const merged = [];
  for (const n of list) {
    const last = merged.at(-1);
    if (last && last.midi === n.midi && !n.syllable && n.i0 - last.i1 <= 3) last.i1 = n.i1;
    else merged.push(n);
  }
  return merged;
}

/**
 * Entrata "da fuori": la voce reale spesso attacca una nota sopra o sotto (fino a 1–2 semitoni) e la
 * raggiunge dopo 100–200 ms, senza stacco. Misurato su una registrazione vera: "mi" attaccato un
 * semitono sopra per 160 ms, "re" partito due semitoni sotto per 150 ms. Più lunghe della soglia delle
 * note brevi (minNoteSec), diventerebbero note in più e romperebbero il ritmo (D#3 0.25 | D3 0.75).
 *
 * Una nota è un'entrata, e viene assorbita nella successiva (che ne prende l'attacco), se:
 *   - è breve (≤ maxGlideSec) e la successiva dura almeno una volta e mezza tanto, a ≤ maxGlideSemitones
 *     (sulla voce vera l'entrata può essere lunga quasi metà della nota: "mi" 160 ms + 330 ms);
 *   - APRE un gruppo: prima c'è silenzio o una consonante (≥ 3 frame senza altezza), o è una nuova
 *     sillaba. Una nota breve dentro una frase legata è invece una nota di passaggio vera e resta;
 *   - arriva alla successiva senza stacco: niente nuova sillaba, e il buco tra le due (≤ maxGlideGapSec)
 *     ha suono presente. Durante una scivolata veloce l'altezza cambia dentro la finestra di analisi,
 *     la chiarezza crolla e quei frame risultano "senza altezza" anche se la voce non si interrompe.
 *
 * Limite noto: una nota breve cantata davvero all'inizio di un gruppo e legata alla successiva sulla
 * stessa sillaba (un melisma) viene assorbita. Con maxGlideSec = 0 la regola è disattivata.
 */
function absorbOnsetGlides(list, frames, o) {
  const maxFrames = Math.round(o.maxGlideSec / o.hopSec);
  const maxGap = Math.round(o.maxGlideGapSec / o.hopSec);
  const len = (n) => n.i1 - n.i0 + 1;
  const soundBetween = (a, b) => {
    if (b.i0 - a.i1 - 1 > maxGap) return false;
    for (let k = a.i1 + 1; k < b.i0; k++) if (!frames[k].active) return false;
    return true;
  };
  for (let i = 0; i < list.length - 1; i++) {
    const n = list[i];
    const next = list[i + 1];
    const prev = list[i - 1];
    if (len(n) > maxFrames || len(next) < 1.5 * len(n) || next.syllable) continue;
    if (Math.abs(next.midi - n.midi) > o.maxGlideSemitones) continue;
    const opensGroup = !prev || n.syllable || n.i0 - prev.i1 - 1 >= 3;
    if (!opensGroup || !soundBetween(n, next)) continue;
    next.i0 = n.i0;
    next.syllable = n.syllable;
    list.splice(i, 1);
    i--;
  }
}
