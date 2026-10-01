import { Recorder } from './recorder.js';

/**
 * Ritmo: rilevamento del tempo (battiti) e quantizzazione automatica.
 * Tutte funzioni pure, applicate allo Stop sulle note della sessione (tempi in ms).
 */

// ── Rilevamento dei battiti ─────────────────────────────────────────────────
/**
 * Tracciamento dei battiti con programmazione dinamica (D. Ellis, "Beat Tracking by Dynamic
 * Programming", J. New Music Research, 2007), adattato agli attacchi delle note cantate.
 *
 *  1. "Inviluppo degli attacchi": su una linea del tempo a passi di 10 ms ogni attacco è un piccolo
 *     impulso gaussiano (±30 ms), più forte per le note lunghe (più probabilmente sul battere).
 *  2. Tempo medio: autocorrelazione dell'inviluppo (quanto si somiglia spostato di un certo ritardo),
 *     moltiplicata per una preferenza "morbida" attorno ai BPM impostati dall'utente. La preferenza
 *     risolve l'ambiguità tipica del tempo: doppio o metà tempo spiegano gli attacchi quasi altrettanto bene.
 *  3. Sequenza dei battiti: tra tutte le sequenze possibili si sceglie quella che massimizza
 *     Σ attacchi sui battiti − α · Σ (ln(intervallo / periodo))²
 *     cioè battiti che cadono sugli attacchi e intervalli vicini al periodo. Il termine logaritmico
 *     permette variazioni graduali di tempo (rallentando, accelerando) ma non salti.
 *
 * @param {number[]} onsetsMs attacchi in ms, crescenti
 * @param {{ weights?:number[], endMs?:number, hintBpm?:number, minBpm?:number, maxBpm?:number,
 *           tightness?:number }} [options]
 * @returns {{ beats:number[], bpm:number } | null} battiti in ms (null se gli attacchi sono troppo pochi)
 */
export function detectBeats(onsetsMs, { weights = null, endMs = null, hintBpm = 100, minBpm = 45, maxBpm = 220, tightness = 60 } = {}) {
  if (onsetsMs.length < 4) return null;
  const RES = 10; // ms per passo
  const origin = onsetsMs[0] - 1000;
  const last = Math.max(onsetsMs.at(-1), endMs ?? 0);
  const n = Math.ceil((last + 1500 - origin) / RES);
  const env = new Float64Array(n);
  onsetsMs.forEach((t, i) => {
    const c = (t - origin) / RES;
    const w = weights ? weights[i] : 1;
    for (let k = Math.max(0, Math.floor(c - 9)); k <= Math.min(n - 1, Math.ceil(c + 9)); k++) {
      env[k] += w * Math.exp(-0.5 * ((k - c) / 3) ** 2); // σ = 30 ms
    }
  });

  // 2. Tempo medio: autocorrelazione × preferenza log-gaussiana attorno a hintBpm (±0.8 ottave).
  const lagMin = Math.floor(60000 / maxBpm / RES);
  const lagMax = Math.ceil(60000 / minBpm / RES);
  const score = (lag) => {
    let ac = 0;
    for (let t = 0; t + lag < n; t++) ac += env[t] * env[t + lag];
    const bpm = 60000 / (lag * RES);
    return ac * Math.exp(-0.5 * (Math.log2(bpm / hintBpm) / 0.8) ** 2);
  };
  let bestLag = lagMin;
  let best = -Infinity;
  const scores = new Map();
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const s = score(lag);
    scores.set(lag, s);
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  // interpolazione parabolica del picco: periodo con precisione inferiore al passo di 10 ms
  const a = scores.get(bestLag - 1) ?? best;
  const c = scores.get(bestLag + 1) ?? best;
  const denom = a - 2 * best + c;
  const period = bestLag + (denom !== 0 ? (0.5 * (a - c)) / denom : 0);

  // 3. Sequenza dei battiti (programmazione dinamica).
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let bestPrev = 0;
    let arg = -1;
    for (let p = Math.max(0, t - hi); p <= t - lo; p++) {
      const v = cum[p] - tightness * Math.log((t - p) / period) ** 2;
      if (v > bestPrev) {
        bestPrev = v;
        arg = p;
      }
    }
    cum[t] = env[t] + bestPrev;
    back[t] = arg;
  }
  // l'ultimo battito: il migliore nell'ultimo periodo coperto dagli attacchi
  const lastBin = Math.round((onsetsMs.at(-1) - origin) / RES);
  let tEnd = lastBin;
  for (let t = Math.max(0, lastBin - Math.round(period)); t <= Math.min(n - 1, lastBin + Math.round(period)); t++) {
    if (cum[t] > cum[tEnd]) tEnd = t;
  }
  const bins = [];
  for (let t = tEnd; t >= 0; t = back[t]) bins.push(t);
  bins.reverse();
  if (bins.length < 2) return null;

  // Prolungamento con il periodo locale, prima del primo e dopo l'ultimo battito.
  const beats = bins.map((b) => origin + b * RES);
  const startPeriod = beats[1] - beats[0];
  while (beats[0] > onsetsMs[0] - startPeriod) beats.unshift(beats[0] - startPeriod);
  const endPeriod = beats.at(-1) - beats.at(-2);
  while (beats.at(-1) < last + endPeriod) beats.push(beats.at(-1) + endPeriod);

  const intervals = beats.slice(1).map((b, i) => b - beats[i]).sort((x, y) => x - y);
  return { beats, bpm: 60000 / intervals[intervals.length >> 1] };
}

// ── Mappa tempo → posizione musicale ───────────────────────────────────────
/**
 * Converte un istante in ms in posizione musicale (beats dall'inizio della sessione).
 * - Con battiti rilevati: interpolazione lineare tra un battito e l'altro (segue le variazioni
 *   di tempo); il battito più vicino al primo attacco è il primo movimento (posizione 0).
 * - Con tempo noto (metronomo): posizione = (t − t0) / durata del movimento.
 */
export function beatMap({ beats = null, firstOnsetMs = null, t0Ms = null, bpm = null }) {
  if (!beats) {
    const beatMs = 60000 / bpm;
    return (ms) => (ms - t0Ms) / beatMs;
  }
  let zero = 0;
  for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - firstOnsetMs) < Math.abs(beats[zero] - firstOnsetMs)) zero = i;
  return (ms) => {
    let i = 0;
    while (i < beats.length - 2 && beats[i + 1] <= ms) i++;
    return i - zero + (ms - beats[i]) / (beats[i + 1] - beats[i]); // oltre i bordi: estrapolazione lineare
  };
}

// ── Quantizzazione automatica ──────────────────────────────────────────────
const SUBDIVISIONS = [1, 2, 4];
/** Costo di "complessità" di ogni suddivisione: si sceglie una suddivisione fine solo se serve davvero. */
const COMPLEXITY = { 1: 0, 2: 0.6, 4: 1.6 };

/**
 * Per ogni movimento sceglie la suddivisione (intero, metà, quarti) che minimizza
 *   Σ peso · ((posizione − posizione agganciata) / σ)²  +  complessità
 * cioè il miglior equilibrio tra fedeltà al canto e semplicità di lettura.
 * σ = 0.1 movimenti: un attacco a ±10% del movimento è "normale" imprecisione.
 * Gli stacchi (fine nota) pesano meno degli attacchi: sono meno precisi e meno importanti.
 *
 * @param {Array<{ pos:number, weight:number }>} events posizioni in beats
 * @returns {(pos:number) => number} funzione di aggancio
 */
export function autoGrid(events, { sigma = 0.1 } = {}) {
  const byBeat = new Map();
  for (const e of events) {
    const beat = Math.floor(e.pos + 1e-9);
    if (!byBeat.has(beat)) byBeat.set(beat, []);
    byBeat.get(beat).push(e);
  }
  const chosen = new Map();
  for (const [beat, list] of byBeat) {
    let bestS = 1;
    let bestCost = Infinity;
    for (const s of SUBDIVISIONS) {
      let cost = COMPLEXITY[s];
      for (const { pos, weight } of list) {
        const frac = pos - beat;
        const err = (frac - Math.round(frac * s) / s) / sigma;
        cost += weight * err * err;
      }
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        bestS = s;
      }
    }
    chosen.set(beat, bestS);
  }
  return (pos) => {
    const beat = Math.floor(pos + 1e-9);
    const s = chosen.get(beat) ?? 4;
    return Math.max(0, beat + Math.round((pos - beat) * s) / s);
  };
}

/** Griglia fissa: aggancio al multiplo di `grid` più vicino. */
export function fixedGrid(grid) {
  return (pos) => Math.max(0, Math.round(pos / grid) * grid);
}

// ── Trascrizione ritmica di una sessione ───────────────────────────────────
/**
 * Note della sessione (ms) → note scritte (beats), con tempo e quantizzazione decisi qui:
 *   - tempo: noto (metronomo, t0Ms) oppure RILEVATO dagli attacchi (metronomo spento);
 *   - quantizzazione: griglia fissa oppure automatica per movimento (settings.grid === 'auto').
 *
 * @param {Array<{ midi:number, startMs:number, endMs:number, transition:boolean }>} notes
 * @param {{ settings:{ bpm:number, grid:number|'auto', timeSignature:string, legato?:boolean },
 *           t0Ms:number|null, latencyMs?:number }} session
 * @returns {{ written:Array<{ midi:number|null, beats:number }>, detectedBpm:number|null }}
 */
export function transcribeRhythm(notes, { settings, t0Ms, latencyMs = 0 }) {
  if (notes.length === 0) return { written: [], detectedBpm: null };
  const onsets = notes.map((n) => n.startMs);

  let toBeat;
  let detectedBpm = null;
  if (t0Ms !== null) {
    toBeat = beatMap({ t0Ms: t0Ms + latencyMs, bpm: settings.bpm });
  } else {
    const detected = detectBeats(onsets, {
      // le note lunghe cadono più spesso sul battere: pesano di più
      weights: notes.map((n) => 0.5 + 0.5 * Math.min(1, (n.endMs - n.startMs) / 400)),
      endMs: notes.at(-1).endMs,
      hintBpm: settings.bpm,
    });
    if (detected) {
      detectedBpm = detected.bpm;
      toBeat = beatMap({ beats: detected.beats, firstOnsetMs: onsets[0] });
    } else {
      toBeat = beatMap({ t0Ms: onsets[0], bpm: settings.bpm }); // troppo poche note: tempo impostato
    }
  }

  const auto = settings.grid === 'auto';
  const events = notes.flatMap((n) => [
    { ms: n.startMs, pos: toBeat(n.startMs), weight: 1 },
    { ms: n.endMs, pos: toBeat(n.endMs), weight: 0.3 },
  ]);
  const snapPos = auto ? autoGrid(events) : fixedGrid(settings.grid);
  const snapped = new Map(events.map((e) => [e.ms, snapPos(e.pos)]));

  const written = Recorder.quantize(notes, {
    settings: { ...settings, bpm: detectedBpm ?? settings.bpm },
    t0Raw: 0,
    snap: (ms) => snapped.get(ms) ?? snapPos(toBeat(ms)),
    grid: auto ? 0.25 : settings.grid,
  });
  return { written, detectedBpm };
}
