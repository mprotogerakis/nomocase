// Values of a filled-in PDF form (AcroForm): field name → text, or true/false for checkboxes. Works on the dictionaries
// the upload check already exposes (validate.js: outside stream bodies plus inflated object streams), so forms saved
// with object streams or incremental updates (Acrobat) are covered; the last definition of a field name wins.
// ponytail: partial field names only (no /Parent chain) – enough for the flat forms NomoCase generates; build full
// names from the parents if other forms need it.
import { pdfDictionaries } from './validate.js';

// validate.js decodes bytes as windows-1252 ("latin1" in TextDecoder); map 0x80–0x9F back to their bytes.
const BYTE = new Map(Array.from({ length: 32 }, (_, k) => [new TextDecoder('latin1').decode(Uint8Array.of(0x80 + k)), 0x80 + k]));
const byteOf = ch => BYTE.get(ch) ?? ch.charCodeAt(0);

// PDF text strings: UTF-16BE or UTF-8 with a byte order mark, else PDFDocEncoding (≈ Latin-1 for what forms contain).
export function pdfText(bytes) {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let k = 2; k + 1 < bytes.length; k += 2) out += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
    return out;
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(Uint8Array.from(bytes.slice(3)));
  return String.fromCharCode(...bytes);
}

const ESCAPES = { n: 10, r: 13, t: 9, b: 8, f: 12 };
const isSpace = ch => ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0';
// Sticky expressions match right at reader.i without copying the rest of the text.
const REGULAR = /[^\s()<>[\]{}/%]+/y;
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)/y;
const REF = /\s+\d+\s+R(?![^\s()<>[\]{}/%])/y;
const at = (re, s, pos) => { re.lastIndex = pos; return re.exec(s)?.[0]; };

// A small reader for PDF objects: dictionaries, arrays, strings ({ str: bytes }), names ({ name }), numbers,
// references ({ ref }), true/false/null. Every step consumes input, so damaged files end the loop instead of hanging.
function reader(s) {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < s.length && isSpace(s[i])) i++;
      if (s[i] !== '%') return;
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
    }
  };
  const name = () => {
    const m = at(REGULAR, s, i + 1) ?? '';
    i += 1 + m.length;
    return m.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  };
  const literal = () => {
    const out = [];
    let depth = 1;
    for (i++; i < s.length;) {
      const ch = s[i++];
      if (ch === '\\') {
        const e = s[i++];
        if (e in ESCAPES) out.push(ESCAPES[e]);
        else if (e >= '0' && e <= '7') {
          let oct = e;
          while (oct.length < 3 && s[i] >= '0' && s[i] <= '7') oct += s[i++];
          out.push(parseInt(oct, 8) & 255);
        } else if (e === '\r') { if (s[i] === '\n') i++; } // line continuation
        else if (e !== '\n') out.push(byteOf(e));
      } else if (ch === '(') { depth++; out.push(40); } else if (ch === ')') {
        if (--depth === 0) break;
        out.push(41);
      } else out.push(byteOf(ch));
    }
    return out;
  };
  const value = (depth = 0) => {
    skip();
    const ch = s[i];
    if (ch === '<' && s[i + 1] === '<') {
      i += 2;
      const d = {};
      for (;;) {
        skip();
        if (i >= s.length) return d;
        if (s[i] === '>' && s[i + 1] === '>') { i += 2; return d; }
        if (s[i] !== '/' || depth > 40) { i++; continue; }
        const key = name();
        d[key] = value(depth + 1);
      }
    }
    if (ch === '<') {
      const end = s.indexOf('>', i);
      const hexDigits = s.slice(i + 1, end === -1 ? s.length : end).replace(/[^0-9a-fA-F]/g, '');
      i = end === -1 ? s.length : end + 1;
      return { str: Array.from({ length: Math.ceil(hexDigits.length / 2) }, (_, k) => parseInt(hexDigits.slice(2 * k, 2 * k + 2).padEnd(2, '0'), 16)) };
    }
    if (ch === '(') return { str: literal() };
    if (ch === '[') {
      i++;
      const list = [];
      for (;;) {
        skip();
        if (i >= s.length || s[i] === ']') { i++; return list; }
        if (depth > 40) { i++; continue; }
        list.push(value(depth + 1));
      }
    }
    if (ch === '/') return { name: name() };
    const num = at(NUMBER, s, i);
    if (num) {
      i += num.length;
      const ref = at(REF, s, i);
      if (ref) { i += ref.length; return { ref: num }; }
      return Number(num);
    }
    const word = at(REGULAR, s, i);
    i += word ? word.length : 1;
    return word === 'true' ? true : word === 'false' ? false : null;
  };
  return { at: pos => { i = pos; return value(); }, get pos() { return i; } };
}

// `pdf`: the file's bytes, or its dictionaries as the upload check already extracted them (saves a second pass).
export async function readFormFields(pdf) {
  const fields = new Map();
  const { text } = typeof pdf === 'string' ? { text: pdf } : await pdfDictionaries(pdf);
  if (!text || !text.includes('/AcroForm')) return fields;
  const r = reader(text);
  for (let at = text.indexOf('<<'); at !== -1; at = text.indexOf('<<', Math.max(r.pos, at + 2))) {
    const d = r.at(at);
    if (!d.T?.str || !(d.FT || 'V' in d || d.Kids)) continue;
    const v = d.V;
    fields.set(pdfText(d.T.str), v?.str ? pdfText(v.str) : v?.name ? v.name !== 'Off' : d.FT?.name === 'Btn' ? false : v?.ref ? null : '');
  }
  return fields;
}
