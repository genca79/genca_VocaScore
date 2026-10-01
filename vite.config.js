import { defineConfig } from 'vite';

export default defineConfig({
  // Path relativi: la build in dist/ funziona su qualsiasi hosting statico (anche in sottocartella).
  base: './',
  server: {
    // getUserMedia richiede un "secure context": localhost lo è già, nessun HTTPS necessario in sviluppo.
    host: 'localhost',
    port: 5173,
  },
  test: {
    environment: 'node',
  },
});
