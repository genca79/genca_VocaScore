import * as Tone from 'tone';

/**
 * AudioContext unico per tutta l'app.
 *
 * Tone.js crea un proprio contesto. Se il microfono ne usasse un altro avremmo due clock
 * separati (con deriva tra i due) e due politiche di autoplay da sbloccare. Per questo
 * configuriamo il contesto di Tone e usiamo il suo `rawContext` anche per microfono e AnalyserNode.
 */

let initialized = false;

/**
 * Deve essere chiamata dentro un gesto dell'utente (click): i browser tengono l'audio
 * sospeso finché l'utente non interagisce con la pagina (autoplay policy).
 *
 * @returns {Promise<BaseAudioContext>} il contesto "raw" su cui creare i nodi del microfono
 */
export async function initAudioContext() {
  if (!initialized) {
    Tone.setContext(
      new Tone.Context({
        latencyHint: 'interactive', // buffer di uscita il più piccolo possibile
        // Di default Tone programma gli eventi 100 ms nel futuro (lookAhead), utile per i sequencer
        // ma percepibile come ritardo nel suonare dal vivo. Noi reagiamo all'istante: 0.
        lookAhead: 0,
      }),
    );
    initialized = true;
  }
  await Tone.start(); // resume() del contesto, sbloccato dal gesto dell'utente
  return Tone.getContext().rawContext;
}
