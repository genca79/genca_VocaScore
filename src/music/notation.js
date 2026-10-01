/**
 * Logica musicale pura per la notazione (nessuna dipendenza da VexFlow, quindi testabile).
 *
 * Unità di misura: le durate sono in "beats" = semiminime (♩ = 1), indipendentemente dall'indicazione
 * di tempo. Una battuta di 6/8 dura quindi 3 beats, una di 3/4 ne dura 3, una di 4/4 ne dura 4.
 */

import { midiToVexKey } from './noteUtils.js';

/**
 * Figure supportate, dalla più lunga alla più corta.
 * Una figura puntata vale 1.5 volte la figura base.
 */
export const FIGURES = [
  { duration: 'w', dots: 0, beats: 4 }, // semibreve
  { duration: 'h', dots: 1, beats: 3 }, // minima puntata
  { duration: 'h', dots: 0, beats: 2 }, // minima
  { duration: 'q', dots: 1, beats: 1.5 }, // semiminima puntata
  { duration: 'q', dots: 0, beats: 1 }, // semiminima
  { duration: '8', dots: 1, beats: 0.75 }, // croma puntata
  { duration: '8', dots: 0, beats: 0.5 }, // croma
  { duration: '16', dots: 0, beats: 0.25 }, // semicroma
];

/** Griglia minima: la semicroma. Tutte le durate del modello ne sono multipli. */
export const GRID = 0.25;

export const TIME_SIGNATURES = ['2/4', '3/4', '4/4', '6/8'];

/** Converte millisecondi in movimenti: un movimento dura 60000 / bpm ms. */
export function msToBeats(ms, bpm) {
  return ms / (60000 / bpm);
}

/** Converte movimenti in secondi. */
export function beatsToSeconds(beats, bpm) {
  return (beats * 60) / bpm;
}

/**
 * Sceglie la figura più vicina a una durata misurata.
 *
 * La distanza è calcolata in scala logaritmica (|log2(misurata / figura)|) e non lineare:
 * percepiamo le durate in proporzione, quindi 0.6 beat va verso la croma (0.5) e non verso
 * la croma puntata (0.75), anche se linearmente è quasi a metà strada.
 *
 * @returns {{ duration:string, dots:number, beats:number }}
 */
export function quantizeDuration(ms, bpm) {
  const beats = Math.max(msToBeats(ms, bpm), 1e-6);
  let best = FIGURES[FIGURES.length - 1];
  let bestDistance = Infinity;
  for (const figure of FIGURES) {
    const distance = Math.abs(Math.log2(beats / figure.beats));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = figure;
    }
  }
  return { ...best };
}

/**
 * Durata cantata (ms) → durata scritta (beats), usata dalla registrazione.
 * - Fino a ~4.5 movimenti: la figura singola più vicina (scala logaritmica).
 * - Oltre: arrotondamento al movimento intero. Su una nota lunga qualche decina di ms
 *   non è musicalmente rilevante, e si evitano code di figure minuscole legate.
 */
export function quantizeBeats(ms, bpm) {
  const beats = msToBeats(ms, bpm);
  if (beats < 4.5) return quantizeDuration(ms, bpm).beats;
  return Math.round(beats);
}

/**
 * Scompone una durata (multiplo della semicroma) in figure, dalla più lunga alla più corta.
 * Con le figure disponibili il metodo "greedy" copre esattamente qualsiasi multiplo di 0.25:
 * 9 → semibreve + semibreve + semiminima; 2.5 → minima + croma.
 *
 * @returns {Array<{ duration:string, dots:number, beats:number }>}
 */
export function figuresForBeats(beats) {
  const figures = [];
  let remaining = Math.round(beats / GRID) * GRID; // elimina errori di virgola mobile
  for (const figure of FIGURES) {
    while (remaining >= figure.beats - 1e-9) {
      figures.push({ ...figure });
      remaining -= figure.beats;
    }
  }
  return figures;
}

/** "6/8" → { num: 6, den: 8, measureBeats: 3 } (durata della battuta in semiminime). */
export function timeSignatureInfo(timeSignature) {
  const [num, den] = timeSignature.split('/').map(Number);
  return { num, den, measureBeats: (num * 4) / den };
}

/**
 * Impaginazione in battute.
 *
 * Ogni nota viene posizionata in sequenza; se attraversa una stanghetta viene spezzata e le parti
 * sono unite da una legatura (`tieNext`). Ogni parte viene poi scomposta in figure.
 *
 * @param {Array<{ id:string, midi:number|null, beats:number, live?:boolean }>} notes midi null = pausa
 * @param {string} timeSignature es. "3/4"
 * @returns {Array<Array<Segment>>} battute → segmenti (una figura ciascuno)
 *
 * @typedef {{ noteId:string, midi:number|null, duration:string, dots:number, beats:number,
 *             first:boolean, tieNext:boolean, live?:boolean, accidental?:string|null }} Segment
 */
export function layoutMeasures(notes, timeSignature) {
  const { measureBeats } = timeSignatureInfo(timeSignature);
  const measures = [[]];
  let pos = 0;

  for (const note of notes) {
    let remaining = note.beats;
    let first = true;
    while (remaining > 1e-9) {
      if (pos >= measureBeats - 1e-9) {
        measures.push([]);
        pos = 0;
      }
      const chunk = Math.min(remaining, measureBeats - pos);
      for (const figure of figuresForBeats(chunk)) {
        measures.at(-1).push({
          noteId: note.id,
          midi: note.midi,
          live: note.live,
          ...figure,
          first,
          tieNext: false,
        });
        first = false;
      }
      pos += chunk;
      remaining -= chunk;
    }
  }

  // Legature tra segmenti consecutivi della stessa nota (le pause non si legano).
  const flat = measures.flat();
  for (let i = 0; i < flat.length - 1; i++) {
    if (flat[i].midi !== null && flat[i].noteId === flat[i + 1].noteId) flat[i].tieNext = true;
  }
  computeAccidentals(measures);
  return measures.filter((m, i) => m.length > 0 || i === 0);
}

/**
 * Alterazioni secondo le regole della notazione tradizionale:
 *   - un'alterazione vale fino alla fine della battuta, per quella nota e quell'ottava;
 *   - una nota naturale dopo un diesis nella stessa battuta richiede il bequadro (♮);
 *   - le note legate (continuazioni) non ripetono l'alterazione.
 * Imposta `segment.accidental` a '#', 'n' oppure null.
 */
export function computeAccidentals(measures) {
  for (const measure of measures) {
    const state = new Map(); // "c/4" → '#' | 'n'
    for (const seg of measure) {
      seg.accidental = null;
      if (seg.midi === null) continue;
      const { key, accidental } = midiToVexKey(seg.midi);
      const base = key.replace('#', '');
      const needed = accidental ?? 'n';
      const current = state.get(base) ?? 'n';
      if (seg.first && needed !== current) seg.accidental = needed;
      state.set(base, needed);
    }
  }
  return measures;
}

/**
 * Chiave automatica in base all'estensione della voce.
 *
 * Usa la mediana delle note (robusta contro la singola nota fuori registro) con isteresi:
 *   - passa al basso solo se la mediana scende sotto G3 (MIDI 55);
 *   - torna al violino solo se la mediana sale sopra D4 (MIDI 62).
 * Nella fascia G3–D4, comoda in entrambe le chiavi, si mantiene la chiave attuale.
 *
 * @param {number[]} midiNotes
 * @param {'treble'|'bass'} currentClef
 * @returns {'treble'|'bass'}
 */
export function chooseClef(midiNotes, currentClef = 'treble') {
  if (midiNotes.length === 0) return currentClef;
  const sorted = [...midiNotes].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median < 55) return 'bass';
  if (median > 62) return 'treble';
  return currentClef;
}
