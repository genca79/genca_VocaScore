// Entry "bravura": include il font musicale incorporato (base64). L'entry "core" lo scaricherebbe
// da CDN, violando il vincolo 100% client-side.
import {
  Renderer,
  Stave,
  StaveNote,
  StaveTie,
  StaveConnector,
  Voice,
  Formatter,
  Accidental,
  Dot,
  Annotation,
  Beam,
  BarlineType,
} from 'vexflow/bravura';
import { midiToNoteName, midiToVexKey } from '../music/noteUtils.js';
import { alignVoices, chooseClef, layoutMeasures, timeSignatureInfo } from '../music/notation.js';

const COLORS = { live: '#e8590c', selected: '#1971c2', playing: '#2f9e44', name: '#1f2328' };
const REST_KEY = { treble: 'b/4', bass: 'd/3' }; // posizione verticale centrale della pausa
const SIDE = 10; // margine orizzontale del rigo
const STAVE_TOP = 40; // spazio sopra il primo rigo (tagli addizionali delle note acute)
const TEMPO_SPACE = 22; // spazio extra per l'indicazione metronomica sul primo sistema
const STAFF_HEIGHT = 175; // un rigo: include lo spazio sotto per note gravi, gambi in giù e nomi delle note
const NAME_WIDTH = 84; // colonna dei nomi delle voci (solo con più voci)
const NAME_MAX_CHARS = 11;

/**
 * Partitura con battute, impaginata su più sistemi che vanno a capo. Ogni sistema ha un rigo per
 * voce (nome a sinistra, voce attiva in grassetto), con le battute allineate verticalmente.
 * Usata sia a schermo (SVG, interattiva) sia per il PDF (canvas ad alta risoluzione).
 *
 * Prestazioni: ogni sistema è un elemento separato, memorizzato con una "chiave" del suo contenuto.
 * A ogni render si ricalcola l'impaginazione (economico) ma si ridisegnano con VexFlow solo i sistemi
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
    this.cache = []; // [{ key, el }] per sistema
    this.autoClefs = new Map(); // id voce → chiave automatica (con isteresi)
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
        if (this.last) this.render(this.last.score, this.last.view);
      });
    }).observe(this.el);
  }

  /**
   * @param {{ settings:object, voices:Array<{ id:string, name:string, clef:string,
   *           notes:Array<{ id:string, midi:number|null, beats:number, live?:boolean }> }>, activeVoiceId?:string }} score
   *   lo ScoreDocument, oppure una sua vista con l'anteprima della registrazione (note `live`)
   * @param {{ selectedId?:string|null, playingIds?:Set<string>, width?:number, followEnd?:boolean,
   *           print?:boolean }} [view] print: niente evidenziazione della voce attiva (PDF)
   */
  render(score, view = {}) {
    this.last = { score, view };
    const { timeSignature, bpm, showNoteNames } = score.settings;
    const voices = alignVoices(score.voices, timeSignature);
    const multi = voices.length > 1;

    const staffs = voices.map((voice) => {
      const measures = layoutMeasures(voice.notes, timeSignature);
      for (const seg of measures.flat()) seg.color = segmentColor(seg, view);
      return {
        name: voice.name,
        active: multi && !view.print && voice.id === score.activeVoiceId,
        clef: this.#resolveClef(voice),
        measures,
      };
    });
    const measureCount = Math.max(...staffs.map((s) => s.measures.length));
    // Larghezza di ogni battuta: la più esigente tra le voci.
    const natural = Array.from({ length: measureCount }, (_, j) =>
      Math.max(...staffs.map((s) => measureWidth(s.measures[j] ?? [], showNoteNames))),
    );

    const width = Math.max(280, view.width ?? this.el.clientWidth);
    const nameWidth = multi ? NAME_WIDTH : 0;
    const systems = packSystems(natural, width - 2 * SIDE - nameWidth);
    const hasNotes = score.voices.some((v) => v.notes.some((n) => !n.live));
    const pending = score.voices.some((v) => v.notes.some((n) => n.live));

    const elements = systems.map((system, index) => {
      const ctx = {
        staffs: staffs.map((s) => ({
          name: s.name,
          active: s.active,
          clef: s.clef,
          measures: system.indices.map((j) => s.measures[j] ?? []),
          // il sistema inizia con un segmento legato a quello precedente → mezza legatura entrante
          tieIn: Boolean(system.indices[0] > 0 && s.measures[system.indices[0] - 1]?.at(-1)?.tieNext),
        })),
        widths: system.widths,
        index,
        width,
        nameWidth,
        timeSignature,
        bpm,
        showNoteNames,
        // barra finale solo a spartito "chiuso" (non mentre si sta registrando)
        finalBar: index === systems.length - 1 && !pending && hasNotes,
      };
      const key = JSON.stringify(ctx);
      if (this.cache[index]?.key === key) return this.cache[index].el;
      const el = this.#renderSystem(ctx);
      this.cache[index] = { key, el };
      return el;
    });
    this.cache.length = systems.length;

    // Aggiorna il DOM solo dove serve (i sistemi invariati restano gli stessi nodi).
    elements.forEach((el, i) => {
      if (this.el.children[i] !== el) this.el.insertBefore(el, this.el.children[i] ?? null);
    });
    while (this.el.children.length > elements.length) this.el.lastElementChild.remove();

    if (view.followEnd) this.el.scrollTop = this.el.scrollHeight;
  }

  #resolveClef(voice) {
    if (voice.clef !== 'auto') return voice.clef;
    const pitches = voice.notes.filter((n) => n.midi !== null).map((n) => n.midi);
    const clef = chooseClef(pitches, this.autoClefs.get(voice.id) ?? 'treble');
    this.autoClefs.set(voice.id, clef);
    return clef;
  }

  #renderSystem({ staffs, widths, index, width, nameWidth, timeSignature, bpm, showNoteNames, finalBar }) {
    const top = STAVE_TOP + (index === 0 ? TEMPO_SPACE : 0);
    const height = top + staffs.length * STAFF_HEIGHT - STAVE_TOP;
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
    const firstStaves = [];

    staffs.forEach((staff, p) => {
      const y = top + p * STAFF_HEIGHT;
      const drawn = []; // { seg, note } in ordine, per legature e selezione
      let x = SIDE + nameWidth;
      staff.measures.forEach((measure, j) => {
        const stave = new Stave(x, y, widths[j]);
        if (j === 0) {
          stave.addClef(staff.clef);
          firstStaves.push(stave);
        }
        if (j === 0 && index === 0) {
          stave.addTimeSignature(timeSignature);
          if (p === 0) stave.setTempo({ duration: 'q', bpm }, -TEMPO_SPACE / 2);
        }
        if (finalBar && j === staff.measures.length - 1) stave.setEndBarType(BarlineType.END);
        stave.setContext(ctx).draw();
        x += widths[j];
        if (measure.length === 0) return;

        const notes = measure.map((seg) => toStaveNote(seg, staff.clef, showNoteNames));
        const voice = new Voice({ numBeats: num, beatValue: den }).setMode(Voice.Mode.SOFT).addTickables(notes);
        // Travature (code unite) raggruppate per movimento secondo l'indicazione di tempo.
        const beams = Beam.generateBeams(notes, { groups: beamGroups });
        new Formatter().joinVoices([voice]).formatToStave([voice], stave);
        voice.draw(ctx, stave);
        beams.forEach((beam) => beam.setContext(ctx).draw());
        measure.forEach((seg, k) => drawn.push({ seg, note: notes[k] }));
      });

      // Legature: tra segmenti consecutivi della stessa nota. Se la legatura attraversa la fine
      // del sistema si disegnano due mezze legature (uscente qui, entrante all'inizio del successivo).
      drawn.forEach(({ seg, note }, i) => {
        if (seg.tieNext) drawTie(ctx, { firstNote: note, lastNote: drawn[i + 1]?.note }, seg.color);
      });
      if (staff.tieIn && drawn[0]) drawTie(ctx, { lastNote: drawn[0].note }, drawn[0].seg.color);

      if (nameWidth > 0) drawVoiceName(ctx, staff, y);

      // Collega gli elementi SVG alle note del documento, per la selezione con il clic.
      if (this.interactive) {
        for (const { seg, note } of drawn) {
          if (seg.live || seg.noteId.endsWith('-pad')) continue;
          div.querySelector(`[id="vf-${note.getAttribute('id')}"]`)?.setAttribute('data-note-id', seg.noteId);
        }
      }
    });

    // Più voci: linea di sistema e parentesi quadra a sinistra, come nelle partiture corali.
    if (firstStaves.length > 1) {
      const [first, last] = [firstStaves[0], firstStaves.at(-1)];
      new StaveConnector(first, last).setType('singleLeft').setContext(ctx).draw();
      new StaveConnector(first, last).setType('bracket').setContext(ctx).draw();
    }
    return div;
  }
}

/** Nome della voce a sinistra del rigo, centrato sulle 5 linee; la voce attiva in grassetto e colorata. */
function drawVoiceName(ctx, staff, y) {
  const label = staff.name.length > NAME_MAX_CHARS ? `${staff.name.slice(0, NAME_MAX_CHARS - 1)}…` : staff.name;
  ctx.save();
  ctx.setFont('Arial', 12, staff.active ? 'bold' : 'normal');
  ctx.setFillStyle(staff.active ? COLORS.selected : COLORS.name);
  ctx.fillText(label, SIDE, y + 44); // il rigo di VexFlow ha la 1ª linea a +40 e l'ultima a +80
  ctx.restore();
}

function segmentColor(seg, { selectedId, playingIds }) {
  if (seg.live) return COLORS.live;
  if (playingIds?.has(seg.noteId)) return COLORS.playing;
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
 * Distribuisce le battute in sistemi che vanno a capo (algoritmo greedy) e le "giustifica",
 * cioè le allarga in proporzione fino a riempire il sistema. L'ultimo sistema viene allargato solo se
 * è già pieno per oltre il 70%, altrimenti poche battute risulterebbero stirate.
 *
 * @param {number[]} natural larghezza naturale di ogni battuta (la massima tra le voci)
 * @param {number} usableWidth
 * @returns {Array<{ indices:number[], widths:number[] }>}
 */
function packSystems(natural, usableWidth) {
  const CLEF_W = 40;
  const TIMESIG_W = 30;
  const systems = [];
  let current = null;

  natural.forEach((base, j) => {
    const isSystemStart = !current;
    const header = CLEF_W + (systems.length === 0 && isSystemStart ? TIMESIG_W : 0);
    let w = base + (isSystemStart ? header : 0);
    if (current && current.total + w > usableWidth) {
      systems.push(current);
      current = null;
      w += CLEF_W;
    }
    current ??= { indices: [], natural: [], total: 0 };
    current.indices.push(j);
    current.natural.push(w);
    current.total += w;
  });
  if (current) systems.push(current);

  return systems.map((system, i) => {
    const isLast = i === systems.length - 1;
    const stretch = !isLast || system.total > usableWidth * 0.7;
    const scale = stretch ? usableWidth / system.total : Math.min(1, usableWidth / system.total);
    return { indices: system.indices, widths: system.natural.map((w) => Math.floor(w * scale)) };
  });
}
