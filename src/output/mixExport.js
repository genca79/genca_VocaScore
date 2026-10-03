import * as Tone from 'tone';
import { SynthEngine } from './synth.js';

/** Coda dopo l'ultima nota: rilascio degli strumenti e riverbero (decay 2,8 s). */
const TAIL_SEC = 3;

/**
 * Esporta il mix come lo si sente con "Ascolta": stesse voci (originali e synth), Muto/Solo,
 * strumenti, brillantezza, riverbero e volume. Il rendering avviene in un OfflineAudioContext
 * (Tone.Offline): più veloce del tempo reale e senza suonare nulla dagli altoparlanti.
 *
 * @param {{ events:Array<object>, clips:Array<object>, sound:object, sampleRate?:number }} mix
 *   events e clips come per SynthEngine.play (le clip con il loro AudioBuffer); sound = impostazioni
 *   del suono (strumento generale, ottava, brillantezza, riverbero, volume)
 * @returns {Promise<AudioBuffer>} stereo
 */
export async function renderMix({ events, clips, sound, sampleRate = 44100 }) {
  const end = Math.max(0, ...events.map((ev) => ev.time + ev.duration), ...clips.map((c) => c.at + c.to));
  const rendered = await Tone.Offline(
    async () => {
      // Dentro Tone.Offline ogni nodo creato appartiene al contesto offline (anche il Transport).
      const engine = new SynthEngine(sound);
      await engine.reverb.ready; // il riverbero genera la sua risposta all'impulso in modo asincrono
      engine.play(events, { clips, autoStop: false });
    },
    end + TAIL_SEC,
    2,
    sampleRate,
  );
  return rendered.get();
}
