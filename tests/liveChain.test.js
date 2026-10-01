import { describe, expect, it } from 'vitest';
import { detectPitchMPM } from '../src/audio/pitchDetector.js';
import { NoiseGate, computeRms, rmsToDb } from '../src/audio/noiseGate.js';
import { NoteStabilizer } from '../src/music/noteStabilizer.js';
import { TuningEstimator } from '../src/music/tuning.js';
import { hzToMidi } from '../src/music/noteUtils.js';
import { CONFIG } from '../src/config.js';
import {
  synthVoice,
  TEST_MELODY,
  TEST_MELODY_EXPECTED,
  FLAT_SINGER_MELODY,
  FLAT_SINGER_DETUNE,
} from './helpers/synthVoice.js';

const SR = 48000;
const audio = synthVoice(FLAT_SINGER_MELODY, SR, { detune: FLAT_SINGER_DETUNE });
const audioInTune = synthVoice(TEST_MELODY, SR);

/**
 * Riproduce la catena dal vivo di main.js frame per frame (AnalyserNode → gate → MPM →
 * correzione dell'intonazione → stabilizzatore), come farebbe requestAnimationFrame.
 */
function runLive(signal, { tuning = true, fps = 60, withDb = true } = {}) {
  const N = CONFIG.audio.fftSize;
  const hop = Math.round(SR / fps);
  const gate = new NoiseGate(CONFIG.gate);
  const stab = new NoteStabilizer(CONFIG.stabilizer);
  const tuner = new TuningEstimator(CONFIG.tuning);
  const written = [];
  for (let end = N; end <= signal.length; end += hop) {
    const buf = signal.subarray(end - N, end);
    const ms = (end / SR) * 1000;
    const db = rmsToDb(computeRms(buf));
    const open = gate.process(db, ms);
    const offset = tuning ? tuner.offset : 0;
    let midi = null;
    if (open) {
      const r = detectPitchMPM(buf, SR, CONFIG.pitch);
      if (r && r.clarity >= CONFIG.pitch.minClarity) midi = hzToMidi(r.hz) - offset;
    }
    for (const ev of stab.process(midi, ms, open, withDb ? db : null)) {
      if (ev.type !== 'noteOff') continue;
      written.push(ev.midi);
      tuner.observe(ev.center + offset, ev.durationMs / 1000);
    }
  }
  return written;
}

describe('catena dal vivo', () => {
  it('voce intonata: tutte le note, comprese le sillabe ripetute', () => {
    expect(runLive(audioInTune)).toEqual(TEST_MELODY_EXPECTED);
  });

  it('senza il riconoscimento delle sillabe il "la-la-la" diventa una nota sola (confronto)', () => {
    expect(runLive(audioInTune, { withDb: false })).toHaveLength(TEST_MELODY_EXPECTED.length - 2);
  });

  it('cantante calante e incostante: corretto da quando la stima è affidabile', () => {
    const notes = runLive(audio);
    expect(notes).toHaveLength(TEST_MELODY_EXPECTED.length);
    // Le prime note di questo cantante sono vicine a −50 cents (zona ambigua): la stima dal vivo
    // aspetta dati chiari prima di correggere. La rifinitura dopo lo Stop sistema anche le prime.
    expect(notes.slice(-2)).toEqual(TEST_MELODY_EXPECTED.slice(-2));
  });

  it('cantante al limite dell’ambiguità (−47 cents): la stima non peggiora mai la trascrizione', () => {
    const ambiguous = synthVoice(TEST_MELODY, SR, { detune: -0.47 });
    const correct = (notes) => notes.filter((m, i) => m === TEST_MELODY_EXPECTED[i]).length;
    expect(correct(runLive(ambiguous))).toBeGreaterThanOrEqual(correct(runLive(ambiguous, { tuning: false })));
  });

  it('senza stima dell’intonazione lo stesso canto viene trascritto peggio (confronto)', () => {
    const correct = (notes) => notes.filter((m, i) => m === TEST_MELODY_EXPECTED[i]).length;
    expect(correct(runLive(audio, { tuning: false }))).toBeLessThan(correct(runLive(audio)));
  });

  it('anche a 144 fps', () => {
    expect(runLive(audioInTune, { fps: 144 })).toEqual(TEST_MELODY_EXPECTED);
  });
});
