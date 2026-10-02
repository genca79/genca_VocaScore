import { NOTE_NAMES } from './noteUtils.js';
import { alignVoices, chooseClef, layoutMeasures, timeSignatureInfo } from './notation.js';

/**
 * Esportazione MusicXML 4.0 (partwise), il formato di scambio standard tra programmi di notazione
 * (MuseScore, Finale, Sibelius, Dorico…).
 *
 * Si parte dalla stessa impaginazione in battute usata dal pentagramma (layoutMeasures):
 * spezzature alle stanghette, legature e alterazioni sono quindi identiche a ciò che si vede.
 *
 * Durate: <divisions>4</divisions> = 4 unità per semiminima, quindi la semicroma (la griglia
 * minima del modello) vale 1 e tutte le durate sono interi: durata = beats × 4.
 *
 * Partitura: una <part> per voce, con il nome dato dall'utente e la sua chiave. Tutte le parti hanno
 * lo stesso numero di battute (le voci più corte sono completate con pause, vedi alignVoices).
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
  const { title, timeSignature } = doc.settings;
  // Battute piene in tutte le voci: MusicXML (e i programmi che lo leggono) se le aspettano.
  const voices = alignVoices(doc.voices, timeSignature, { toMeasure: true });
  const partIds = voices.map((_, i) => `P${i + 1}`);

  const isoDate = date.toISOString().slice(0, 10);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    `<work><work-title>${escapeXml(title.trim() || 'Senza titolo')}</work-title></work>`,
    `<identification><encoding><software>GENCA VocaScore</software><encoding-date>${isoDate}</encoding-date></encoding></identification>`,
    '<part-list>',
    ...voices.map((v, i) => `<score-part id="${partIds[i]}"><part-name>${escapeXml(v.name)}</part-name></score-part>`),
    '</part-list>',
    ...voices.flatMap((v, i) => [`<part id="${partIds[i]}">`, ...partMeasures(v, doc.settings, i === 0), '</part>']),
    '</score-partwise>',
    '',
  ].join('\n');
}

/**
 * Battute di una voce. L'indicazione metronomica va solo nella prima parte (vale per tutta la partitura).
 * @returns {string[]}
 */
function partMeasures(voice, { bpm, timeSignature }, withTempo) {
  const { num, den, measureBeats } = timeSignatureInfo(timeSignature);
  const pitches = voice.notes.filter((n) => n.midi !== null).map((n) => n.midi);
  const clef = voice.clef === 'auto' ? chooseClef(pitches, 'treble') : voice.clef;
  const measures = voice.notes.length > 0 ? layoutMeasures(voice.notes, timeSignature) : [[]];
  let previousTied = false; // il segmento precedente era legato a questo

  return measures.map((segments, i) => {
    const parts = [];
    if (i === 0) {
      parts.push(
        '<attributes>',
        `<divisions>${DIVISIONS}</divisions>`,
        '<key><fifths>0</fifths></key>',
        `<time><beats>${num}</beats><beat-type>${den}</beat-type></time>`,
        clef === 'bass' ? '<clef><sign>F</sign><line>4</line></clef>' : '<clef><sign>G</sign><line>2</line></clef>',
        '</attributes>',
      );
      if (withTempo) {
        parts.push(
          '<direction placement="above"><direction-type><metronome>',
          `<beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute>`,
          `</metronome></direction-type><sound tempo="${bpm}"/></direction>`,
        );
      }
    }

    if (segments.length === 0) {
      // voce vuota: una battuta di pausa
      parts.push(`<note><rest measure="yes"/><duration>${measureBeats * DIVISIONS}</duration><voice>1</voice></note>`);
    }

    for (const seg of segments) {
      parts.push(noteXml(seg, previousTied));
      previousTied = seg.tieNext;
    }

    if (i === measures.length - 1) parts.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
    return `<measure number="${i + 1}">${parts.join('')}</measure>`;
  });
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
