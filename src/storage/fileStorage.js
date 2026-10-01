/**
 * Salvataggio e apertura degli spartiti, tutto in locale:
 *   - file sul disco dell'utente (nessun upload): .vocascore.json, .musicxml, .pdf;
 *   - bozza automatica in localStorage, per non perdere il lavoro se si chiude la pagina.
 */

const DRAFT_KEY = 'vocascore.draft';

/** Tipi di file esportabili: descrizione per la finestra "Salva con nome", MIME ed estensione. */
export const FILE_TYPES = {
  vocascore: { description: 'Spartito GENCA VocaScore', mime: 'application/json', extension: '.vocascore.json' },
  musicxml: { description: 'MusicXML', mime: 'application/vnd.recordare.musicxml+xml', extension: '.musicxml' },
  pdf: { description: 'Documento PDF', mime: 'application/pdf', extension: '.pdf' },
};

/** "La mia canzone!" → "la-mia-canzone" (nome file sicuro). */
export function slugify(title) {
  const slug = String(title)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // rimuove gli accenti: "perché" → "perche"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'spartito';
}

/**
 * Salva un file sul dispositivo.
 * In Edge/Chrome usa la File System Access API (finestra "Salva con nome" nativa); negli altri
 * browser ripiega su un download classico.
 *
 * @param {Blob|string} content
 * @param {string} title titolo dello spartito (diventa il nome del file)
 * @param {keyof FILE_TYPES} type
 * @returns {Promise<boolean>} false se l'utente ha annullato
 */
export async function saveFile(content, title, type) {
  const { description, mime, extension } = FILE_TYPES[type];
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const suggestedName = slugify(title) + extension;

  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description, accept: { [mime]: [extension.slice(extension.lastIndexOf('.'))] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch (err) {
      if (err?.name === 'AbortError') return false; // finestra chiusa dall'utente
      // altri errori (es. API bloccata): si prova con il download classico
    }
  }

  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: suggestedName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** Legge e interpreta un file JSON scelto dall'utente. */
export async function readJsonFile(file) {
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new SyntaxError('Il file non è un JSON valido.');
  }
}

export function saveDraft(data) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(data));
  } catch {
    // storage pieno o non disponibile: la bozza semplicemente non viene salvata
  }
}

export function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
