/**
 * Altezza "centrale" di una nota cantata, robusta al vibrato.
 *
 * Il vibrato è un'oscillazione dell'altezza (±20–50 cents, 5–7 Hz) attorno alla nota voluta.
 * La semplice mediana dei campioni è distorta se la nota contiene un numero NON intero di
 * oscillazioni: con 2,5 cicli il mezzo ciclo in più sposta la mediana in alto o in basso
 * (fino a ~1/3 dell'ampiezza del vibrato, cioè circa 10 cents).
 *
 * Soluzione: prima si fa la media mobile su una finestra lunga quanto un ciclo di vibrato
 * (~170 ms): ogni valore medio copre un'oscillazione completa, quindi il vibrato si annulla.
 * Poi si prende la mediana dei valori medi, che resta robusta a eventuali frame anomali.
 * Se la nota è più breve della finestra, si usa direttamente la mediana.
 */

export const VIBRATO_WINDOW_MS = 170;

/**
 * @param {number[]} values altezze (MIDI continuo)
 * @param {number[]} times istanti in ms, crescenti (stessa lunghezza di values)
 * @param {number} [windowMs]
 */
export function vibratoCenter(values, times, windowMs = VIBRATO_WINDOW_MS) {
  const n = values.length;
  if (n === 0) return NaN;
  if (times[n - 1] - times[0] < windowMs * 1.2) return median(values);

  // Media mobile centrata (due puntatori: O(n)).
  const averaged = [];
  let lo = 0;
  let hi = 0;
  let sum = 0;
  const half = windowMs / 2;
  for (let i = 0; i < n; i++) {
    while (hi < n && times[hi] <= times[i] + half) sum += values[hi++];
    while (times[lo] < times[i] - half) sum -= values[lo++];
    // solo dove la finestra è completa (ai bordi coprirebbe meno di un ciclo)
    if (times[i] - half >= times[0] && times[i] + half <= times[n - 1]) averaged.push(sum / (hi - lo));
  }
  return averaged.length > 0 ? median(averaged) : median(values);
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
