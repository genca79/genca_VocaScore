/**
 * "Carica Audio ALA": trascrizione di una registrazione già esistente (file audio scelto dall'utente).
 *
 * Il file viene letto e decodificato SOLO nel browser (nessun upload), poi passa dalla stessa
 * trascrizione della registrazione dal microfono (offlineTranscriber.js, in un Web Worker) e dallo
 * stesso rilevamento del tempo e della quantizzazione (rhythm.js, writeTranscription) usato a
 * metronomo spento.
 *
 * Formati: quelli che il browser sa decodificare con decodeAudioData. In Chrome/Edge: WAV, MP3,
 * M4A/AAC, OGG (Vorbis e Opus), FLAC, WebM. Firefox e Safari ne supportano un sottoinsieme diverso
 * (es. Safari legge anche AIFF); un formato non supportato produce un messaggio chiaro.
 */

/** Estensioni proposte nella finestra di scelta del file (audio/* copre gli altri tipi riconosciuti). */
export const AUDIO_FILE_ACCEPT = 'audio/*,.wav,.mp3,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm,.weba,.aif,.aiff';

/** Frequenza di analisi: la stessa della registrazione in memoria per la rifinitura. */
export const ANALYSIS_SAMPLE_RATE = 16000;

/** Errore con un messaggio pronto per la UI. */
export class AudioFileError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'AudioFileError';
    this.cause = cause;
  }
}

/**
 * Decodifica un file audio in un segnale mono alla frequenza di analisi.
 *
 * Si usa un OfflineAudioContext alla frequenza di analisi: decodeAudioData ricampiona già al suo
 * sampleRate con il resampler del browser (filtrato, niente aliasing), e non serve sbloccare l'audio
 * con un gesto dell'utente perché non si suona nulla.
 *
 * @param {Blob} file
 * @param {{ sampleRate?:number, maxMinutes?:number }} [options]
 * @returns {Promise<{ samples:Float32Array, sampleRate:number, durationSec:number }>}
 */
export async function decodeAudioFile(file, { sampleRate = ANALYSIS_SAMPLE_RATE, maxMinutes = 10 } = {}) {
  const data = await file.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(data);
  } catch (err) {
    throw new AudioFileError(
      'Formato audio non riconosciuto da questo browser. Prova con WAV, MP3, M4A, OGG o FLAC.',
      err,
    );
  }
  if (buffer.length === 0) throw new AudioFileError('Il file audio è vuoto.');
  if (buffer.duration > maxMinutes * 60) {
    throw new AudioFileError(`Registrazione troppo lunga: il massimo è ${maxMinutes} minuti.`);
  }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  return { samples: toMono(channels), sampleRate: buffer.sampleRate, durationSec: buffer.duration };
}

/**
 * Media dei canali (stereo → mono). Con un canale solo restituisce una copia.
 * @param {Float32Array[]} channels
 */
export function toMono(channels) {
  const length = channels[0]?.length ?? 0;
  const mono = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) mono[i] += channel[i];
  if (channels.length > 1) for (let i = 0; i < length; i++) mono[i] /= channels.length;
  return mono;
}

/** "02 - Ave_Maria.mp3" → "02 - Ave Maria" (titolo proposto se lo spartito non ne ha uno). */
export function titleFromFileName(name) {
  return String(name)
    .replace(/\.[^.]+$/, '')
    .replace(/_+/g, ' ')
    .trim();
}
