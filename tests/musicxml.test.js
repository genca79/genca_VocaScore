import { describe, expect, it } from 'vitest';
import { ScoreDocument } from '../src/music/scoreDocument.js';
import { toMusicXML } from '../src/music/musicxml.js';

function docWith(notes, settings = {}) {
  const doc = new ScoreDocument();
  doc.setSettings(settings);
  for (const [midi, beats] of notes) doc.append({ midi, beats });
  return doc;
}

const date = new Date('2026-10-01T12:00:00Z');
const count = (xml, s) => xml.split(s).length - 1;

describe('toMusicXML', () => {
  it('intestazione, titolo, tempo, chiave e metronomo', () => {
    const xml = toMusicXML(docWith([[60, 4]], { title: 'Ciao & <Mondo>', bpm: 100, timeSignature: '3/4', clef: 'bass' }), { date });
    expect(xml).toContain('<score-partwise version="4.0">');
    expect(xml).toContain('<work-title>Ciao &amp; &lt;Mondo&gt;</work-title>');
    expect(xml).toContain('<time><beats>3</beats><beat-type>4</beat-type></time>');
    expect(xml).toContain('<clef><sign>F</sign><line>4</line></clef>');
    expect(xml).toContain('<per-minute>100</per-minute>');
    expect(xml).toContain('<encoding-date>2026-10-01</encoding-date>');
  });

  it('altezze, alterazioni e durate (divisions = 4 per semiminima)', () => {
    const xml = toMusicXML(docWith([[61, 1], [61, 1], [60, 1.5], [null, 0.5]]), { date });
    expect(xml).toContain('<step>C</step><alter>1</alter><octave>4</octave>');
    // diesis scritto solo sulla prima C#4 della battuta, bequadro sul Do naturale successivo
    expect(count(xml, '<accidental>sharp</accidental>')).toBe(1);
    expect(count(xml, '<accidental>natural</accidental>')).toBe(1);
    expect(xml).toContain('<duration>6</duration><voice>1</voice><type>quarter</type><dot/>');
    expect(xml).toContain('<rest/><duration>2</duration><voice>1</voice><type>eighth</type>');
  });

  it('legature a cavallo della battuta: tie start/stop in entrambi i formati', () => {
    const xml = toMusicXML(docWith([[60, 3], [67, 2], [64, 3]]), { date });
    expect(count(xml, '<tie type="start"/>')).toBe(1);
    expect(count(xml, '<tie type="stop"/>')).toBe(1);
    expect(count(xml, '<tied type="start"/>')).toBe(1);
    expect(count(xml, '<tied type="stop"/>')).toBe(1);
  });

  it("l'ultima battuta viene completata con pause e chiusa dalla doppia barra", () => {
    const xml = toMusicXML(docWith([[60, 1], [62, 1], [64, 1], [65, 1], [67, 1]]), { date });
    expect(count(xml, '<measure ')).toBe(2);
    // 4/4: dopo la semiminima della 2ª battuta servono 3 movimenti di pausa (minima puntata)
    expect(xml).toMatch(/<rest\/><duration>12<\/duration><voice>1<\/voice><type>half<\/type><dot\/>/);
    expect(xml).toContain('<bar-style>light-heavy</bar-style>');
  });

  it('ogni battuta somma esattamente la sua durata', () => {
    const xml = toMusicXML(docWith([[60, 0.5], [62, 2.25], [64, 6], [null, 1.25], [65, 0.75]], { timeSignature: '6/8' }), { date });
    const measures = xml.match(/<measure [\s\S]*?<\/measure>/g);
    for (const m of measures) {
      const total = [...m.matchAll(/<duration>(\d+)<\/duration>/g)].reduce((s, x) => s + Number(x[1]), 0);
      expect(total).toBe(12); // 6/8 = 3 semiminime = 12 divisioni
    }
  });

  it('spartito vuoto: una battuta di pausa valida', () => {
    const xml = toMusicXML(new ScoreDocument(), { date });
    expect(xml).toContain('<rest measure="yes"/><duration>16</duration>');
  });
});
