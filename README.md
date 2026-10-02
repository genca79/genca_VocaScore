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

- **Trascrizione dal vivo**: canta e le note compaiono sul pentagramma (in arancione, circa 1 s dopo),
  con battute, legature e alterazioni. È la stessa analisi di "Carica Audio ALA", rieseguita ogni
  ~0,5 s sugli ultimi 12 s di audio: le note più recenti possono ancora cambiare finché c'è abbastanza
  contesto dopo di loro. Nota rilevata, accordatore e synth restano istantanei.
- **Partitura a più voci** (fino a 8): ogni voce ha un nome scelto da te, la sua chiave e un rigo
  proprio; i righi di un sistema sono uniti e le battute allineate. Nel pannello "Voci" scegli la voce
  attiva (dove registri e cosa modifichi), rinomini, aggiungi ed elimini voci.
  - **Cantando una voce alla volta**: rendi attiva la voce e registra. Se ci sono già altre voci il
    metronomo è sempre attivo e, con "Ascolta le altre voci mentre canti (solo con cuffie)", le senti
    insieme al click, dal punto in cui scrivi. Se l'uscita risulta sugli altoparlanti non vengono
    suonate (finirebbero nel microfono).
  - **Caricando più file insieme** con "Carica Audio ALA": una voce per file, col nome del file. I file
    sono considerati tracce della stessa esecuzione: partono insieme, e il tempo è rilevato su tutte.
- **Riascolto in polifonia**: tutte le voci insieme, ognuna con il suo strumento (o quello generale),
  con Muto e Solo per voce.
- **Modifica**: clicca una nota e cambiane altezza, durata, punto; trasformala in pausa, duplicala, eliminala.
  Tutto è annullabile (Ctrl+Z / Ctrl+Y).
- **BPM e tempo** (2/4, 3/4, 4/4, 6/8), chiave automatica o fissa per voce, nomi delle note opzionali.
- **Trascrizione precisa**: altezza calcolata sull'intera nota (non sull'attacco) e robusta al
  vibrato, sillabe ripetute sulla stessa nota riconosciute dal volume, intonazione di chi canta
  stimata e compensata, ronzio di fondo (es. 100 Hz di rete) ignorato, voce soffiata o microfono
  rumoroso tollerati (passa-basso prima del rilevamento dell'altezza), entrate "da fuori" (attacco
  fino a 2 semitoni sopra o sotto per 100–200 ms) che non diventano note in più.
- **Note legate**: una nota cantata staccata viene scritta lunga fino all'attacco successivo se il
  silenzio in mezzo è breve (fino a una croma), invece di diventare nota + pausa. Disattivabile.
- **Allo Stop** la registrazione entra nello spartito in un solo passo (Ctrl+Z la annulla tutta).
  Con "Rifinisci allo Stop" (default) l'audio della sessione (solo in memoria, mai salvato né inviato)
  viene rianalizzato per intero, esattamente come un file caricato; spento, si tiene la trascrizione
  fatta durante il canto.
- **Carica Audio ALA**: trascrive una registrazione già fatta. Il file viene decodificato nel browser
  (nessun upload) e passa dalla stessa analisi della rifinitura, con tempo rilevato e quantizzazione;
  le note si aggiungono in coda allo spartito (Ctrl+Z per annullare). Formati: quelli che il browser
  sa decodificare; in Chrome/Edge WAV, MP3, M4A/AAC, OGG/Opus, FLAC, WebM. Massimo 10 minuti.
- **Metronomo** con battuta di attacco (click + indicatore visivo).
- **Tempo rilevato automaticamente** a metronomo spento: i battiti vengono ricostruiti dagli
  attacchi (programmazione dinamica, segue rallentando e accelerando); i BPM impostati fanno da
  indicazione. Se lo spartito era vuoto, il tempo rilevato diventa il tempo dello spartito.
- **Quantizzazione Auto** (default): per ogni movimento si sceglie la suddivisione
  (intero, metà, quarti) più semplice che rispetta il canto. In alternativa griglia fissa
  1/4, 1/8, 1/16.
- **Riascolto** con 8 strumenti sintetizzati, dall'inizio o dalla nota selezionata.
- **Salva / Apri** file `.vocascore.json` (versione 2, con le voci; i file della versione 1 si aprono
  come partitura a una voce); bozza salvata automaticamente nel browser.
- **MusicXML**: esportazione per MuseScore, Finale, Sibelius, Dorico (una parte per voce).
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
Microfono ─┬→ AnalyserNode → [rAF] → NoiseGate → passa-basso → MPM → − intonazione → NoteStabilizer
           │                    (istantaneo: nota rilevata, accordatore)            └→ SynthEngine (voce live)
           └→ SessionCapture (AudioWorklet, in memoria)
                ├─ ogni 0,5 s → Web Worker (trascrizione) → LiveTranscriber → anteprima sul pentagramma
                └─ allo Stop  → Web Worker (intera registrazione) → ScoreDocument.replaceRange (annullabile)

File audio (Carica Audio ALA) → Web Worker (stessa trascrizione) → ScoreDocument.replaceRange
ScoreDocument → ScoreRenderer (+ ScoreEditor) · riascolto · bozza · MusicXML · PDF
```

| Modulo | Ruolo |
|---|---|
| `src/audio/audioContext.js` | AudioContext unico condiviso con Tone.js (`lookAhead: 0`) |
| `src/audio/audioInput.js` | Permessi microfono, vincoli DSP, errori, ciclo di vita |
| `src/audio/noiseGate.js` | RMS → dBFS, gate adattivo con isteresi e hold |
| `src/audio/pitchDetector.js` | Algoritmo McLeod (MPM) + loop rAF |
| `src/audio/lowpass.js` | Passa-basso prima di MPM: respiro, sibilanti e fruscio non fanno perdere note |
| `src/audio/feedbackGuard.js` | Anti-Larsen: euristica cuffie + interruttore manuale |
| `src/music/noteUtils.js` | Hz ↔ MIDI ↔ nome nota, cents |
| `src/music/noteStabilizer.js` | Mediano + isteresi + conferma → eventi noteOn/noteOff (synth live) |
| `src/music/notation.js` | Quantizzazione, figure, impaginazione in battute, alterazioni, chiave |
| `src/music/scoreDocument.js` | Documento (impostazioni + voci con note in beats), annulla/ripeti, mixer, formato file |
| `src/music/recorder.js` | Note con tempi → note e pause su griglia assoluta (usato da rhythm.js) |
| `src/music/rhythm.js` | Rilevamento dei battiti, mappa tempo → posizione, quantizzazione automatica |
| `src/music/pitchCenter.js` | Altezza centrale di una nota, robusta al vibrato |
| `src/music/tuning.js` | Stima dell'intonazione di chi canta (media circolare, gestione dell'ambiguità a ±50 cents) |
| `src/music/offlineTranscriber.js` | Trascrizione dell'intera registrazione: MPM, Viterbi, sillabe, intonazione |
| `src/music/liveTranscriber.js` | Trascrizione dal vivo: stessa analisi sugli ultimi 12 s, note definitive oltre |
| `src/music/offlineWorker.js` · `offlineClient.js` | Esecuzione della trascrizione in un Web Worker |
| `src/music/audioFile.js` | Carica Audio ALA: decodifica di un file audio (mono, 16 kHz) e trascrizione |
| `src/audio/captureProcessor.js` · `sessionCapture.js` | Cattura dell'audio della sessione (AudioWorklet, ~16 kHz) |
| `src/output/metronome.js` | Metronomo con count-in, schedulato sull'orologio audio |
| `src/output/instruments.js` | 8 strumenti in sintesi pura (nessun campione da scaricare) |
| `src/output/synth.js` | Motore sonoro: voce live + riascolto polifonico (un'istanza per voce), filtro, riverbero, limiter |
| `src/output/scoreRenderer.js` | Partitura VexFlow: un rigo per voce, sistemi che vanno a capo, cache per sistema |
| `src/output/pdfExporter.js` | PDF A4: titolo + righi disegnati su canvas a 3× |
| `src/music/musicxml.js` | Esportazione MusicXML 4.0 |
| `src/storage/fileStorage.js` | Salva / apri file (File System Access API o download), bozza automatica |
| `src/ui/voicePanel.js` | Pannello "Voci": voce attiva, nome, chiave, strumento, Muto/Solo, aggiungi/elimina |
| `src/ui/*.js` | Controlli, editor, impostazioni del documento |
| `src/config.js` | Tutte le soglie regolabili |

## Note

- Il synth live è **muto** finché l'utente non lo attiva esplicitamente (con le cuffie).
- Il riascolto spegne il microfono e suona anche dagli altoparlanti (senza microfono non c'è Larsen).
- Le note sono salvate in movimenti (♩ = 1): i BPM in uso **durante la registrazione** determinano
  la quantizzazione; cambiarli dopo modifica solo la velocità di riascolto. Il BPM si riferisce sempre alla semiminima.
- Le impostazioni del suono e la bozza dello spartito sono ricordate nel browser (localStorage).
- Il bundle (~450 kB gzip) include il font musicale Bravura incorporato: nessun download da CDN.
