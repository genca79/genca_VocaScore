import { computeRms, rmsToDb } from './noiseGate.js';
import { lowpass } from './lowpass.js';

/**
 * Pitch detection con l'algoritmo McLeod Pitch Method (MPM).
 * Riferimento: P. McLeod, G. Wyvill, "A Smarter Way to Find Pitch", ICMC 2005.
 *
 * Perché MPM e non lo spettro FFT: la voce è ricca di armoniche e spesso la fondamentale è
 * più debole della seconda o terza armonica, quindi il picco più alto dello spettro sbaglia
 * spesso d'ottava. MPM lavora nel dominio del tempo e cerca il *periodo* del segnale,
 * cioè il ritardo τ per cui la forma d'onda assomiglia di più a se stessa.
 *
 * ── Normalized Square Difference Function (NSDF) ─────────────────────────────
 *
 *   r(τ) = Σ_{j=0}^{W−1−τ} x[j]·x[j+τ]               autocorrelazione
 *   m(τ) = Σ_{j=0}^{W−1−τ} (x[j]² + x[j+τ]²)         energia delle due porzioni sovrapposte
 *   n(τ) = 2·r(τ) / m(τ)                              ∈ [−1, 1]
 *
 * n(τ) = 1 significa periodicità perfetta con periodo τ. Grazie alla normalizzazione il valore
 * non dipende dal volume e funge da indice di "chiarezza" (quanto il suono è intonato).
 *
 * Questa funzione è PURA (buffer in ingresso, frequenza in uscita): nella Fase 2 potrà essere
 * spostata in un AudioWorklet senza modifiche.
 *
 * @param {Float32Array} buffer campioni nel dominio del tempo, in [−1, 1]
 * @param {number} sampleRate
 * @param {{ minHz?:number, maxHz?:number, peakThreshold?:number }} [options]
 * @returns {{ hz:number, clarity:number } | null}
 */
export function detectPitchMPM(buffer, sampleRate, { minHz = 65, maxHz = 1100, peakThreshold = 0.9 } = {}) {
  const W = buffer.length;
  // Un periodo di τ campioni corrisponde a f = sampleRate / τ, quindi:
  // la frequenza massima dà il ritardo minimo e la minima il ritardo massimo.
  const minTau = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxTau = Math.min(Math.ceil(sampleRate / minHz) + 1, W - 2);
  if (maxTau <= minTau) return null;

  // ── 1. Calcolo della NSDF ─────────────────────────────────────────────────
  const nsdf = new Float32Array(maxTau + 1);

  // m(0) = 2·Σx². Poi m si aggiorna in modo incrementale invece che ricalcolarlo:
  // passando da τ a τ+1 la sovrapposizione perde un campione per lato, quindi
  //   m(τ+1) = m(τ) − x[W−1−τ]² − x[τ]²
  let m = 0;
  for (let j = 0; j < W; j++) m += 2 * buffer[j] * buffer[j];

  for (let tau = 0; tau <= maxTau; tau++) {
    let r = 0;
    const limit = W - tau;
    for (let j = 0; j < limit; j++) r += buffer[j] * buffer[j + tau];
    nsdf[tau] = m > 0 ? (2 * r) / m : 0;
    m -= buffer[W - 1 - tau] ** 2 + buffer[tau] ** 2;
  }

  // ── 2. Ricerca dei "key maxima" ───────────────────────────────────────────
  // Saltiamo il primo lobo positivo (attorno a τ=0, dove n vale sempre 1), poi in ogni
  // regione in cui la NSDF è positiva teniamo solo il massimo più alto.
  const peaks = [];
  let tau = 1;
  while (tau <= maxTau && nsdf[tau] > 0) tau++;

  let regionMax = -1;
  let regionMaxTau = -1;
  for (; tau <= maxTau; tau++) {
    if (nsdf[tau] > 0) {
      if (nsdf[tau] > regionMax) {
        regionMax = nsdf[tau];
        regionMaxTau = tau;
      }
    } else if (regionMaxTau !== -1) {
      peaks.push(regionMaxTau);
      regionMax = -1;
      regionMaxTau = -1;
    }
  }
  if (regionMaxTau !== -1 && regionMaxTau < maxTau) peaks.push(regionMaxTau);
  if (peaks.length === 0) return null;

  // ── 3. Scelta del picco ───────────────────────────────────────────────────
  // Non si prende il massimo assoluto (che spesso sta a 2τ o 3τ, cioè un'ottava sotto),
  // ma il PRIMO picco che raggiunge almeno k · massimo. È questo che rende MPM robusto
  // agli errori d'ottava.
  let globalMax = 0;
  for (const p of peaks) globalMax = Math.max(globalMax, nsdf[p]);
  const threshold = peakThreshold * globalMax;
  const chosen = peaks.find((p) => nsdf[p] >= threshold);
  // Se il periodo vero è troppo corto (es. un fischio a 3 kHz) NON si ripiega sui picchi
  // successivi: sarebbero subarmoniche (τ multipli) e daremmo una nota falsa più grave.
  if (chosen === undefined || chosen < minTau) return null;

  // ── 4. Interpolazione parabolica ──────────────────────────────────────────
  // τ è intero, ma il periodo reale cade tra due campioni: a 48 kHz e 440 Hz (τ≈109)
  // un errore di ±0.5 campioni vale circa ±8 cents. Facendo passare una parabola per
  // (τ−1, a), (τ, b), (τ+1, c) il vertice si trova in
  //   δ = (a − c) / (2·(a − 2b + c))         con δ ∈ [−0.5, 0.5]
  // e il valore al vertice è b − (a − c)·δ / 4.
  const a = nsdf[chosen - 1];
  const b = nsdf[chosen];
  const c = nsdf[chosen + 1];
  const denom = a - 2 * b + c;
  const delta = denom !== 0 ? (a - c) / (2 * denom) : 0;
  const refinedTau = chosen + delta;
  const clarity = Math.min(1, b - ((a - c) * delta) / 4);

  const hz = sampleRate / refinedTau;
  if (hz < minHz || hz > maxHz) return null;
  return { hz, clarity };
}

/**
 * Pitch di una finestra di voce: passa-basso (vedi lowpass.js) e poi MPM.
 * È la funzione usata dall'analisi dal vivo; `lowpassHz: 0` la riduce a MPM sul segnale grezzo.
 *
 * @param {Float32Array} buffer
 * @param {number} sampleRate
 * @param {{ lowpassHz?:number, minHz?:number, maxHz?:number, peakThreshold?:number }} [options]
 * @param {Float32Array} [scratch] buffer per il segnale filtrato (riusato a ogni frame)
 */
export function detectVoicePitch(buffer, sampleRate, { lowpassHz = 0, ...mpm } = {}, scratch = undefined) {
  const input = lowpassHz ? lowpass(buffer, sampleRate, lowpassHz, scratch) : buffer;
  return detectPitchMPM(input, sampleRate, mpm);
}

/**
 * Loop di analisi in tempo reale: ad ogni frame (requestAnimationFrame, ~60 fps) legge i
 * campioni dall'AnalyserNode, applica il noise gate e, solo se il gate è aperto, stima il pitch.
 *
 * Nota: rAF gira sul thread principale e si ferma quando la scheda è in background.
 * Per l'MVP va bene; nella Fase 2 l'analisi passerà in un AudioWorklet.
 */
export class PitchAnalyzer {
  /**
   * @param {AnalyserNode} analyser
   * @param {number} sampleRate
   * @param {{ gate: import('./noiseGate.js').NoiseGate, pitch: object, minClarity: number,
   *           onFrame: (frame:{ db:number, gateOpen:boolean, gateOpenDb:number, hz:number|null,
   *                             clarity:number, timeMs:number }) => void }} options
   */
  constructor(analyser, sampleRate, { gate, pitch, minClarity, onFrame }) {
    this.analyser = analyser;
    this.sampleRate = sampleRate;
    this.gate = gate;
    this.pitchOptions = pitch;
    this.minClarity = minClarity;
    this.onFrame = onFrame;
    // Buffer allocato una sola volta: niente garbage a 60 fps.
    this.buffer = new Float32Array(analyser.fftSize);
    this.filtered = new Float32Array(analyser.fftSize);
    this.rafId = null;
    this.tick = this.tick.bind(this);
  }

  start() {
    if (this.rafId !== null) return;
    this.gate.reset();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop() {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  tick(timeMs) {
    this.rafId = requestAnimationFrame(this.tick);

    this.analyser.getFloatTimeDomainData(this.buffer);
    const db = rmsToDb(computeRms(this.buffer));
    const gateOpen = this.gate.process(db, timeMs);

    let hz = null;
    let clarity = 0;
    // Noise gate: con il gate chiuso non si esegue la detection (risparmio di CPU e niente note fantasma).
    if (gateOpen) {
      const result = detectVoicePitch(this.buffer, this.sampleRate, this.pitchOptions, this.filtered);
      if (result && result.clarity >= this.minClarity) {
        hz = result.hz;
        clarity = result.clarity;
      }
    }
    this.onFrame({ db, gateOpen, gateOpenDb: this.gate.openDb, hz, clarity, timeMs });
  }
}
