// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest';
import { ScoreDocument } from '../src/music/scoreDocument.js';

/**
 * Prova d'esecuzione del pentagramma in un DOM simulato (happy-dom): VexFlow disegna davvero in SVG.
 * Non verifica l'aspetto (happy-dom non calcola il layout dei testi), ma che il disegno di una
 * partitura a più voci funzioni: un rigo per voce, nomi, parentesi, note cliccabili.
 */
let ScoreRenderer;
beforeAll(async () => {
  ({ ScoreRenderer } = await import('../src/output/scoreRenderer.js'));
}, 60000);

function choir() {
  const doc = new ScoreDocument();
  doc.renameVoice(doc.voice.id, 'Soprano');
  for (const [midi, beats] of [[72, 1], [74, 1], [76, 2], [77, 4]]) doc.append({ midi, beats });
  const bass = doc.addVoice('Basso');
  doc.setVoiceClef(bass, 'bass');
  for (const [midi, beats] of [[48, 2], [43, 2]]) doc.append({ midi, beats }, bass); // più corto: completato con pause
  return { doc, bass };
}

/** Rettangoli più alti di un rigo (le 5 linee occupano 40 px): uniscono righi diversi. */
const tallRects = (host) => [...host.querySelectorAll('rect')].filter((r) => Number(r.getAttribute('height')) > 100);

function render(score, view = {}) {
  const host = document.createElement('div');
  new ScoreRenderer(host, { interactive: true }).render(score, { width: 900, ...view });
  return host;
}

describe('ScoreRenderer (SVG, DOM simulato)', () => {
  it('partitura a due voci: un sistema, due righi con chiave, nomi delle voci, parentesi', () => {
    const { doc } = choir();
    const host = render(doc);
    const systems = host.querySelectorAll('.score-system');
    expect(systems).toHaveLength(1);
    const text = host.textContent;
    expect(text).toContain('Soprano');
    expect(text).toContain('Basso');
    expect(host.querySelectorAll('.vf-clef')).toHaveLength(2);
    // linea di sistema e parentesi: rettangoli verticali che uniscono i due righi (più alti di un rigo)
    expect(tallRects(host).length).toBeGreaterThan(0);
  });

  it('una voce sola: nessuna linea che unisce più righi', () => {
    const doc = new ScoreDocument();
    doc.append({ midi: 60, beats: 4 });
    expect(tallRects(render(doc))).toHaveLength(0);
  });

  it('ogni nota del documento è cliccabile (data-note-id), le pause di completamento no', () => {
    const { doc } = choir();
    const host = render(doc);
    const ids = [...host.querySelectorAll('[data-note-id]')].map((el) => el.dataset.noteId);
    const docIds = doc.voices.flatMap((v) => v.notes.map((n) => n.id));
    expect(new Set(ids)).toEqual(new Set(docIds));
  });

  it('una voce sola: nessuna colonna dei nomi né parentesi (come prima)', () => {
    const doc = new ScoreDocument();
    doc.append({ midi: 60, beats: 4 });
    const host = render(doc);
    expect(host.textContent).not.toContain('Voce 1');
    expect(host.querySelectorAll('.vf-clef')).toHaveLength(1);
  });

  it('anteprima della registrazione (note "live") in una voce: disegnata, non cliccabile', () => {
    const { doc, bass } = choir();
    const voices = doc.voices.map((v) => (v.id === bass ? { ...v, notes: [...v.notes, { id: 'live-0', midi: 45, beats: 2, live: true }] } : v));
    const host = render({ settings: doc.settings, voices, activeVoiceId: bass });
    expect([...host.querySelectorAll('[data-note-id]')].some((el) => el.dataset.noteId === 'live-0')).toBe(false);
    expect(host.querySelectorAll('.score-system').length).toBeGreaterThan(0);
  });

  it('partitura lunga: più sistemi, tutte le voci in ognuno', () => {
    const { doc, bass } = choir();
    for (let i = 0; i < 40; i++) doc.append({ midi: 60 + (i % 7), beats: 1 }, doc.voices[0].id);
    for (let i = 0; i < 10; i++) doc.append({ midi: 43 + (i % 5), beats: 2 }, bass);
    const host = render(doc);
    const systems = host.querySelectorAll('.score-system');
    expect(systems.length).toBeGreaterThan(1);
    for (const system of systems) expect(system.querySelectorAll('.vf-clef')).toHaveLength(2);
  });
});
