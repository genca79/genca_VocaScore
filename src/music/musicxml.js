import { NOTE_NAMES } from './noteUtils.js';
import { chooseClef, layoutMeasures, timeSignatureInfo } from './notation.js';

/**
 * Esportazione MusicXML 4.0 (partwise), il formato di scambio standard tra programmi di notazione
 * (MuseScore, Finale, Sibelius, Dorico…).
 *
 * Si parte dalla stessa impaginazione in battute usata dal pentagramma (layoutMeasures):
 * spezzature alle stanghette, legature e alterazioni sono quindi identiche a ciò che si vede.
 *
 * Durate: <divisions>4</divisions> = 4 unità per semiminima, quindi la semicroma (la griglia
 * minima del modello) vale 1 e tutte le durate sono interi: durata = beats × 4.
 */

const DIVISIONS = 4;
const TYPE = { w: 'whole', h: 'half', q: 'quarter', 8: 'eighth', 16: '16th' };
const ACCIDENTAL = { '#': 'sharp', n: 'natural' };

const escapeXml = (s) =>
  String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/**
 * @param {import('./scoreDocument.js').ScoreDocument} doc
 * @param {{ date?:Date }} [options]
 * @returns {string} documento MusicXML
 */
export function toMusicXML(doc, { date = new Date() } = {}) {
  const { title, bpm, timeSignature, clef: clefSetting } = doc.settings;
  const { num, den, measureBeats } = timeSignatureInfo(timeSignature);
  const pitches = doc.notes.filter((n) => n.midi !== null).map((n) => n.midi);
  const clef = clefSetting === 'auto' ? chooseClef(pitches, 'treble') : clefSetting;

  // L'ultima battuta viene completata con pause: MusicXML (e i programmi che lo leggono) si
  // aspettano battute piene.
  const notes = [...doc.notes];
  const total = notes.reduce((sum, n) => sum + n.beats, 0);
  const remainder = total % measureBeats;
  if (notes.length > 0 && remainder > 1e-9) notes.push({ id: '__pad', midi: null, beats: measureBeats - remainder });

  const measures = notes.length > 0 ? layoutMeasures(notes, timeSignature) : [[]];
  let previousTied = false; // il segmento precedente era legato a questo

  const measureXml = measures.map((segments, i) => {
    const parts = [];
    if (i === 0) {
      parts.push(
        '<attributes>',
        `<divisions>${DIVISIONS}</divisions>`,
        '<key><fifths>0</fifths></key>',
        `<time><beats>${num}</beats><beat-type>${den}</beat-type></time>`,
        clef === 'bass' ? '<clef><sign>F</sign><line>4</line></clef>' : '<clef><sign>G</sign><line>2</line></clef>',
        '</attributes>',
        '<direction placement="above"><direction-type><metronome>',
        `<beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute>`,
        `</metronome></direction-type><sound tempo="${bpm}"/></direction>`,
      );
    }

    if (segments.length === 0) {
      // spartito vuoto: una battuta di pausa
      parts.push(`<note><rest measure="yes"/><duration>${measureBeats * DIVISIONS}</duration><voice>1</voice></note>`);
    }

    for (const seg of segments) {
      parts.push(noteXml(seg, previousTied));
      previousTied = seg.tieNext;
    }

    if (i === measures.length - 1) parts.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
    return `<measure number="${i + 1}">${parts.join('')}</measure>`;
  });

  const isoDate = date.toISOString().slice(0, 10);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    `<work><work-title>${escapeXml(title.trim() || 'Senza titolo')}</work-title></work>`,
    `<identification><encoding><software>GENCA VocaScore</software><encoding-date>${isoDate}</encoding-date></encoding></identification>`,
    '<part-list><score-part id="P1"><part-name>Voce</part-name></score-part></part-list>',
    '<part id="P1">',
    ...measureXml,
    '</part>',
    '</score-partwise>',
    '',
  ].join('\n');
}

/**
 * Un segmento → elemento <note>. L'ordine dei figli è imposto dallo schema MusicXML:
 * pitch|rest, duration, tie, voice, type, dot, accidental, notations.
 */
function noteXml(seg, tiedFromPrevious) {
  const duration = Math.round(seg.beats * DIVISIONS);
  const dots = '<dot/>'.repeat(seg.dots);
  if (seg.midi === null) {
    return `<note><rest/><duration>${duration}</duration><voice>1</voice><type>${TYPE[seg.duration]}</type>${dots}</note>`;
  }

  // Ortografia con soli diesis, come sul pentagramma: C# = C con alter +1.
  const name = NOTE_NAMES[((seg.midi % 12) + 12) % 12];
  const octave = Math.floor(seg.midi / 12) - 1;
  const alter = name.length > 1 ? '<alter>1</alter>' : '';

  const tieTypes = [tiedFromPrevious && 'stop', seg.tieNext && 'start'].filter(Boolean);
  const ties = tieTypes.map((t) => `<tie type="${t}"/>`).join('');
  const tied = tieTypes.map((t) => `<tied type="${t}"/>`).join('');
  const accidental = seg.accidental ? `<accidental>${ACCIDENTAL[seg.accidental]}</accidental>` : '';

  return (
    `<note><pitch><step>${name[0]}</step>${alter}<octave>${octave}</octave></pitch>` +
    `<duration>${duration}</duration>${ties}<voice>1</voice><type>${TYPE[seg.duration]}</type>${dots}${accidental}` +
    (tied ? `<notations>${tied}</notations>` : '') +
    '</note>'
  );
}
