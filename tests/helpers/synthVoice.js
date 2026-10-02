import { midiToHz } from '../../src/music/noteUtils.js';

/**
 * Generatore di "voce cantata" sintetica per i test, con le difficoltà della voce reale:
 * armoniche, vibrato, scivolata d'attacco, cali di volume con rumore di consonante (sillabe),
 * intonazione globale spostata (detune) e rumore di fondo. Deterministico (seed fisso).
 *
 * @param {Array<{ midi:number, start:number, end:number, vibrato?:number, scoopFrom?:number,
 *                 dips?:number[], drift?:number, offset?:number, onset?:{ semitones:number, sec:number } }>} notes
 *   tempi in secondi; offset = stonatura propria della nota (semitoni), in aggiunta al detune globale;
 *   onset = entrata "da fuori": per i primi `sec` secondi la voce sta `semitones` sopra (o sotto) la
 *   nota, poi la raggiunge senza stacco (tipico della voce reale: 100–160 ms, fino a 2 semitoni)
 * @param {number} sampleRate
 * @param {{ detune?:number, noise?:number, tail?:number, hum?:{ hz:number, db:number }, breath?:number }} [options]
 *   detune in semitoni; hum = ronzio costante di fondo (es. rete elettrica a 100 Hz);
 *   breath = ampiezza del soffio della voce: rumore a banda larga che segue il volume della nota
 *   (respiro, sibilanti, fruscio del microfono: quasi tutto sopra i 3–4 kHz nella voce reale)
 */
export function synthVoice(notes, sampleRate, { detune = 0, noise = 0.0005, tail = 0.4, hum = null, breath = 0 } = {}) {
  const total = Math.max(...notes.map((n) => n.end)) + tail;
  const out = new Float32Array(Math.ceil(total * sampleRate));
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32) * 2 - 1;
  let phase = 0;

  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    let v = rand() * noise;
    if (hum) v += Math.SQRT2 * 10 ** (hum.db / 20) * Math.sin(2 * Math.PI * hum.hz * t);
    const n = notes.find((x) => t >= x.start && t < x.end);
    if (n) {
      const local = t - n.start;
      let midi = n.midi + detune + (n.offset ?? 0);
      if (n.vibrato) midi += n.vibrato * Math.sin(2 * Math.PI * 5.5 * local);
      if (n.drift) midi += n.drift * Math.sin((2 * Math.PI * local) / (n.end - n.start));
      if (n.scoopFrom !== undefined && local < 0.09) midi += (n.scoopFrom - n.midi) * (1 - local / 0.09);
      if (n.onset && local < n.onset.sec) midi += n.onset.semitones;
      phase += (2 * Math.PI * midiToHz(midi)) / sampleRate;

      let amp = Math.min(1, local / 0.03, (n.end - t) / 0.03);
      for (const d of n.dips ?? []) {
        const x = (t - d) / 0.03;
        amp *= 1 - 0.9 * Math.exp(-x * x); // calo di ~20 dB per la consonante
        if (Math.abs(t - d) < 0.02) v += rand() * 0.01; // rumore della consonante
      }
      if (breath) v += breath * amp * rand();
      v += 0.08 * amp * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase) + 0.15 * Math.sin(4 * phase));
    }
    out[i] = v;
  }
  return out;
}

/** Melodia di prova: 8 note attese, con tutte le difficoltà della voce reale. */
export const TEST_MELODY = [
  { midi: 60, start: 0.3, end: 0.9, vibrato: 0.3 },
  { midi: 62, start: 0.9, end: 1.5, vibrato: 0.3, scoopFrom: 60.8 }, // legato con scivolata
  // "la-la-la" sulla stessa nota: tre sillabe separate da consonanti
  { midi: 64, start: 1.8, end: 2.7, vibrato: 0.2, dips: [2.1, 2.4] },
  { midi: 67, start: 3.0, end: 4.0, vibrato: 0.4, scoopFrom: 65.5 }, // nota lunga, vibrato ampio
  { midi: 65, start: 4.0, end: 4.5, vibrato: 0.3, drift: 0.08 },
  { midi: 64, start: 4.6, end: 5.3, vibrato: 0.3 },
];
export const TEST_MELODY_EXPECTED = [60, 62, 64, 64, 64, 67, 65, 64];

/**
 * Cantante mediamente calante (−36 cents) e incostante (±15 cents da nota a nota): tre note
 * scavalcano −50 cents e, senza compensazione, verrebbero scritte un semitono sotto.
 * È il caso in cui la stima dell'intonazione serve: lo scarto medio è chiaro (non ambiguo),
 * ma le singole note no. (Con variazioni molto più ampie, ±25 cents e oltre, non esiste più
 * uno scarto medio affidabile e la stima, giustamente, non corregge.)
 */
export const FLAT_SINGER_DETUNE = -0.36;
export const FLAT_SINGER_MELODY = TEST_MELODY.map((n, i) => ({ ...n, offset: [0.08, -0.16, -0.15, 0.1, -0.17, 0.09][i] }));
export const TEST_MELODY_STARTS = [0.3, 0.9, 1.8, 2.1, 2.4, 3.0, 4.0, 4.6];
