/**
 * Parametri regolabili di VocaScore.
 * Tutte le soglie sono raccolte qui per poterle tarare senza toccare la logica dei moduli.
 */
export const CONFIG = {
  audio: {
    // 2048 campioni a 48 kHz ≈ 43 ms di finestra: contiene almeno 2 periodi anche a ~50 Hz,
    // quindi copre tutta l'estensione vocale (basso profondo ~80 Hz).
    fftSize: 2048,
    constraints: {
      echoCancellation: true, // prima difesa contro il Larsen
      noiseSuppression: false, // il denoiser del browser distorce le armoniche e peggiora il pitch tracking
      autoGainControl: false, // l'AGC alza il rumore di fondo nelle pause e renderebbe inutile il noise gate
      channelCount: 1,
    },
  },

  gate: {
    // Gate adattivo: le soglie seguono il rumore di fondo misurato (vedi noiseGate.js).
    openAboveFloorDb: 10, // apre 10 dB sopra il rumore di fondo
    closeAboveFloorDb: 4, // ...e chiude solo sotto +4 dB (isteresi: evita il "chattering")
    minOpenDb: -65, // limiti assoluti della soglia di apertura (dBFS)
    maxOpenDb: -35,
    holdMs: 250, // tempo di tenuta prima della chiusura (copre consonanti e cali tra due vocali)
    floorFallMs: 150, // velocità con cui il floor scende quando la stanza diventa più silenziosa
    floorRiseDbPerSec: 2, // velocità con cui sale (solo a gate chiuso)
  },

  pitch: {
    minHz: 65, // ~C2
    maxHz: 1100, // ~C#6
    peakThreshold: 0.9, // costante k dell'algoritmo MPM (scelta del primo picco "abbastanza alto")
    minClarity: 0.8, // sotto questa chiarezza il segnale non è considerato intonato (rumore, sibilanti)
  },

  // Stima dell'intonazione di chi canta (vedi music/tuning.js)
  tuning: {
    minNotes: 3, // note necessarie prima di correggere
    decay: 0.85, // peso delle note precedenti a ogni nuova nota (segue un cantante che si sposta)
    maxOffset: 0.4, // correzione massima: ±40 cents (oltre, lo scarto è ambiguo di un semitono)
    minCoherence: 0.5, // scarti troppo sparsi → nessuna correzione
    flipGuard: 0.35, // vicino a ±50 cents la stima non cambia direzione (vedi tuning.js)
    ambiguous: 0.45, // oltre ±45 cents la direzione è indecidibile: la stima viene ignorata
  },

  // Rifinitura dopo lo Stop (vedi music/offlineTranscriber.js)
  offline: {
    captureRate: 16000, // l'audio della sessione viene conservato (solo in memoria) a ~16 kHz
    maxMinutes: 10, // oltre, la rifinitura non viene eseguita (memoria)
    inputLatencyMs: 15, // latenza del microfono: l'analisi offline non ha ritardi di elaborazione
  },

  stabilizer: {
    medianWindow: 7, // valori per il filtro mediano
    confirmMs: 80, // stabilità richiesta per confermare una nuova nota
    octaveConfirmMs: 250, // ...e per un salto di esattamente un'ottava (tipico errore del detector)
    hysteresisSemitones: 0.8, // quanto ci si deve allontanare dalla nota corrente per cambiarla
    releaseMs: 180, // silenzio (gate chiuso) prima di chiudere la nota
    unvoicedHoldMs: 400, // gate aperto ma pitch incerto (respiro, consonante): la nota resta viva
    attackMs: 100, // attacco escluso dal calcolo dell'altezza della nota (scivolate d'ingresso)
    dipDb: 6, // sillaba ripetuta: calo di volume minimo rispetto al picco recente…
    riseDb: 4, // …seguito da una risalita di almeno questo…
    maxDipMs: 300, // …entro questo tempo (oltre è una pausa o un diminuendo, non una consonante)
  },

  synth: {
    portamento: 0.03, // glide in secondi tra note legate (solo dal vivo)
    // Valori iniziali dei controlli "Suono" (modificabili dall'interfaccia):
    instrument: 'lead', // vedi output/instruments.js
    octave: 0, // trasposizione in uscita, in ottave
    brightness: 0.8, // 0 = cupo, 1 = brillante
    reverb: 0.15, // 0 = asciutto, 1 = tutto riverbero
    volumeDb: -8,
  },

  score: {
    // BPM, tempo, chiave, griglia e metronomo sono impostazioni del documento (scoreDocument.js).
    // Ritardo con cui la voce viene "vista" rispetto al click del metronomo: latenza del microfono
    // (~10–20 ms) + catena di analisi (~20–25 ms, misurati per attacchi e stacchi; vedi recorder.js).
    inputLatencyMs: 40,
    liveRedrawMs: 100, // frequenza di ridisegno della nota "in corso"
    autosaveMs: 500, // ritardo del salvataggio automatico della bozza
  },
};
