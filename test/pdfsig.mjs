// Unit check for src/pdfsig.js with synthetic signed PDFs (test/fixtures/make-signed-pdfs.mjs); no server needed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readSignatures, trustedIssuer } from '../src/pdfsig.js';

const load = name => new Uint8Array(readFileSync(new URL(`./fixtures/signed/${name}`, import.meta.url)));
const ca = load('test-ca.der');
const read = async (name, trusted = []) => readSignatures(load(name), trusted);

const [one] = await read('one.pdf', [ca]);
assert.equal(one.status, 'valid');
assert.deepEqual([one.subject.cn, one.subject.email, one.issuer.cn], ['Max Beispiel', 'max@example.org', 'Test-CA']);
assert.equal(one.trusted_issuer, 'Test-CA', 'chains up to the trusted CA');
assert.equal(one.covers_all, true);
assert.match(one.signed_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d/, 'signing time from the signature (or /M as fallback)');
assert.equal((await read('one.pdf'))[0].trusted_issuer, null, 'without a trusted issuer nothing is trusted');
assert.equal(await trustedIssuer(one.certs, [ca]), 'Test-CA', 'trust can be checked again from the stored certificates');

const two = await read('two.pdf', [ca]);
assert.deepEqual(two.map(s => [s.status, s.subject.cn, s.covers_all, s.self_signed]), [['valid', 'Max Beispiel', false, false], ['valid', 'Dr. Muster', true, true]],
  'a second (EC, self-signed) signature appended; the first one now covers an earlier revision');
assert.equal((await read('appended.pdf'))[0].covers_all, false, 'changed after signing');
assert.equal((await read('tampered.pdf'))[0].status, 'invalid', 'a flipped byte breaks the signature');
const [other] = await read('other-key.pdf', [ca]);
assert.equal(other.subject.email, one.subject.email);
assert.notEqual(other.key_fingerprint, one.key_fingerprint, 'same name, different key');
assert.deepEqual(await readSignatures(new TextEncoder().encode('%PDF-1.4\n%%EOF\n')), [], 'unsigned PDF');
console.log('ok – pdfsig test passed');
