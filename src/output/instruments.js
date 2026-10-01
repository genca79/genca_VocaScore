import * as Tone from 'tone';

/**
 * Strumenti virtuali, tutti in sintesi pura: nessun campione audio da scaricare.
 *
 * Ogni preset crea un sintetizzatore *monofonico* (Synth, MonoSynth, FMSynth…): la voce canta
 * una nota alla volta, e i monofonici supportano setNote() e il portamento per il legato.
 * `gainDb` compensa le differenze di volume percepito tra un timbro e l'altro.
 *
 * Mini-glossario dei parametri usati:
 *   - envelope (ADSR): attack/decay/sustain/release dell'ampiezza;
 *   - filterEnvelope: come si apre il filtro nel tempo (baseFrequency + octaves di escursione);
 *     è ciò che rende "brillante" l'attacco di ottoni e synth;
 *   - FM (harmonicity, modulationIndex): un oscillatore modula la frequenza dell'altro e crea
 *     timbri metallici e percussivi, come campane e piano elettrico;
 *   - partials: le ampiezze delle armoniche, la "ricetta" dei registri di un organo.
 */
export const INSTRUMENTS = {
  lead: {
    label: 'Synth Lead',
    gainDb: 0,
    create: () =>
      new Tone.MonoSynth({
        oscillator: { type: 'sawtooth' },
        filter: { Q: 1, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.02, decay: 0.2, sustain: 0.7, release: 0.25 },
        filterEnvelope: { attack: 0.02, decay: 0.3, sustain: 0.5, release: 0.3, baseFrequency: 250, octaves: 3.5 },
      }),
  },
  flute: {
    label: 'Flauto',
    gainDb: -3,
    create: () =>
      new Tone.MonoSynth({
        oscillator: { type: 'triangle' },
        filter: { Q: 0.5, type: 'lowpass', rolloff: -12 },
        envelope: { attack: 0.07, decay: 0.1, sustain: 0.9, release: 0.25 },
        filterEnvelope: { attack: 0.06, decay: 0.2, sustain: 0.8, release: 0.3, baseFrequency: 1200, octaves: 2 },
      }),
  },
  strings: {
    label: 'Archi',
    gainDb: 1,
    create: () =>
      new Tone.MonoSynth({
        // "fat": 3 oscillatori leggermente scordati tra loro (spread in cents) → effetto ensemble
        oscillator: { type: 'fatsawtooth', count: 3, spread: 20 },
        filter: { Q: 0.7, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.15, decay: 0.3, sustain: 0.85, release: 0.6 },
        filterEnvelope: { attack: 0.2, decay: 0.5, sustain: 0.7, release: 0.6, baseFrequency: 600, octaves: 2.5 },
      }),
  },
  brass: {
    label: 'Ottoni',
    gainDb: -1,
    create: () =>
      new Tone.MonoSynth({
        oscillator: { type: 'sawtooth' },
        filter: { Q: 2, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.05, decay: 0.2, sustain: 0.8, release: 0.2 },
        filterEnvelope: { attack: 0.06, decay: 0.25, sustain: 0.6, release: 0.2, baseFrequency: 300, octaves: 4 },
      }),
  },
  organ: {
    label: 'Organo',
    gainDb: -1,
    create: () =>
      new Tone.Synth({
        // registri 8' + 4' + 2⅔' + 2' circa: fondamentale e alcune armoniche
        oscillator: { partials: [1, 0.6, 0.4, 0.25, 0, 0.15, 0, 0.1] },
        envelope: { attack: 0.01, decay: 0.05, sustain: 1, release: 0.08 },
      }),
  },
  epiano: {
    label: 'Piano elettrico',
    gainDb: 8,
    create: () =>
      new Tone.FMSynth({
        harmonicity: 3,
        modulationIndex: 10,
        oscillator: { type: 'sine' },
        modulation: { type: 'sine' },
        envelope: { attack: 0.005, decay: 1.2, sustain: 0.25, release: 0.8 },
        modulationEnvelope: { attack: 0.005, decay: 0.5, sustain: 0.1, release: 0.5 },
      }),
  },
  bell: {
    label: 'Campane',
    gainDb: 11,
    create: () =>
      new Tone.FMSynth({
        harmonicity: 3.01, // rapporto non intero → parziali inarmoniche, tipiche del metallo
        modulationIndex: 14,
        oscillator: { type: 'sine' },
        modulation: { type: 'square' },
        envelope: { attack: 0.001, decay: 2, sustain: 0, release: 2 },
        modulationEnvelope: { attack: 0.002, decay: 0.6, sustain: 0, release: 0.5 },
      }),
  },
  bass: {
    label: 'Basso synth',
    gainDb: -7,
    create: () =>
      new Tone.MonoSynth({
        oscillator: { type: 'square' },
        filter: { Q: 3, type: 'lowpass', rolloff: -24 },
        envelope: { attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.15 },
        filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 0.3, release: 0.2, baseFrequency: 220, octaves: 2.5 },
      }),
  },
};

export const DEFAULT_INSTRUMENT = 'lead';
