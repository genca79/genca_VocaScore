import { ScoreRenderer } from './scoreRenderer.js';

/**
 * Esportazione PDF dello spartito, interamente nel browser.
 *
 * Perché pentagrammi in immagine e non vettoriali: VexFlow disegna i simboli musicali con il font
 * Bravura (woff2), ma jsPDF incorpora solo font TTF. Si disegna quindi ogni rigo su un canvas a
 * 3× (≈ 300 dpi sulla larghezza di un A4, qualità di stampa) e lo si inserisce come immagine PNG.
 * Titolo e piè di pagina sono invece testo vero (selezionabile).
 *
 * jsPDF viene caricato solo al primo utilizzo (import dinamico): non pesa sull'avvio dell'app.
 */

const PAGE_W = 210; // A4, mm
const PAGE_H = 297;
const MARGIN = 15;
const CONTENT_W = PAGE_W - 2 * MARGIN; // 180 mm
const FOOTER_SPACE = 10;
// Larghezza logica di impaginazione dei righi: 180 mm a 96 px/pollice ≈ 680 px.
const LAYOUT_WIDTH_PX = 680;
const PIXEL_RATIO = 3;

/**
 * I font standard del PDF (Helvetica) coprono il set Windows-1252: lettere accentate sì,
 * emoji e simboli esotici no. Questi ultimi vengono rimossi per non stampare caratteri illeggibili.
 */
function pdfSafe(text) {
  return text.replace(/[^\x20-\x7E\xA0-\xFF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/g, '').trim();
}

/**
 * @param {import('../music/scoreDocument.js').ScoreDocument} doc
 * @returns {Promise<Blob>}
 */
export async function exportPdf(doc) {
  const { jsPDF } = await import('jspdf');
  const title = pdfSafe(doc.settings.title) || 'Senza titolo';

  // Righi disegnati su canvas, con la stessa impaginazione della vista a schermo ma a larghezza A4.
  const host = document.createElement('div');
  new ScoreRenderer(host, { backend: 'canvas', pixelRatio: PIXEL_RATIO }).render(doc, { width: LAYOUT_WIDTH_PX });
  const systems = [...host.querySelectorAll('canvas')];

  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  pdf.setProperties({ title, creator: 'GENCA VocaScore' });

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(20);
  pdf.text(title, PAGE_W / 2, MARGIN + 8, { align: 'center', maxWidth: CONTENT_W });
  let y = MARGIN + 18;

  const mmPerPx = CONTENT_W / LAYOUT_WIDTH_PX;
  for (const canvas of systems) {
    const heightMm = (canvas.height / PIXEL_RATIO) * mmPerPx;
    // un rigo non viene mai spezzato tra due pagine
    if (y + heightMm > PAGE_H - MARGIN - FOOTER_SPACE) {
      pdf.addPage();
      y = MARGIN;
    }
    pdf.addImage(canvas.toDataURL('image/png'), 'PNG', MARGIN, y, CONTENT_W, heightMm, undefined, 'FAST');
    y += heightMm;
  }

  // Piè di pagina con numerazione, aggiunto alla fine quando il numero di pagine è noto.
  const pages = pdf.getNumberOfPages();
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(140);
  for (let i = 1; i <= pages; i++) {
    pdf.setPage(i);
    const label = pages > 1 ? `${title} · Trascritto con GENCA VocaScore · ${i}/${pages}` : 'Trascritto con GENCA VocaScore';
    pdf.text(label, PAGE_W / 2, PAGE_H - MARGIN + 4, { align: 'center' });
  }

  return pdf.output('blob');
}
