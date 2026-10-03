/**
 * Audio originale delle voci: conversione in PCM a 16 bit (metà della memoria dei float, qualità da CD)
 * e codifica base64 per includerlo, solo se richiesto, nel file .vocascore.json.
 * Funzioni pure, senza dipendenze dal browser.
 */

/** Float [−1, 1] → interi a 16 bit (con saturazione). */
export function toPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const v = Math.max(-1, Math.min(1, float32[i]));
    out[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  return out;
}

/** Interi a 16 bit → float [−1, 1]. */
export function fromPcm16(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] < 0 ? int16[i] / 32768 : int16[i] / 32767;
  return out;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Map([...ALPHABET].map((c, i) => [c, i]));

/** PCM 16 bit → base64 (byte little-endian, come i file WAV). */
export function pcm16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  const parts = [];
  let chunk = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    chunk +=
      ALPHABET[a >> 2] +
      ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)] +
      (b === undefined ? '=' : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]) +
      (c === undefined ? '=' : ALPHABET[c & 63]);
    if (chunk.length >= 65536) {
      parts.push(chunk); // stringhe a pezzi: niente concatenazioni quadratiche su file grandi
      chunk = '';
    }
  }
  parts.push(chunk);
  return parts.join('');
}

/**
 * base64 → PCM 16 bit. Il testo arriva da un file: un carattere non valido è un errore.
 * @throws {Error} se il testo non è base64 valido o non contiene un numero intero di campioni
 */
export function base64ToPcm16(text) {
  const clean = String(text).replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let j = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => (i + k < clean.length ? LOOKUP.get(clean[i + k]) : 0));
    if (v.some((x) => x === undefined)) throw new Error('Audio non valido nel file.');
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (j < bytes.length) bytes[j++] = (n >> 16) & 255;
    if (j < bytes.length) bytes[j++] = (n >> 8) & 255;
    if (j < bytes.length) bytes[j++] = n & 255;
  }
  if (bytes.length % 2 !== 0) throw new Error('Audio non valido nel file.');
  return new Int16Array(bytes.buffer, 0, bytes.length / 2);
}
