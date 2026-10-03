/**
 * File WAV (RIFF, PCM 16 bit, little-endian) da un audio a uno o più canali.
 * Il formato più semplice e universale: si apre con qualsiasi programma, senza perdita di qualità.
 * Funzione pura: nessuna dipendenza dal browser.
 *
 * @param {{ numberOfChannels:number, sampleRate:number, length:number, getChannelData:(c:number) => Float32Array }} audio
 *   un AudioBuffer, o un oggetto con la stessa forma
 * @returns {ArrayBuffer} il file completo (intestazione di 44 byte + campioni intercalati)
 */
export function encodeWav(audio) {
  const channels = audio.numberOfChannels;
  const frames = audio.length;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const text = (offset, s) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // dimensione del file meno 8 byte
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true); // dimensione del blocco fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * channels * bytesPerSample, true); // byte al secondo
  view.setUint16(32, channels * bytesPerSample, true); // byte per frame
  view.setUint16(34, 16, true); // bit per campione
  text(36, 'data');
  view.setUint32(40, dataSize, true);

  const data = Array.from({ length: channels }, (_, c) => audio.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, Math.round(v < 0 ? v * 32768 : v * 32767), true);
      offset += bytesPerSample;
    }
  }
  return buffer;
}
