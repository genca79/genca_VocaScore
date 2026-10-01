import { defineConfig } from 'vite';

export default defineConfig({
  // Path relativi: la build in dist/ funziona su qualsiasi hosting statico (anche in sottocartella).
  base: './',
  server: {
    // getUserMedia richiede un "secure context": localhost lo è già, nessun HTTPS necessario in sviluppo.
    host: 'localhost',
    port: 5173,
  },
  // Il worker della rifinitura usa import ES: va compilato come modulo.
  worker: {
    format: 'es',
  },
  build: {
    // Il modulo AudioWorklet (captureProcessor.js) deve restare un file vero: alcuni browser
    // rifiutano i worklet caricati da URL "data:", che Vite userebbe per i file piccoli.
    assetsInlineLimit: (filePath) => (filePath.endsWith('.js') ? false : undefined),
  },
  test: {
    environment: 'node',
  },
});
