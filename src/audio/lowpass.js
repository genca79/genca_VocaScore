/**
 * Filtro passa-basso applicato al segnale PRIMA della pitch detection.
 *
 * Perché serve: la "chiarezza" di MPM (vedi pitchDetector.js) è il rapporto tra la parte periodica
 * del segnale e la sua energia TOTALE, su tutta la banda. Nella voce reale respiro, sibilanti,
 * fruscio del microfono e ventole stanno quasi tutti sopra i 3–4 kHz, mentre la fondamentale arriva
 * al massimo a ~1100 Hz. Senza filtro quel rumore abbassa la chiarezza sotto la soglia anche quando
 * la voce è ben udibile: i fotogrammi vengono scartati come "non intonati" e le note si perdono o si
 * spezzano. Il passa-basso lascia a MPM solo la banda che contiene l'informazione sull'altezza.
 *
 * Due sezioni biquad Butterworth del 2° ordine (Q = 1/√2, formule di R. Bristow-Johnson, "Audio EQ
 * Cookbook") in cascata: −24 dB/ottava sopra il taglio, risposta piatta nella banda della voce.
 *
 * Lo stato iniziale è quello "a regime" per un ingresso costante pari al primo campione: dal vivo
 * ogni finestra viene filtrata da sola, e partire da zero deformerebbe i primi campioni.
 *
 * @param {Float32Array} input
 * @param {number} sampleRate
 * @param {number} cutoffHz frequenza di taglio; 0 (o ≥ Nyquist) = nessun filtro, copia invariata
 * @param {Float32Array} [output] buffer di uscita della stessa lunghezza (riusabile: niente garbage)
 * @returns {Float32Array} output
 */
export function lowpass(input, sampleRate, cutoffHz, output = new Float32Array(input.length)) {
  if (!cutoffHz || cutoffHz >= sampleRate / 2) {
    output.set(input);
    return output;
  }
  const w = (2 * Math.PI * cutoffHz) / sampleRate;
  const alpha = Math.sin(w) / Math.SQRT2; // sin(w) / (2·Q) con Q = 1/√2
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;

  let source = input;
  for (let stage = 0; stage < 2; stage++) {
    // guadagno in continua = 1: a regime ingresso e uscita valgono entrambi il primo campione
    let x1 = source[0];
    let x2 = x1;
    let y1 = x1;
    let y2 = x1;
    for (let i = 0; i < source.length; i++) {
      const x = source[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      output[i] = y;
    }
    source = output; // la seconda sezione lavora sul risultato della prima (in place)
  }
  return output;
}
