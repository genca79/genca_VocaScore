/**
 * Interfaccia verso il Web Worker della rifinitura. Il worker viene creato al primo utilizzo.
 */
let worker = null;
let nextId = 0;

/**
 * @param {Float32Array} samples (viene TRASFERITO al worker: dopo la chiamata non è più utilizzabile)
 * @param {number} sampleRate
 * @param {object} [options] vedi OFFLINE_DEFAULTS
 * @param {(fraction:number) => void} [onProgress]
 * @returns {Promise<ReturnType<typeof import('./offlineTranscriber.js').transcribeOffline>>}
 */
export function transcribeInWorker(samples, sampleRate, options = {}, onProgress = null) {
  worker ??= new Worker(new URL('./offlineWorker.js', import.meta.url), { type: 'module' });
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const onMessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.progress !== undefined) {
        onProgress?.(data.progress);
        return;
      }
      worker.removeEventListener('message', onMessage);
      if (data.error) reject(new Error(data.error));
      else resolve(data.result);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, samples, sampleRate, options }, [samples.buffer]);
  });
}
