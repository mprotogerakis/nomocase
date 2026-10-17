// Mails (.eml): header words and attachments. Shared by the Worker (mail into a case: subject, sender) and the UI
// (taking a stored mail's attachments into the case as documents – parsed in the browser, so a large mail costs the
// Worker no CPU). Handles nested multiparts, base64 and quoted-printable, names in RFC 2047 or RFC 2231 form.
// ponytail: no RFC 2231 continuations (filename*0*=…), no uuencode; add when a mail program sends them.

const latin1 = bytes => new TextDecoder('latin1').decode(bytes);
const decoder = charset => { try { return new TextDecoder(charset); } catch { return new TextDecoder('utf-8'); } };
const BYTE = new Map(Array.from({ length: 32 }, (_, k) => [new TextDecoder('latin1').decode(Uint8Array.of(0x80 + k)), 0x80 + k]));
const bytesOf = s => Uint8Array.from(s, ch => BYTE.get(ch) ?? ch.charCodeAt(0)); // back from the latin1 view

// "=?utf-8?B?…?=" / "=?iso-8859-1?Q?…?=" (RFC 2047); a damaged encoded word stays as it is.
export const decodeHeader = s => String(s ?? '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (word, charset, enc, text) => {
  try {
    const bytes = enc.toUpperCase() === 'B'
      ? Uint8Array.from(atob(text), c => c.charCodeAt(0))
      : Uint8Array.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, h) => String.fromCharCode(parseInt(h, 16))), c => c.charCodeAt(0));
    return decoder(charset.toLowerCase()).decode(bytes);
  } catch { return word; }
}).replace(/\s+/g, ' ').trim();

// Header block → { 'content-type': '…', … } (folded lines joined, names lower-case).
function headers(block) {
  const out = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

// A parameter of a header value (boundary, filename, name), plain, quoted or RFC 2231 (filename*=utf-8''…).
function param(value, name) {
  const ext = new RegExp(`(?:^|;)\\s*${name}\\*=([^']*)'[^']*'([^;]+)`, 'i').exec(value ?? '');
  if (ext) { // percent-escaped bytes in the named charset
    const bytes = Uint8Array.from(ext[2].trim().replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), c => c.charCodeAt(0));
    return decoder(ext[1] || 'utf-8').decode(bytes);
  }
  const m = new RegExp(`(?:^|;)\\s*${name}=(?:"((?:\\\\.|[^"])*)"|([^;\\s]+))`, 'i').exec(value ?? '');
  return m ? decodeHeader((m[1] ?? m[2]).replace(/\\(.)/g, '$1')) : null;
}

const decodeBody = (text, encoding) => {
  const enc = String(encoding ?? '').toLowerCase();
  if (enc === 'base64') return Uint8Array.from(atob(text.replace(/[^A-Za-z0-9+/=]/g, '')), c => c.charCodeAt(0));
  if (enc === 'quoted-printable') return bytesOf(text.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
  return bytesOf(text);
};

// Every part with a file name: { filename, contentType, bytes }.
export function mailAttachments(raw) {
  const out = [];
  const walk = (text, depth) => {
    const cut = /\r?\n\r?\n/.exec(text);
    const head = headers(cut ? text.slice(0, cut.index) : text), body = cut ? text.slice(cut.index + cut[0].length) : '';
    const type = (head['content-type'] ?? 'text/plain').split(';')[0].trim().toLowerCase();
    const boundary = type.startsWith('multipart/') && param(head['content-type'], 'boundary');
    if (boundary && depth < 10) {
      // delimiter lines, also the closing one at the very end without a line break (else it would end up in the last part)
      const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
      for (const part of parts.slice(1)) if (part.trim()) walk(part, depth + 1); // [0] is the preamble
      return;
    }
    const filename = param(head['content-disposition'], 'filename') ?? param(head['content-type'], 'name');
    if (filename && depth > 0) out.push({ filename: filename.replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 200), contentType: type, bytes: decodeBody(body, head['content-transfer-encoding']) });
  };
  walk(latin1(raw), 0);
  return out;
}
