/**
 * Web Worker della rifinitura: esegue la trascrizione offline fuori dal thread principale,
 * così l'interfaccia resta reattiva anche su registrazioni di alcuni minuti.
 */
import { transcribeOffline } from './offlineTranscriber.js';

self.onmessage = ({ data }) => {
  const { id, samples, sampleRate, options } = data;
  try {
    const result = transcribeOffline(samples, sampleRate, options, (progress) => self.postMessage({ id, progress }));
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message ?? String(err) });
  }
};
