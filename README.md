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
- **Trascrizione precisa**: altezza calcolata sull'intera nota (non sull'attacco) e robusta al
  vibrato, sillabe ripetute sulla stessa nota riconosciute dal volume, intonazione di chi canta
  stimata e compensata, ronzio di fondo (es. 100 Hz di rete) ignorato.
- **Note legate**: una nota cantata staccata viene scritta lunga fino all'attacco successivo se il
  silenzio in mezzo è breve (fino a una croma), invece di diventare nota + pausa. Disattivabile.
- **Rifinitura allo Stop**: l'audio della sessione (solo in memoria, mai salvato né inviato) viene
  rianalizzato per intero in un Web Worker, con algoritmo di Viterbi e contesto completo; il
  risultato sostituisce la trascrizione dal vivo (Ctrl+Z per tornare a quella).
- **Metronomo** con battuta di attacco (click + indicatore visivo).
- **Tempo rilevato automaticamente** a metronomo spento: allo Stop i battiti vengono ricostruiti dagli
  attacchi (programmazione dinamica, segue rallentando e accelerando); i BPM impostati fanno da
  indicazione. Se lo spartito era vuoto, il tempo rilevato diventa il tempo dello spartito.
- **Quantizzazione Auto** (default): allo Stop, per ogni movimento si sceglie la suddivisione
  (intero, metà, quarti) più semplice che rispetta il canto. In alternativa griglia fissa
  1/4, 1/8, 1/16. Durante il canto l'anteprima usa 1/8.
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
Microfono ─┬→ AnalyserNode → [rAF] → NoiseGate → MPM → − intonazione → NoteStabilizer
           │                                                          ├→ SynthEngine (voce live)
           │                                                          └→ Recorder → ScoreDocument
           └→ SessionCapture (AudioWorklet) ──Stop──→ Web Worker (trascrizione offline)
                                                      └→ ScoreDocument.replaceRange (annullabile)

ScoreDocument → ScoreRenderer (+ ScoreEditor) · riascolto · bozza · MusicXML · PDF
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
| `src/music/rhythm.js` | Rilevamento dei battiti, mappa tempo → posizione, quantizzazione automatica |
| `src/music/pitchCenter.js` | Altezza centrale di una nota, robusta al vibrato |
| `src/music/tuning.js` | Stima dell'intonazione di chi canta (media circolare, gestione dell'ambiguità a ±50 cents) |
| `src/music/offlineTranscriber.js` | Trascrizione dell'intera registrazione: MPM, Viterbi, sillabe, intonazione |
| `src/music/offlineWorker.js` · `offlineClient.js` | Esecuzione della rifinitura in un Web Worker |
| `src/audio/captureProcessor.js` · `sessionCapture.js` | Cattura dell'audio della sessione (AudioWorklet, ~16 kHz) |
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
