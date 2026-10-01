# GENCA VocaScore

Dalla voce allo spartito e a uno strumento virtuale in tempo reale, **100% nel browser**:
nessun server, nessuna API cloud, nessun audio che lascia il dispositivo.

## Avvio

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # test unitari
npm run build    # build statica in dist/ (richiede HTTPS in produzione per il microfono)
```

## Funzioni

- **Trascrizione dal vivo**: canta e le note compaiono sul pentagramma, con battute, legature e alterazioni.
- **Modifica**: clicca una nota e cambiane altezza, durata, punto; trasformala in pausa, duplicala, eliminala.
  Tutto è annullabile (Ctrl+Z / Ctrl+Y).
- **BPM e tempo** (2/4, 3/4, 4/4, 6/8), chiave automatica o fissa, nomi delle note opzionali.
- **Metronomo** con battuta di attacco (click + indicatore visivo) e **quantizzazione** a griglia
  (1/4, 1/8, 1/16): inizio e fine di ogni nota sono agganciati alla griglia del tempo, quindi gli
  errori non si accumulano e il canto resta allineato alle battute.
- **Riascolto** con 8 strumenti sintetizzati, dall'inizio o dalla nota selezionata.
- **Salva / Apri** file `.vocascore.json`; bozza salvata automaticamente nel browser.
- **MusicXML**: esportazione per MuseScore, Finale, Sibelius, Dorico.
- **PDF** con titolo e pentagrammi (A4, generato nel browser con jsPDF, caricato solo al primo uso).
- **Synth mentre canti**: solo su scelta esplicita ("Suona synth mentre canti (solo con cuffie)"),
  con avviso se l'uscita audio sembra sugli altoparlanti.

### Tastiera

| Tasto | Azione |
|---|---|
| ← → | seleziona nota precedente / successiva |
| ↑ ↓ | semitono su / giù — con Shift: ottava |
| 1 2 3 4 5 | semicroma, croma, semiminima, minima, semibreve |
| . | punto di valore |
| R | nota ↔ pausa |
| D | duplica |
| Canc | elimina |
| Esc | deseleziona |
| Ctrl+Z / Ctrl+Y | annulla / ripeti |

## Architettura

```
Microfono → AnalyserNode → [rAF] → NoiseGate → MPM → hzToNote → NoteStabilizer
                                                                ├→ SynthEngine (voce live, filtrata da FeedbackGuard)
                                                                └→ Recorder → ScoreDocument ─┬→ ScoreRenderer (+ ScoreEditor)
                                                                                             ├→ SynthEngine (riascolto)
                                                                                             ├→ salvataggio / bozza
                                                                                             ├→ MusicXML
                                                                                             └→ PDF
```

| Modulo | Ruolo |
|---|---|
| `src/audio/audioContext.js` | AudioContext unico condiviso con Tone.js (`lookAhead: 0`) |
| `src/audio/audioInput.js` | Permessi microfono, vincoli DSP, errori, ciclo di vita |
| `src/audio/noiseGate.js` | RMS → dBFS, gate adattivo con isteresi e hold |
| `src/audio/pitchDetector.js` | Algoritmo McLeod (MPM) + loop rAF |
| `src/audio/feedbackGuard.js` | Anti-Larsen: euristica cuffie + interruttore manuale |
| `src/music/noteUtils.js` | Hz ↔ MIDI ↔ nome nota, cents |
| `src/music/noteStabilizer.js` | Mediano + isteresi + conferma → eventi noteOn/noteOff |
| `src/music/notation.js` | Quantizzazione, figure, impaginazione in battute, alterazioni, chiave |
| `src/music/scoreDocument.js` | Documento (impostazioni + note in beats), annulla/ripeti, formato file |
| `src/music/recorder.js` | Eventi della voce → note e pause, quantizzate su griglia assoluta |
| `src/output/metronome.js` | Metronomo con count-in, schedulato sull'orologio audio |
| `src/output/instruments.js` | 8 strumenti in sintesi pura (nessun campione da scaricare) |
| `src/output/synth.js` | Motore sonoro: voce live + voce di riascolto, filtro, riverbero, limiter |
| `src/output/scoreRenderer.js` | Pentagramma VexFlow su più righi, con cache per rigo |
| `src/output/pdfExporter.js` | PDF A4: titolo + righi disegnati su canvas a 3× |
| `src/music/musicxml.js` | Esportazione MusicXML 4.0 |
| `src/storage/fileStorage.js` | Salva / apri file (File System Access API o download), bozza automatica |
| `src/ui/*.js` | Controlli, editor, impostazioni del documento |
| `src/config.js` | Tutte le soglie regolabili |

## Note

- Il synth live è **muto** finché l'utente non lo attiva esplicitamente (con le cuffie).
- Il riascolto spegne il microfono e suona anche dagli altoparlanti (senza microfono non c'è Larsen).
- Le note sono salvate in movimenti (♩ = 1): i BPM in uso **durante la registrazione** determinano
  la quantizzazione; cambiarli dopo modifica solo la velocità di riascolto. Il BPM si riferisce sempre alla semiminima.
- Le impostazioni del suono e la bozza dello spartito sono ricordate nel browser (localStorage).
- Il bundle (~450 kB gzip) include il font musicale Bravura incorporato: nessun download da CDN.
