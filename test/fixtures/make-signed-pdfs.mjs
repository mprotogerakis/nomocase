// Builds synthetic signed PDFs for test/pdfsig.mjs with the openssl CLI (no real people, no real keys).
// Run once: node test/fixtures/make-signed-pdfs.mjs  → test/fixtures/signed/*.pdf and the test CA certificate.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = new URL('./signed/', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'nomocase-sig-'));
mkdirSync(out, { recursive: true });
const ssl = (...args) => execFileSync('openssl', args, { stdio: ['ignore', 'pipe', 'ignore'] });
const f = name => join(tmp, name);

// A small CA with one RSA user certificate, plus a self-signed EC certificate (like an Acrobat "digital ID").
ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.crt'), '-days', '3650', '-subj', '/O=NomoCase Test/CN=Test-CA');
ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('max.key'), '-out', f('max.csr'), '-subj', '/O=Hochschule Beispiel/CN=Max Beispiel/emailAddress=max@example.org');
ssl('x509', '-req', '-in', f('max.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('max.crt'), '-days', '3650');
ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', f('muster.key'), '-out', f('muster.crt'), '-days', '3650',
  '-subj', '/CN=Dr. Muster/emailAddress=muster@example.org');
ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('max2.key'), '-out', f('max2.crt'), '-days', '3650',
  '-subj', '/CN=Max Beispiel/emailAddress=max@example.org'); // same name, different key: "another signature than before"
writeFileSync(join(out, 'test-ca.der'), ssl('x509', '-in', f('ca.crt'), '-outform', 'DER'));
// A user certificate of the CA (no CA rights) issuing a certificate in someone else's name: must never count as trusted.
ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('forged.key'), '-out', f('forged.csr'), '-subj', '/CN=Dr. Muster/emailAddress=muster@example.org');
ssl('x509', '-req', '-in', f('forged.csr'), '-CA', f('max.crt'), '-CAkey', f('max.key'), '-CAcreateserial', '-out', f('forged.crt'), '-days', '3650');
writeFileSync(f('chain.pem'), Buffer.concat([readFileSync(f('max.crt')), readFileSync(f('ca.crt'))]));

const SIZE = 8192; // bytes reserved for the signature
// Appends a signature object whose ByteRange covers the whole file, signed by key/cert (+ chain).
function sign(pdf, obj, key, cert, chain) {
  const head = `\n${obj} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /M (D:20261014120000+02'00')\n/ByteRange [0 ********** ********** **********] /Contents <`;
  const tail = `> >>\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`;
  let text = pdf + head + '0'.repeat(SIZE * 2) + tail;
  const a1 = pdf.length + head.length - 1, b0 = a1 + SIZE * 2 + 2, b1 = text.length - b0;
  const range = [a1, b0, b1].map(n => String(n).padStart(10, ' '));
  text = text.replace('********** ********** **********', range.join(' '));
  const data = Buffer.from(text.slice(0, a1) + text.slice(b0), 'latin1');
  writeFileSync(f('data.bin'), data);
  const cms = ssl('cms', '-sign', '-binary', '-in', f('data.bin'), '-signer', cert, '-inkey', key, ...(chain ? ['-certfile', chain] : []), '-md', 'sha256', '-outform', 'DER', '-nosmimecap');
  return text.slice(0, a1 + 1) + cms.toString('hex').padEnd(SIZE * 2, '0') + text.slice(a1 + 1 + SIZE * 2);
}

const base = '%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj';
const one = sign(base, 3, f('max.key'), f('max.crt'), f('ca.crt'));
const save = (name, text) => writeFileSync(join(out, name), Buffer.from(text, 'latin1'));
save('one.pdf', one);                                                               // CA-issued RSA signature
save('two.pdf', sign(one, 4, f('muster.key'), f('muster.crt')));                    // plus a second, self-signed EC signature
save('appended.pdf', `${one}4 0 obj\n<< /Note (nachträglich geändert) >>\nendobj\n%%EOF\n`); // changed after signing
const tampered = Buffer.from(one, 'latin1'); tampered[20] ^= 1; writeFileSync(join(out, 'tampered.pdf'), tampered); // byte flipped
save('other-key.pdf', sign(base, 3, f('max2.key'), f('max2.crt')));                 // same person's name, a new key
save('forged-chain.pdf', sign(base, 3, f('forged.key'), f('forged.crt'), f('chain.pem'))); // "issued" by Max, a mere user
console.log('written to', out, readFileSync(join(out, 'one.pdf')).length, 'bytes per single-signature file');
