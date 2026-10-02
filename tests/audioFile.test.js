import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANALYSIS_SAMPLE_RATE, AudioFileError, decodeAudioFile, titleFromFileName, toMono } from '../src/music/audioFile.js';
import { writeTranscription } from '../src/music/rhythm.js';
import { restToCompleteMeasure } from '../src/music/recorder.js';
import { transcribeOffline } from '../src/music/offlineTranscriber.js';
import { synthVoice } from './helpers/synthVoice.js';

describe('toMono', () => {
  it('stereo: media dei due canali', () => {
    expect([...toMono([Float32Array.from([1, 0.5]), Float32Array.from([0, -0.5])])]).toEqual([0.5, 0]);
  });

  it('mono: copia invariata', () => {
    const ch = Float32Array.from([0.25, -0.75]);
    const mono = toMono([ch]);
    expect([...mono]).toEqual([...ch]);
    expect(mono).not.toBe(ch);
  });
});

describe('titleFromFileName', () => {
  it('toglie l’estensione e i trattini bassi', () => {
    expect(titleFromFileName('02 - Ave_Maria.mp3')).toBe('02 - Ave Maria');
    expect(titleFromFileName('scala.do.maggiore.wav')).toBe('scala.do.maggiore');
  });
});

describe('restToCompleteMeasure', () => {
  it('completa l’ultima battuta', () => {
    expect(restToCompleteMeasure([{ beats: 1 }, { beats: 2 }], '4/4')).toBe(1);
    expect(restToCompleteMeasure([{ beats: 4 }], '4/4')).toBe(0);
    expect(restToCompleteMeasure([], '3/4')).toBe(0);
  });
});

describe('writeTranscription (trascrizione di una registrazione, senza metronomo)', () => {
  it('melodia cantata a 100 BPM (spartito impostato a 90): altezze, ritmo e tempo rilevato', () => {
    const SR = ANALYSIS_SAMPLE_RATE;
    const beat = 60 / 100;
    const rhythm = [1, 1, 0.5, 0.5, 1, 2, 1, 1, 2];
    const pitches = [60, 62, 64, 65, 67, 65, 64, 62, 60];
    let pos = 0;
    const melody = rhythm.map((d, i) => {
      // la voce stacca un po' prima della nota successiva (respiro, articolazione)
      const note = { midi: pitches[i], start: 0.5 + pos * beat, end: 0.5 + (pos + d) * beat - 0.08, vibrato: 0.25 };
      pos += d;
      return note;
    });
    const result = transcribeOffline(synthVoice(melody, SR, { breath: 0.03 }), SR);
    const settings = { bpm: 90, grid: 'auto', timeSignature: '4/4', legato: true };
    const { written, detectedBpm } = writeTranscription(result.notes, { settings });

    expect(Math.round(detectedBpm)).toBeGreaterThanOrEqual(97);
    expect(Math.round(detectedBpm)).toBeLessThanOrEqual(103);
    const notes = written.filter((n) => n.midi !== null);
    expect(notes.map((n) => n.midi)).toEqual(pitches);
    // l'ultima nota non ha una successiva che ne fissi la fine: si confrontano le altre
    expect(notes.slice(0, -1).map((n) => n.beats)).toEqual(rhythm.slice(0, -1));
  });
});

describe('decodeAudioFile', () => {
  /**
   * Il decoder vero esiste solo nel browser: qui un OfflineAudioContext finto verifica la logica
   * attorno (frequenza richiesta, mono, limiti, messaggi). I formati reali vanno provati nel browser.
   */
  function fakeContext({ channels = [], sampleRate = ANALYSIS_SAMPLE_RATE, fail = false } = {}) {
    const created = [];
    class FakeOfflineAudioContext {
      constructor(numberOfChannels, length, rate) {
        created.push(rate);
      }
      async decodeAudioData() {
        if (fail) throw new DOMException('Unable to decode audio data', 'EncodingError');
        const length = channels[0]?.length ?? 0;
        return {
          length,
          sampleRate,
          duration: length / sampleRate,
          numberOfChannels: channels.length,
          getChannelData: (c) => channels[c],
        };
      }
    }
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
    return created;
  }
  const file = { arrayBuffer: async () => new ArrayBuffer(8) };

  afterEach(() => vi.unstubAllGlobals());

  it('decodifica alla frequenza di analisi e riduce a mono', async () => {
    const created = fakeContext({ channels: [Float32Array.from([1, 1]), Float32Array.from([0, -1])] });
    const audio = await decodeAudioFile(file);
    expect(created).toEqual([ANALYSIS_SAMPLE_RATE]); // il browser ricampiona al sampleRate del contesto
    expect([...audio.samples]).toEqual([0.5, 0]);
    expect(audio.sampleRate).toBe(ANALYSIS_SAMPLE_RATE);
  });

  it('formato non supportato: messaggio comprensibile', async () => {
    fakeContext({ fail: true });
    await expect(decodeAudioFile(file)).rejects.toThrow(AudioFileError);
    await expect(decodeAudioFile(file)).rejects.toThrow(/Formato audio non riconosciuto/);
  });

  it('registrazione oltre il limite: rifiutata', async () => {
    fakeContext({ channels: [new Float32Array(ANALYSIS_SAMPLE_RATE * 61)] });
    await expect(decodeAudioFile(file, { maxMinutes: 1 })).rejects.toThrow(/massimo è 1 minuti/);
  });

  it('file vuoto: rifiutato', async () => {
    fakeContext({ channels: [new Float32Array(0)] });
    await expect(decodeAudioFile(file)).rejects.toThrow(/vuoto/);
  });
});
