/**
 * Modifica dello spartito: selezione di una nota e azioni (altezza, durata, punto, pausa,
 * duplica, elimina, annulla/ripeti) da barra strumenti o tastiera.
 *
 * Tutte le modifiche passano dallo ScoreDocument, quindi sono annullabili.
 */

/** Figure selezionabili dalla barra: beats della figura base (senza punto). */
const FIGURE_KEYS = { 1: 0.25, 2: 0.5, 3: 1, 4: 2, 5: 4 };
const DOTTABLE = new Set([0.5, 1, 2]); // croma, semiminima, minima (la semicroma puntata è fuori griglia)
const DOTTED = new Set([0.75, 1.5, 3]);

export class ScoreEditor {
  /**
   * @param {import('../music/scoreDocument.js').ScoreDocument} doc
   * @param {{ toolbar:HTMLElement, info:HTMLElement, onSelectionChange:() => void }} options
   */
  constructor(doc, { toolbar, info, onSelectionChange }) {
    this.doc = doc;
    this.toolbar = toolbar;
    this.info = info;
    this.onSelectionChange = onSelectionChange;
    this.selectedId = null;

    toolbar.addEventListener('click', (e) => {
      const button = e.target.closest('button[data-action]');
      if (button) this.run(button.dataset.action, button.dataset.value);
    });
    document.addEventListener('keydown', (e) => this.#onKeyDown(e));
    doc.addEventListener('change', () => {
      // la nota selezionata può sparire (annulla, nuovo, apri)
      if (this.selectedId && !doc.get(this.selectedId)) this.select(null);
      else this.#updateToolbar();
    });
    this.#updateToolbar();
  }

  select(id) {
    this.selectedId = id && this.doc.get(id) ? id : null;
    this.#updateToolbar();
    this.onSelectionChange?.();
  }

  /** Esegue un'azione per nome (usato da pulsanti e tastiera). */
  run(action, value) {
    const id = this.selectedId;
    const note = id ? this.doc.get(id) : null;
    switch (action) {
      case 'undo':
        return this.doc.undo();
      case 'redo':
        return this.doc.redo();
      case 'transpose':
        return id && this.doc.transpose(id, Number(value));
      case 'figure':
        return id && this.doc.setBeats(id, Number(value));
      case 'dot':
        if (!note) return;
        if (DOTTABLE.has(note.beats)) this.doc.setBeats(id, note.beats * 1.5);
        else if (DOTTED.has(note.beats)) this.doc.setBeats(id, note.beats / 1.5);
        return;
      case 'rest':
        return id && this.doc.toggleRest(id);
      case 'duplicate':
        if (id) this.select(this.doc.duplicate(id));
        return;
      case 'delete': {
        if (!id) return;
        const index = this.doc.indexOf(id);
        this.doc.remove(id);
        const next = this.doc.notes[index] ?? this.doc.notes[index - 1];
        return this.select(next?.id ?? null);
      }
      case 'prev':
      case 'next':
        return this.#move(action === 'next' ? 1 : -1);
      case 'deselect':
        return this.select(null);
    }
  }

  #move(delta) {
    const notes = this.doc.notes;
    if (notes.length === 0) return;
    const index = this.selectedId ? this.doc.indexOf(this.selectedId) : delta > 0 ? -1 : notes.length;
    const next = notes[Math.min(notes.length - 1, Math.max(0, index + delta))];
    this.select(next.id);
  }

  #onKeyDown(e) {
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;

    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    let action = null;
    let value;
    if (ctrl && key === 'z' && !e.shiftKey) action = 'undo';
    else if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) action = 'redo';
    else if (ctrl) return;
    else if (e.key === 'ArrowLeft') action = 'prev';
    else if (e.key === 'ArrowRight') action = 'next';
    else if (this.selectedId) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        action = 'transpose';
        value = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      } else if (FIGURE_KEYS[e.key]) {
        action = 'figure';
        value = FIGURE_KEYS[e.key];
      } else if (e.key === '.') action = 'dot';
      else if (key === 'r') action = 'rest';
      else if (key === 'd') action = 'duplicate';
      else if (e.key === 'Delete' || e.key === 'Backspace') action = 'delete';
      else if (e.key === 'Escape') action = 'deselect';
    }
    if (!action) return;
    e.preventDefault(); // es. le frecce non devono far scorrere la pagina
    this.run(action, value);
  }

  #updateToolbar() {
    const note = this.selectedId ? this.doc.get(this.selectedId) : null;
    for (const button of this.toolbar.querySelectorAll('button[data-action]')) {
      const { action, value } = button.dataset;
      if (action === 'undo') button.disabled = !this.doc.canUndo;
      else if (action === 'redo') button.disabled = !this.doc.canRedo;
      else if (button.dataset.needsSelection !== undefined) {
        button.disabled = !note || (action === 'transpose' && note.midi === null);
      }
      if (action === 'figure') {
        // evidenzia la figura della nota selezionata (anche se puntata)
        const base = note && DOTTED.has(note.beats) ? note.beats / 1.5 : note?.beats;
        button.classList.toggle('is-active', Number(value) === base);
        button.setAttribute('aria-pressed', String(Number(value) === base));
      }
      if (action === 'dot') {
        const dotted = Boolean(note && DOTTED.has(note.beats));
        button.classList.toggle('is-active', dotted);
        button.setAttribute('aria-pressed', String(dotted));
        if (note) button.disabled = !DOTTABLE.has(note.beats) && !dotted;
      }
      if (action === 'rest' && note) button.textContent = note.midi === null ? 'Pausa → nota' : 'Nota → pausa';
    }
    this.info.textContent = note
      ? `Selezionata: ${this.doc.describe(this.selectedId)}`
      : 'Clicca una nota per modificarla';
  }
}
