/**
 * Conversioni Hertz ↔ MIDI ↔ nome della nota.
 *
 * Riferimenti:
 *   - Accordatura standard: La4 (A4) = 440 Hz = nota MIDI 69.
 *   - Temperamento equabile: l'ottava (rapporto 2:1) è divisa in 12 semitoni uguali,
 *     quindi ogni semitono moltiplica la frequenza per 2^(1/12) ≈ 1.05946.
 */

export const A4_HZ = 440;
export const A4_MIDI = 69;

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Frequenza → numero MIDI *continuo* (non arrotondato).
 *
 * Dalla definizione del temperamento equabile:
 *     f = 440 · 2^((m − 69) / 12)
 * Isolando m:
 *     f / 440        = 2^((m − 69) / 12)
 *     log2(f / 440)  = (m − 69) / 12
 *     m              = 69 + 12 · log2(f / 440)
 *
 * Esempi: 440 Hz → 69 (A4); 880 Hz → 81 (A5, +12 semitoni); 261.63 Hz → ≈60 (C4).
 * La parte frazionaria indica quanto la voce è "fuori" dal semitono più vicino.
 */
export function hzToMidi(hz) {
  return A4_MIDI + 12 * Math.log2(hz / A4_HZ);
}

/** Numero MIDI (anche frazionario) → frequenza in Hz. Formula inversa della precedente. */
export function midiToHz(midi) {
  return A4_HZ * 2 ** ((midi - A4_MIDI) / 12);
}

/**
 * Numero MIDI intero → nome scientifico (es. 60 → "C4", 75 → "D#5").
 *
 * - Classe di altezza: midi mod 12 (0 = C, 1 = C#, … 11 = B).
 * - Ottava: floor(midi / 12) − 1. Il "−1" deriva dalla convenzione per cui MIDI 0 = C−1,
 *   quindi MIDI 60 = 5·12 → ottava 5 − 1 = 4 (Do centrale = C4).
 */
export function midiToNoteName(midi) {
  const pitchClass = ((midi % 12) + 12) % 12; // modulo sempre positivo
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[pitchClass]}${octave}`;
}

/**
 * Analisi completa di una frequenza.
 *
 * I cents misurano lo scarto dal semitono più vicino: 1 semitono = 100 cents,
 * quindi cents = 100 · (m_continuo − m_arrotondato), che equivale a 1200 · log2(f / f_nota).
 * L'intervallo è [−50, +50]: oltre ±50 la nota più vicina sarebbe un'altra.
 *
 * @param {number} hz
 * @returns {{ midi:number, exactMidi:number, name:string, cents:number, hz:number } | null}
 */
export function hzToNote(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return null;
  const exactMidi = hzToMidi(hz);
  const midi = Math.round(exactMidi);
  return {
    midi,
    exactMidi,
    name: midiToNoteName(midi),
    cents: Math.round((exactMidi - midi) * 100),
    hz,
  };
}

/**
 * Numero MIDI → descrizione per VexFlow.
 * VexFlow usa chiavi del tipo "c#/4"; l'alterazione va disegnata a parte come modifier,
 * perciò la restituiamo separatamente. Usiamo solo diesis (niente analisi della tonalità nell'MVP).
 *
 * @returns {{ key:string, accidental:string|null }}
 */
export function midiToVexKey(midi) {
  const pitchClass = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[pitchClass];
  return {
    key: `${name.toLowerCase()}/${octave}`,
    accidental: name.includes('#') ? '#' : null,
  };
}
