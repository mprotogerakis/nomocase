// Unit check for public/shared/mime.js: attachments of a mail and header words (no server needed).
import assert from 'node:assert/strict';
import { decodeHeader, mailAttachments } from '../public/shared/mime.js';

const pdf = '%PDF-1.4\n% Prüfung\n';
const raw = [
  'From: =?utf-8?Q?J=C3=BCrgen?= <j@example.org>', 'Subject: Unterlagen', 'MIME-Version: 1.0',
  'Content-Type: multipart/mixed;', ' boundary="outer=_1"', '', 'Preamble, ignored.',
  '--outer=_1', 'Content-Type: multipart/alternative; boundary=inner', '',
  '--inner', 'Content-Type: text/plain; charset=utf-8', '', 'Hallo, anbei die Unterlagen.', '--inner', 'Content-Type: text/html', '', '<p>Hallo</p>', '--inner--', '',
  '--outer=_1', 'Content-Type: application/pdf', "Content-Disposition: attachment; filename*=utf-8''Pr%C3%BCfungsbericht.pdf", 'Content-Transfer-Encoding: base64', '',
  Buffer.from(pdf).toString('base64').replace(/(.{8})/g, '$1\r\n'), // line-wrapped as mail programs do
  '--outer=_1', 'Content-Type: text/plain; name="=?utf-8?B?' + Buffer.from('Notiz für dich.txt').toString('base64') + '?="', 'Content-Transfer-Encoding: quoted-printable', '',
  'Gr=C3=BC=C3=9Fe und ein sehr langer Satz, der weich =', 'umgebrochen wurde.',
  '--outer=_1--'].join('\r\n'); // the closing delimiter ends the file without a line break

const parts = mailAttachments(new TextEncoder().encode(raw));
assert.deepEqual(parts.map(p => [p.filename, p.contentType]), [['Prüfungsbericht.pdf', 'application/pdf'], ['Notiz für dich.txt', 'text/plain']],
  'only parts with a file name; nested multiparts walked; RFC 2231 and RFC 2047 names');
assert.equal(new TextDecoder().decode(parts[0].bytes), pdf, 'base64 decoded exactly (no delimiter bytes in it)');
assert.equal(new TextDecoder().decode(parts[1].bytes), 'Grüße und ein sehr langer Satz, der weich umgebrochen wurde.', 'quoted-printable with soft line breaks');

assert.deepEqual(mailAttachments(new TextEncoder().encode('Subject: x\r\n\r\nNur Text.')), [], 'a plain mail has no attachments');
assert.equal(decodeHeader('=?utf-8?B?T2s=?= =?utf-8?Q?_J=C3=BCrgen?='), 'Ok Jürgen', 'adjacent encoded words are joined');
assert.equal(decodeHeader('=?utf-8?B?***?='), '=?utf-8?B?***?=', 'a damaged word stays as it is');
console.log('ok – mime test passed');
