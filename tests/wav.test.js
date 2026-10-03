import { describe, expect, it } from 'vitest';
import { encodeWav } from '../src/storage/wav.js';

const audio = (channels, sampleRate = 44100) => ({
  numberOfChannels: channels.length,
  sampleRate,
  length: channels[0].length,
  getChannelData: (c) => Float32Array.from(channels[c]),
});
const ascii = (view, offset, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(offset + i)));

describe('encodeWav', () => {
  it('intestazione RIFF/WAVE standard (PCM 16 bit), come da specifica', () => {
    const view = new DataView(encodeWav(audio([[0, 0.5, -0.5], [0.25, 0, 1]], 48000)));
    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + 3 * 2 * 2);
    expect(ascii(view, 8, 8)).toBe('WAVEfmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(48000 * 4);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(12);
    expect(view.byteLength).toBe(44 + 12);
  });

  it('campioni intercalati (sinistro, destro) e saturati in [−1, 1]', () => {
    const view = new DataView(encodeWav(audio([[0.5, 2], [-0.5, -3]])));
    expect([44, 46, 48, 50].map((o) => view.getInt16(o, true))).toEqual([16384, -16384, 32767, -32768]);
  });

  it('mono', () => {
    const view = new DataView(encodeWav(audio([[1, -1]])));
    expect(view.getUint16(22, true)).toBe(1);
    expect([44, 46].map((o) => view.getInt16(o, true))).toEqual([32767, -32768]);
  });
});
