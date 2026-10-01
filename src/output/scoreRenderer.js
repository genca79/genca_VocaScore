// Entry "bravura": include il font musicale incorporato (base64). L'entry "core" lo scaricherebbe
// da CDN, violando il vincolo 100% client-side.
import {
  Renderer,
  Stave,
  StaveNote,
  StaveTie,
  Voice,
  Formatter,
  Accidental,
  Dot,
  Annotation,
  Beam,
  BarlineType,
} from 'vexflow/bravura';
import { midiToNoteName, midiToVexKey } from '../music/noteUtils.js';
import { chooseClef, layoutMeasures, timeSignatureInfo } from '../music/notation.js';

const COLORS = { live: '#e8590c', selected: '#1971c2', playing: '#2f9e44' };
const REST_KEY = { treble: 'b/4', bass: 'd/3' }; // posizione verticale centrale della pausa
const SIDE = 10; // margine orizzontale del rigo
const STAVE_TOP = 40; // spazio sopra il rigo (tagli addizionali delle note acute)
const TEMPO_SPACE = 22; // spazio extra per l'indicazione metronomica sul primo rigo
const SYSTEM_HEIGHT = 175; // include lo spazio sotto il rigo per note gravi, gambi in giù e nomi delle note

/**
 * Pentagramma completo con battute, impaginato su più righi (sistemi) che vanno a capo.
 * Usato sia a schermo (SVG, interattivo) sia per il PDF (canvas ad alta risoluzione).
 *
 * Prestazioni: ogni rigo è un SVG separato e memorizzato con una "chiave" del suo contenuto.
 * A ogni render si ricalcola l'impaginazione (economico) ma si ridisegnano con VexFlow solo i righi
 * cambiati: mentre si canta, di solito solo l'ultimo.
 */
export class ScoreRenderer {
  /**
   * @param {HTMLElement} container
   * @param {{ interactive?:boolean, onSelect?:(id:string|null) => void,
   *           backend?:'svg'|'canvas', pixelRatio?:number }} [options]
   *   backend 'canvas' + pixelRatio alto: immagini nitide per l'esportazione PDF.
   */
  constructor(container, { interactive = false, onSelect = null, backend = 'svg', pixelRatio = 1 } = {}) {
    this.el = container;
    this.interactive = interactive && backend === 'svg';
    this.onSelect = onSelect;
    this.backend = backend;
    this.pixelRatio = pixelRatio;
    this.cache = []; // [{ key, el }] per rigo
    this.autoClef = 'treble';
    this.last = null;

    if (this.interactive) {
      container.addEventListener('click', (e) => {
        const target = e.target.closest('[data-note-id]');
        this.onSelect?.(target ? target.dataset.noteId : null);
      });
    }
  }

  /** Il font musicale viene registrato in modo asincrono all'import: va atteso prima del primo render. */
  static async loadFonts() {
    await document.fonts.load('30px Bravura');
  }

  /** Ridisegna quando cambia la larghezza del contenitore (solo per la vista a schermo). */
  observeResize() {
    let scheduled = false;
    let lastWidth = this.el.clientWidth;
    new ResizeObserver(() => {
      if (scheduled || this.el.clientWidth === lastWidth) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        lastWidth = this.el.clientWidth;
        if (this.last) this.render(this.last.doc, this.last.view);
      });
    }).observe(this.el);
  }

  /**
   * @param {import('../music/scoreDocument.js').ScoreDocument} doc
   * @param {{ pending?:{ midi:number, beats:number }|null, selectedId?:string|null, playingId?:string|null,
   *           width?:number, followEnd?:boolean }} [view]
   */
  render(doc, view = {}) {
    this.last = { doc, view };
    const { timeSignature, bpm, showNoteNames } = doc.settings;
    const notes = view.pending ? [...doc.notes, { id: 'live', live: true, ...view.pending }] : doc.notes;

    const clef = this.#resolveClef(doc.settings.clef, notes);
    const measures = layoutMeasures(notes, timeSignature);
    for (const seg of measures.flat()) seg.color = segmentColor(seg, view);

    const width = Math.max(280, view.width ?? this.el.clientWidth);
    const systems = packSystems(measures, width - 2 * SIDE, showNoteNames);

    const elements = systems.map((system, index) => {
      const ctx = {
        system,
        index,
        width,
        clef,
        timeSignature,
        bpm,
        showNoteNames,
        isLast: index === systems.length - 1,
        // barra finale solo a spartito "chiuso" (non mentre si sta cantando una nota)
        finalBar: index === systems.length - 1 && !view.pending && doc.notes.length > 0,
      };
      const key = JSON.stringify(ctx);
      if (this.cache[index]?.key === key) return this.cache[index].el;
      const el = this.#renderSystem(ctx);
      this.cache[index] = { key, el };
      return el;
    });
    this.cache.length = systems.length;

    // Aggiorna il DOM solo dove serve (i righi invariati restano gli stessi nodi).
    elements.forEach((el, i) => {
      if (this.el.children[i] !== el) this.el.insertBefore(el, this.el.children[i] ?? null);
    });
    while (this.el.children.length > elements.length) this.el.lastElementChild.remove();

    if (view.followEnd) this.el.scrollTop = this.el.scrollHeight;
  }

  #resolveClef(setting, notes) {
    if (setting !== 'auto') return setting;
    const pitches = notes.filter((n) => n.midi !== null).map((n) => n.midi);
    this.autoClef = chooseClef(pitches, this.autoClef);
    return this.autoClef;
  }

  #renderSystem({ system, index, width, clef, timeSignature, bpm, showNoteNames, finalBar }) {
    const top = STAVE_TOP + (index === 0 ? TEMPO_SPACE : 0);
    const height = SYSTEM_HEIGHT + (index === 0 ? TEMPO_SPACE : 0);
    let div;
    let ctx;
    if (this.backend === 'canvas') {
      div = document.createElement('canvas');
      ctx = new Renderer(div, Renderer.Backends.CANVAS).getContext();
      ctx.resize(width, height, this.pixelRatio); // pixelRatio 3 ≈ 300 dpi su A4
      ctx.setFillStyle('#fff').fillRect(0, 0, width, height).setFillStyle('#000'); // sfondo bianco (no trasparenza)
    } else {
      div = document.createElement('div');
      const renderer = new Renderer(div, Renderer.Backends.SVG);
      renderer.resize(width, height);
      ctx = renderer.getContext();
    }
    div.className = 'score-system';
    const { num, den } = timeSignatureInfo(timeSignature);
    const beamGroups = Beam.getDefaultBeamGroups(timeSignature);

    const drawn = []; // { seg, note } in ordine, per legature e selezione
    let x = SIDE;
    system.measures.forEach((measure, j) => {
      const stave = new Stave(x, top, system.widths[j]);
      if (j === 0) stave.addClef(clef);
      if (j === 0 && index === 0) {
        stave.addTimeSignature(timeSignature);
        stave.setTempo({ duration: 'q', bpm }, -TEMPO_SPACE / 2);
      }
      if (finalBar && j === system.measures.length - 1) stave.setEndBarType(BarlineType.END);
      stave.setContext(ctx).draw();
      x += system.widths[j];
      if (measure.length === 0) return;

      const notes = measure.map((seg) => toStaveNote(seg, clef, showNoteNames));
      const voice = new Voice({ numBeats: num, beatValue: den }).setMode(Voice.Mode.SOFT).addTickables(notes);
      // Travature (code unite) raggruppate per movimento secondo l'indicazione di tempo.
      const beams = Beam.generateBeams(notes, { groups: beamGroups });
      new Formatter().joinVoices([voice]).formatToStave([voice], stave);
      voice.draw(ctx, stave);
      beams.forEach((beam) => beam.setContext(ctx).draw());
      measure.forEach((seg, k) => drawn.push({ seg, note: notes[k] }));
    });

    // Legature: tra segmenti consecutivi della stessa nota. Se la legatura attraversa la fine
    // del rigo si disegnano due mezze legature (uscente qui, entrante all'inizio del rigo successivo).
    drawn.forEach(({ seg, note }, i) => {
      const next = drawn[i + 1];
      if (seg.tieNext) drawTie(ctx, { firstNote: note, lastNote: next?.note }, seg.color);
    });
    if (system.tieIn && drawn[0]) drawTie(ctx, { lastNote: drawn[0].note }, drawn[0].seg.color);

    // Collega gli elementi SVG alle note del documento, per la selezione con il clic.
    if (this.interactive) {
      for (const { seg, note } of drawn) {
        if (seg.live) continue;
        div.querySelector(`[id="vf-${note.getAttribute('id')}"]`)?.setAttribute('data-note-id', seg.noteId);
      }
    }
    return div;
  }
}

function segmentColor(seg, { selectedId, playingId }) {
  if (seg.live) return COLORS.live;
  if (seg.noteId === playingId) return COLORS.playing;
  if (seg.noteId === selectedId) return COLORS.selected;
  return null;
}

function toStaveNote(seg, clef, showNoteNames) {
  let note;
  if (seg.midi === null) {
    note = new StaveNote({ keys: [REST_KEY[clef]], duration: `${seg.duration}r`, dots: seg.dots, clef });
  } else {
    const { key } = midiToVexKey(seg.midi);
    note = new StaveNote({ keys: [key], duration: seg.duration, dots: seg.dots, clef, autoStem: true });
    if (seg.accidental) note.addModifier(new Accidental(seg.accidental), 0);
    if (seg.first && showNoteNames) {
      note.addModifier(
        new Annotation(midiToNoteName(seg.midi))
          .setFont('Arial', 10)
          .setVerticalJustification(Annotation.VerticalJustify.BOTTOM),
        0,
      );
    }
  }
  if (seg.dots) Dot.buildAndAttach([note], { all: true });
  if (seg.color) note.setStyle({ fillStyle: seg.color, strokeStyle: seg.color });
  return note;
}

function drawTie(ctx, { firstNote, lastNote }, color) {
  const tie = new StaveTie({
    firstNote,
    lastNote,
    firstIndexes: firstNote ? [0] : undefined,
    lastIndexes: lastNote ? [0] : undefined,
  });
  if (color) tie.setStyle({ fillStyle: color, strokeStyle: color });
  tie.setContext(ctx).draw();
}

/**
 * Larghezza "naturale" stimata di una battuta, in base al contenuto.
 * Non serve precisione: il Formatter di VexFlow distribuisce poi le note nello spazio assegnato.
 */
function measureWidth(measure, showNoteNames) {
  let w = 30;
  for (const seg of measure) {
    w += seg.duration === 'w' ? 44 : seg.duration === 'h' ? 36 : 28;
    if (seg.accidental) w += 12;
    if (seg.dots) w += 8;
    if (showNoteNames && seg.first && seg.midi !== null) w += 6;
  }
  return w;
}

/**
 * Distribuisce le battute in righi che vanno a capo (algoritmo greedy) e le "giustifica",
 * cioè le allarga in proporzione fino a riempire il rigo. L'ultimo rigo viene allargato solo se
 * è già pieno per oltre il 70%, altrimenti poche battute risulterebbero stirate.
 */
function packSystems(measures, usableWidth, showNoteNames) {
  const CLEF_W = 40;
  const TIMESIG_W = 30;
  const systems = [];
  let current = null;

  measures.forEach((measure, i) => {
    const isSystemStart = !current;
    const header = CLEF_W + (systems.length === 0 && isSystemStart ? TIMESIG_W : 0);
    let w = measureWidth(measure, showNoteNames) + (isSystemStart ? header : 0);
    if (current && current.total + w > usableWidth) {
      systems.push(current);
      current = null;
      w += CLEF_W;
    }
    if (!current) {
      // il rigo inizia con un segmento legato a quello precedente → mezza legatura entrante
      const prevSeg = measures[i - 1]?.at(-1);
      current = { measures: [], natural: [], total: 0, tieIn: Boolean(prevSeg?.tieNext) };
    }
    current.measures.push(measure);
    current.natural.push(w);
    current.total += w;
  });
  if (current) systems.push(current);

  systems.forEach((system, i) => {
    const isLast = i === systems.length - 1;
    const stretch = !isLast || system.total > usableWidth * 0.7;
    const scale = stretch ? usableWidth / system.total : Math.min(1, usableWidth / system.total);
    system.widths = system.natural.map((w) => Math.floor(w * scale));
    delete system.natural;
    delete system.total;
  });
  return systems;
}
