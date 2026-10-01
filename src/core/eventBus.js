/**
 * Event bus minimale basato su EventTarget nativo.
 * I moduli non si importano a vicenda: main.js pubblica eventi, gli output si iscrivono.
 *
 * Eventi usati:
 *   'note:on'   { midi, name, hz, startMs }
 *   'note:off'  { midi, name, startMs, endMs, durationMs }
 *   'feedback'  FeedbackState (vedi audio/feedbackGuard.js)
 */
class EventBus extends EventTarget {
  /** Registra un listener; restituisce la funzione per rimuoverlo. */
  on(type, handler) {
    const listener = (event) => handler(event.detail);
    this.addEventListener(type, listener);
    return () => this.removeEventListener(type, listener);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export const bus = new EventBus();
