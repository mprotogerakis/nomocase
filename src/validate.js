// Upload checks: type, size, magic bytes and content. They run before a file is stored, so nothing with active content gets in.
// Returns null when the file is fine, otherwise a reason the uploader can act on. Fails closed.
// `strict` is for guest uploads: they also may not carry embedded files or be encrypted (= uncheckable).
// ponytail: structural checks, not a signature virus scanner. Upgrade path: ClamAV in a Cloudflare
// Container behind a queue, plus a "pending" state on document versions until the scan is done.

import { fail, hex, readBody } from './core.js';

// Uploads: the request as a form, then each file checked before anything is stored (documents.js, signatures.js).
export const MAX_UPLOAD = 20 * 1024 * 1024;

const ZIP = [0x50, 0x4b, 0x03, 0x04];

// extension → [content type, magic bytes]; the content checks follow below.
const FILE_TYPES = {
  pdf: ['application/pdf', [0x25, 0x50, 0x44, 0x46]],
  png: ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  jpg: ['image/jpeg', [0xff, 0xd8, 0xff]],
  jpeg: ['image/jpeg', [0xff, 0xd8, 0xff]],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP],
  odt: ['application/vnd.oasis.opendocument.text', ZIP],
  txt: ['text/plain; charset=utf-8', []],
};

// The request as a form, limited while it is read (one file per request plus a few fields).
export async function uploadForm(req) {
  const body = await readBody(req, MAX_UPLOAD + 64 * 1024, 'Datei zu groß (max. 20 MB)');
  return new Response(body, { headers: { 'content-type': req.headers.get('content-type') ?? '' } }).formData()
    .catch(() => fail(400, 'Ungültige Anfrage'));
}

// Checks a file before anything is stored: type, size, magic bytes and content (strict outside the team).
// `given`: SHA-256 as the browser read the file (app.js sends it). R2 checks it on put, so the stored bytes provably
// match what left the uploader's disk. Without one the Worker computes it (ponytail: Worker CPU, ~1 ms per MB).
export async function readUpload(file, strict, given) {
  if (!(file instanceof File) || !file.size) fail(400, 'Keine Datei');
  if (file.size > MAX_UPLOAD) fail(413, 'Datei zu groß (max. 20 MB)');
  const ext = file.name.split('.').pop().toLowerCase();
  const [contentType, magic] = FILE_TYPES[ext] ?? fail(415, 'Dateityp nicht erlaubt');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const keep = {}; // the PDF's dictionaries, for reading a form without walking the file again
  const problem = magic.some((b, i) => bytes[i] !== b) ? 'Der Dateiinhalt passt nicht zur Dateiendung.' : await checkContent(ext, bytes, { strict, keep });
  const sha256 = given ? (/^[0-9a-f]{64}$/.test(given) ? given : fail(400, 'Prüfsumme ungültig')) : hex(await crypto.subtle.digest('SHA-256', bytes));
  return { bytes, contentType, problem, filename: file.name.slice(0, 200), size: file.size, sha256, pdf: keep.pdf };
}

const latin1 = bytes => new TextDecoder('latin1').decode(bytes);
const END = '(?=[\\s()<>[\\]{}/%]|$)'; // a PDF name ends at whitespace or a delimiter
// Names that run code, start programs, submit data or play embedded media.
const PDF_ACTIVE = new RegExp(`/(JavaScript|JS|Launch|RichMedia|XFA|SubmitForm|ImportData|GoToE)${END}`);
const PDF_EMBEDDED = new RegExp(`/(EmbeddedFiles?)${END}`);
const MAX_INFLATE = 20 << 20;

// `keep`: an object that receives the PDF's dictionaries (keep.pdf) for later readers, so the file is walked only once.
export async function checkContent(ext, bytes, { strict = true, keep = {} } = {}) {
  try {
    if (ext === 'pdf') return await checkPdf(bytes, strict, keep);
    if (['docx', 'xlsx', 'odt'].includes(ext)) return await checkZip(bytes);
    if (ext === 'txt') return checkText(bytes);
    return null; // images: type and magic bytes are checked by the caller
  } catch {
    return 'Die Datei konnte nicht geprüft werden. Bitte neu speichern (z. B. „Drucken als PDF“) und erneut hochladen.';
  }
}

// --- PDF --------------------------------------------------------------------
// Stream bodies (images, fonts, page content) are skipped: they are binary and would give false hits.
// Object streams are the exception: they hold ordinary dictionaries in compressed form, so they are inflated.

// Works on bytes and decodes only the dictionary regions between streams; bodies are jumped over via
// /Length, which keeps CPU time low (Workers bill CPU per request).
const STREAM = new TextEncoder().encode('stream');
const ENDSTREAM = new TextEncoder().encode('endstream');
const ENDOBJ = new TextEncoder().encode('endobj');

function find(b, pattern, from) {
  for (let i = b.indexOf(pattern[0], from); i !== -1; i = b.indexOf(pattern[0], i + 1)) {
    let k = 1;
    while (k < pattern.length && b[i + k] === pattern[k]) k++;
    if (k === pattern.length) return i;
  }
  return -1;
}

// The PDF's dictionaries as text: everything outside stream bodies, plus the inflated object streams (in file order,
// so later incremental updates come later). Returns { problem } for files that cannot be checked (strict: more of them).
export async function pdfDictionaries(bytes, strict = false) {
  const parts = [];
  let budget = MAX_INFLATE;
  let pos = 0; // start of the region not yet collected
  for (let i = find(bytes, STREAM, 0); i !== -1; i = find(bytes, STREAM, i + 6)) {
    const isEnd = bytes[i - 3] === 0x65 && bytes[i - 2] === 0x6e && bytes[i - 1] === 0x64; // "end"stream
    const eol = bytes[i + 6] === 0x0d && bytes[i + 7] === 0x0a ? 2 : bytes[i + 6] === 0x0a ? 1 : 0;
    if (isEnd || !eol || !/>>\s*$/.test(latin1(bytes.subarray(Math.max(pos, i - 32), i)))) continue;
    const region = latin1(bytes.subarray(pos, i));
    const dict = region.slice(region.lastIndexOf('obj'));
    const start = i + 6 + eol;
    const length = Number(dict.match(/\/Length\s+(\d{1,12})(?![\d\s]*R)/)?.[1]); // bounded: long digit runs cost no time
    let end = Number.isInteger(length) && /^\s*endstream/.test(latin1(bytes.subarray(start + length, start + length + 16))) ? start + length : -1;
    if (end === -1) {
      end = find(bytes, ENDSTREAM, start);
      if (end === -1) break;
      while (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d) end--;
    }
    parts.push(region);
    // A stream body is opaque data; an object inside it means the /Length was crafted to hide that object from us.
    if (strict && find(bytes.subarray(start, end), ENDOBJ, 0) !== -1) {
      return { problem: 'Die PDF hat eine ungewöhnliche Struktur und wurde nicht angenommen. Bitte über „Drucken als PDF“ neu erzeugen.' };
    }
    if (/\/Type\s*\/ObjStm/.test(dict)) {
      const decoded = /\/FlateDecode/.test(dict) ? await inflate(bytes.subarray(start, end), 'deflate', budget).catch(() => null) : null;
      if (decoded == null) {
        if (strict) return { problem: 'Die PDF enthält Bereiche, die nicht geprüft werden können. Bitte über „Drucken als PDF“ neu erzeugen.' };
      } else {
        budget -= decoded.length;
        parts.push(decoded);
      }
    }
    pos = end;
    i = end;
  }
  parts.push(latin1(bytes.subarray(pos)));
  return { text: parts.join('\n') };
}

async function checkPdf(bytes, strict, keep) {
  const { problem, text } = await pdfDictionaries(bytes, strict);
  if (problem) return problem;
  keep.pdf = text;
  const skeleton = withoutFormatting(unescapeNames(text));

  const active = skeleton.match(PDF_ACTIVE)?.[1];
  if (active) return `Die PDF enthält aktive Inhalte (${active}) und wurde nicht angenommen. Bitte über „Drucken als PDF“ ohne Skripte neu erzeugen.`;
  if (strict) {
    const embedded = skeleton.match(PDF_EMBEDDED)?.[1];
    if (embedded) return 'Die PDF enthält eingebettete Dateien und wurde nicht angenommen. Bitte die Dateien einzeln hochladen.';
    if (/\/Encrypt\b/.test(skeleton)) return 'Verschlüsselte PDFs können nicht geprüft werden. Bitte ohne Kennwortschutz speichern.';
  }
  return null;
}

// Official fill-in forms (e.g. the faculty's "Antrag auf Praxisprojekt") format their date and number fields with
// Acrobat's built-in AF* functions. Such action dictionaries are removed before the check when every call in them is
// one of these functions with literal arguments; any other script still rejects the file.
// Arguments are separated by commas and every alternative starts differently, so the expression cannot backtrack
// exponentially; longer scripts are never treated as formatting (they stay and reject the file).
const ARG = `\\s*(?:"[^"\\\\]*"|'[^'\\\\]*'|-?\\d+(?:\\.\\d+)?|-?\\.\\d+|true|false)\\s*`;
const CALL = `AF(?:Date|Time|Number|Percent|Special)_(?:Format|Keystroke)(?:Ex)?\\((?:${ARG}(?:,${ARG})*)?\\)|AFRange_Validate\\((?:${ARG}(?:,${ARG})*)?\\)`;
const FORM_JS = new RegExp(`^\\s*(?:${CALL})(?:\\s*;\\s*(?:${CALL}))*\\s*;?\\s*$`);
const MAX_FORM_JS = 400;
const JS_ACTION = /<<\s*(?:\/S\s*\/JavaScript\s*\/JS\s*\(((?:\\.|[^\\)])*)\)|\/JS\s*\(((?:\\.|[^\\)])*)\)\s*\/S\s*\/JavaScript)\s*>>/g;
const withoutFormatting = s => s.replace(JS_ACTION, (all, a, b) => {
  const js = (a ?? b).replace(/\\([()\\])/g, '$1');
  return js.length <= MAX_FORM_JS && FORM_JS.test(js) ? '' : all;
});

// "/J#61vaScript" is a legal spelling of "/JavaScript".
const unescapeNames = s => s.replace(/\/[^\s()<>[\]{}/%#]*#[0-9a-fA-F]{2}[^\s()<>[\]{}/%]*/g,
  name => name.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));

async function inflate(bytes, format, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const decoder = new TextDecoder('latin1');
  let out = '';
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    out += decoder.decode(r.value, { stream: true });
    if (out.length > limit) {
      await reader.cancel();
      throw new Error('inflated data too large');
    }
  }
  return out;
}

// --- Office Open XML / OpenDocument (ZIP) -----------------------------------

const ZIP_ACTIVE = [
  [/(^|\/)vbaProject\.bin$|(^|\/)vbaData\.xml$/i, 'Makros'],
  [/(^|\/)macrosheets\//i, 'Excel-4.0-Makros'],
  [/(^|\/)activeX\//i, 'ActiveX-Steuerelemente'],
  [/(^|\/)embeddings\/oleObject[^/]*\.bin$/i, 'eingebettete OLE-Objekte'],
  [/^(Basic|Scripts)\//, 'Makros'],
];

async function checkZip(bytes) {
  const entries = zipEntries(bytes);
  if (!entries || entries.length > 5000) return 'Die Datei ist kein gültiges Office-Dokument.';
  for (const e of entries) {
    const hit = ZIP_ACTIVE.find(([re]) => re.test(e.name));
    if (hit) return `Das Dokument enthält ${hit[1]} und wurde nicht angenommen. Bitte als normales Dokument oder PDF speichern.`;
  }
  // External relationships other than hyperlinks load remote content when opened (e.g. remote templates).
  // Part names are case-insensitive (OPC), and attribute values may be written as character references.
  let budget = 4 << 20; // all relationship parts together (entries may point at the same compressed data)
  for (const e of entries.filter(x => x.name.toLowerCase().endsWith('.rels'))) {
    const text = await zipText(bytes, e, Math.min(1 << 20, budget));
    budget -= text.length;
    const xml = text.replace(/&#(x?)([0-9a-f]+);/gi, (_, hex, n) => String.fromCharCode(parseInt(n, hex ? 16 : 10)));
    for (const rel of xml.match(/<Relationship\b[^>]*>/gi) ?? []) {
      const mode = rel.match(/TargetMode\s*=\s*["']([^"']*)["']/i)?.[1];
      if (mode && mode !== 'Internal' && !/Type\s*=\s*["'][^"']*\/hyperlink["']/i.test(rel)) {
        return 'Das Dokument lädt externe Inhalte nach und wurde nicht angenommen. Bitte als PDF speichern.';
      }
    }
  }
  return null;
}

function zipEntries(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entries = [];
  let p = v.getUint32(eocd + 16, true);
  for (let n = v.getUint16(eocd + 10, true); n > 0; n--) {
    if (v.getUint32(p, true) !== 0x02014b50) return null;
    const nameLength = v.getUint16(p + 28, true);
    entries.push({
      name: new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLength)),
      method: v.getUint16(p + 10, true),
      size: v.getUint32(p + 20, true),
      local: v.getUint32(p + 42, true),
    });
    p += 46 + nameLength + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return entries;
}

async function zipText(b, e, limit) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (v.getUint32(e.local, true) !== 0x04034b50) throw new Error('bad local header');
  const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true);
  const data = b.subarray(start, start + e.size);
  if (e.method === 0) return latin1(data.subarray(0, limit));
  if (e.method === 8) return inflate(data, 'deflate-raw', limit);
  throw new Error(`unsupported zip method ${e.method}`);
}

// --- text -------------------------------------------------------------------

function checkText(bytes) {
  new TextDecoder('utf-8', { fatal: true }).decode(bytes); // throws on invalid UTF-8 → caught above
  return bytes.includes(0) ? 'Die Textdatei enthält Binärdaten.' : null;
}
