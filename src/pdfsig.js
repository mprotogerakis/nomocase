// Digital signatures inside PDFs (PAdES / Acrobat: adbe.pkcs7.detached, ETSI.CAdES.detached): who signed, with which
// key, and whether the signed bytes are unchanged. Pure functions on bytes plus WebCrypto. Trust is either a key the
// platform recognises (signatures.js) or a chain up to an issuer the workspace trusts (e.g. its own small CA).
// ponytail: no revocation (CRL/OCSP) and no EU trusted list; add when qualified signatures must be recognised.

const latin1 = b => new TextDecoder('latin1').decode(b);
const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');

// --- DER (with BER indefinite lengths, which some signing tools write) ---------------------------------------------
// Every length is checked against the end of the data, so damaged or crafted input ends in an error, never in a loop.
function node(b, pos) {
  if (pos + 2 > b.length) throw new Error('DER: Ende erreicht');
  const tag = b[pos];
  let len = b[pos + 1], header = 2;
  if (len === 0x80) { // indefinite: children until the end-of-contents marker 00 00
    let p = pos + 2;
    while (!(b[p] === 0 && b[p + 1] === 0)) {
      if (p + 2 > b.length) throw new Error('DER: Ende-Markierung fehlt');
      p = node(b, p).end;
    }
    return { b, tag, start: pos, header: 2, end: p + 2, bodyEnd: p };
  }
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4 || pos + 2 + n > b.length) throw new Error('DER: Länge ungültig');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[pos + 2 + i];
    header = 2 + n;
  }
  if (pos + header + len > b.length) throw new Error('DER: Länge über das Ende hinaus');
  return { b, tag, start: pos, header, end: pos + header + len, bodyEnd: pos + header + len };
}
const kids = n => { const out = []; for (let p = n.start + n.header; p < n.bodyEnd;) { const c = node(n.b, p); out.push(c); p = c.end; } return out; };
const body = n => n.b.subarray(n.start + n.header, n.bodyEnd);
const raw = n => n.b.subarray(n.start, n.end);

function oid(n) {
  const v = body(n), out = [Math.floor(v[0] / 40), v[0] % 40];
  for (let i = 1, x = 0; i < v.length; i++) { x = x * 128 + (v[i] & 0x7f); if (!(v[i] & 0x80)) { out.push(x); x = 0; } }
  return out.join('.');
}
function text(n) {
  const v = body(n);
  if (n.tag === 0x1e) { let s = ''; for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode(v[i] << 8 | v[i + 1]); return s; } // BMPString
  return new TextDecoder(n.tag === 0x0c ? 'utf-8' : 'latin1').decode(v);
}
function time(n) { // UTCTime (YYMMDDhhmmssZ) or GeneralizedTime (YYYYMMDDhhmmssZ)
  const s = latin1(body(n)), y = n.tag === 0x17 ? s.slice(0, 2) : s.slice(0, 4), r = s.slice(y.length);
  const year = n.tag === 0x17 ? (Number(y) < 50 ? 2000 : 1900) + Number(y) : Number(y);
  return `${year}-${r.slice(0, 2)}-${r.slice(2, 4)}T${r.slice(4, 6)}:${r.slice(6, 8)}:${r.slice(8, 10) || '00'}Z`;
}
const NAME_OIDS = { '2.5.4.3': 'cn', '2.5.4.10': 'o', '2.5.4.11': 'ou', '2.5.4.6': 'c', '1.2.840.113549.1.9.1': 'email' };
function name(n) {
  const out = {};
  for (const rdn of kids(n)) for (const atv of kids(rdn)) {
    const [type, value] = kids(atv);
    const key = NAME_OIDS[oid(type)];
    if (key && !out[key]) out[key] = text(value);
  }
  return out;
}

// May this certificate issue others? basicConstraints cA and, if key usage is given, keyCertSign.
function issuesCertificates(fields) {
  const ext = fields.find(x => x.tag === 0xa3);
  if (!ext) return false; // v1 certificates carry no CA marker
  let ca = false, keyCertSign = true;
  for (const e of kids(kids(ext)[0])) {
    const [id, ...rest] = kids(e);
    const value = body(rest.at(-1));
    if (oid(id) === '2.5.29.19') ca = kids(node(value, 0)).some(x => x.tag === 0x01 && body(x)[0] !== 0); // cA BOOLEAN TRUE
    if (oid(id) === '2.5.29.15') { const bits = body(node(value, 0)); keyCertSign = !!(bits[1] & 0x04); } // bit 5
  }
  return ca && keyCertSign;
}

function certificate(n) {
  const tbs = kids(kids(n)[0]);
  const f = tbs[0].tag === 0xa0 ? tbs.slice(1) : tbs; // optional [0] version
  const [serial, , issuer, validity, subject, spki] = f;
  let ca = false;
  try { ca = issuesCertificates(f.slice(6)); } catch { /* unreadable extensions: not a CA */ }
  const [from, to] = kids(validity);
  const [tbsNode, sigAlg, sigValue] = kids(n);
  return { node: n, serial: hex(body(serial)), issuerRaw: hex(raw(issuer)), subjectRaw: hex(raw(subject)), issuer: name(issuer), subject: name(subject),
    selfSigned: hex(raw(issuer)) === hex(raw(subject)), notBefore: time(from), notAfter: time(to), spki: raw(spki), ca,
    tbs: raw(tbsNode), sigAlg, signature: body(sigValue).subarray(1) }; // BIT STRING: first byte counts unused bits
}

export const parseCertificate = der => certificate(node(der, 0));

// The issuer's key signed this certificate.
const signedBy = (cert, issuer) => verifySignature(issuer, cert.sigAlg, 'SHA-256', cert.tbs, cert.signature).catch(() => false);

// Walks from the signer certificate up to one of the trusted issuers, through certificates that came with the
// signature (intermediates). Every certificate on the way must be valid at the signing time (`at`, else now), and
// every issuer must be a CA: an ordinary user certificate of a trusted CA must not vouch for another name.
// Returns the trusted issuer or null.
async function chainTo(cert, pool, trusted, at) {
  const when = Date.parse(at ?? '') || Date.now();
  const valid = c => Date.parse(c.notBefore) <= when && when <= Date.parse(c.notAfter);
  let cur = cert;
  for (let depth = 0; depth < 5; depth++) {
    if (!valid(cur)) return null;
    const anchor = trusted.find(t => hex(t.spki) === hex(cur.spki));
    if (anchor) return anchor; // the trusted certificate itself
    const byTrusted = trusted.find(t => t.subjectRaw === cur.issuerRaw);
    if (byTrusted) return byTrusted.ca && valid(byTrusted) && (await signedBy(cur, byTrusted)) ? byTrusted : null;
    const next = pool.find(c => c.subjectRaw === cur.issuerRaw && c !== cur);
    if (!next || !next.ca || cur.selfSigned || !(await signedBy(cur, next))) return null;
    cur = next;
  }
  return null;
}

// --- verification --------------------------------------------------------------------------------------------------
const HASH = { '1.3.14.3.2.26': 'SHA-1', '2.16.840.1.101.3.4.2.1': 'SHA-256', '2.16.840.1.101.3.4.2.2': 'SHA-384', '2.16.840.1.101.3.4.2.3': 'SHA-512' };
const SIG_HASH = { '1.2.840.113549.1.1.5': 'SHA-1', '1.2.840.113549.1.1.11': 'SHA-256', '1.2.840.113549.1.1.12': 'SHA-384', '1.2.840.113549.1.1.13': 'SHA-512',
  '1.2.840.10045.4.3.2': 'SHA-256', '1.2.840.10045.4.3.3': 'SHA-384', '1.2.840.10045.4.3.4': 'SHA-512' };
const CURVES = { '1.2.840.10045.3.1.7': ['P-256', 32], '1.3.132.0.34': ['P-384', 48], '1.3.132.0.35': ['P-521', 66] };

// ECDSA signatures are DER (r, s) in CMS but raw r‖s for WebCrypto.
function ecdsaRaw(sig, size) {
  const [r, s] = kids(node(sig, 0)).map(body);
  const fit = x => { const t = x.subarray(Math.max(0, x.length - size)); const o = new Uint8Array(size); o.set(t, size - t.length); return o; };
  const out = new Uint8Array(size * 2);
  out.set(fit(r), 0); out.set(fit(s), size);
  return out;
}

async function verifySignature(cert, sigAlg, digestHash, data, signature) {
  const alg = oid(kids(sigAlg)[0]);
  const keyAlg = oid(kids(kids(node(cert.spki, 0))[0])[0]);
  if (keyAlg === '1.2.840.113549.1.1.1') { // RSA
    if (alg === '1.2.840.113549.1.1.10') throw new Error('RSA-PSS wird noch nicht geprüft');
    const hash = SIG_HASH[alg] ?? digestHash;
    const key = await crypto.subtle.importKey('spki', cert.spki, { name: 'RSASSA-PKCS1-v1_5', hash }, false, ['verify']);
    return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, data);
  }
  if (keyAlg === '1.2.840.10045.2.1') { // EC
    const [curve, size] = CURVES[oid(kids(kids(node(cert.spki, 0))[0])[1])] ?? [];
    if (!curve) throw new Error('unbekannte Kurve');
    const key = await crypto.subtle.importKey('spki', cert.spki, { name: 'ECDSA', namedCurve: curve }, false, ['verify']);
    return crypto.subtle.verify({ name: 'ECDSA', hash: SIG_HASH[alg] ?? digestHash }, key, ecdsaRaw(signature, size), data);
  }
  throw new Error('Schlüsseltyp wird nicht geprüft');
}

const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// One signature: the CMS blob from /Contents and the bytes its /ByteRange covers.
async function checkCms(cms, signed, trusted) {
  const signedData = kids(kids(kids(node(cms, 0))[1])[0]);
  const certs = (signedData.find(n => n.tag === 0xa0) ? kids(signedData.find(n => n.tag === 0xa0)) : []).filter(n => n.tag === 0x30).map(certificate);
  const signer = kids(kids(signedData.at(-1))[0]);
  const [, sid, digestAlg, ...rest] = signer;
  const attrs = rest[0].tag === 0xa0 ? rest.shift() : null;
  const [sigAlg, sigValue] = rest;
  // signer certificate: issuer + serial, or subject key identifier
  let cert;
  if (sid.tag === 0x30) {
    const [iss, ser] = kids(sid);
    cert = certs.find(c => c.issuerRaw === hex(raw(iss)) && c.serial === hex(body(ser)));
  }
  cert ??= certs[0];
  if (!cert) return { status: 'unsupported', detail: 'kein Zertifikat in der Signatur' };
  const hash = HASH[oid(kids(digestAlg)[0])] ?? 'SHA-256';
  const digest = new Uint8Array(await crypto.subtle.digest(hash, signed));
  let signingTime = null, ok;
  if (attrs) {
    let messageDigest = null;
    for (const a of kids(attrs)) {
      const [type, values] = kids(a);
      const id = oid(type), v = kids(values)[0];
      if (id === '1.2.840.113549.1.9.4') messageDigest = body(v);
      if (id === '1.2.840.113549.1.9.5') signingTime = time(v);
    }
    const toVerify = new Uint8Array(raw(attrs)); // signed attributes are signed as SET (tag 31), stored as [0] (tag A0)
    toVerify[0] = 0x31;
    ok = !!messageDigest && equal(messageDigest, digest) && await verifySignature(cert, sigAlg, hash, toVerify, body(sigValue));
  } else {
    ok = await verifySignature(cert, sigAlg, hash, signed, body(sigValue));
  }
  const anchor = ok && trusted.length ? await chainTo(cert, certs, trusted, signingTime) : null;
  const b64 = c => btoa(String.fromCharCode(...raw(c.node)));
  return {
    certs: [cert, ...certs.filter(c => c !== cert)].map(b64), // signer first; lets trust be checked again later
    status: ok ? 'valid' : 'invalid', detail: ok ? null : 'Unterschrift passt nicht zu den signierten Daten',
    trusted_issuer: anchor ? anchor.subject.cn ?? anchor.subject.o ?? 'Aussteller' : null,
    subject: cert.subject, issuer: cert.issuer, self_signed: cert.selfSigned, not_before: cert.notBefore, not_after: cert.notAfter,
    signed_at: signingTime, key_fingerprint: hex(await crypto.subtle.digest('SHA-256', cert.spki)),
  };
}

// Trusted issuer for a stored signature (certificates as base64 DER, signer first; `at`: signing time), or null.
export async function trustedIssuer(certs, trusted, at) {
  if (!certs?.length || !trusted.length) return null;
  const parsed = certs.map(c => parseCertificate(Uint8Array.from(atob(c), x => x.charCodeAt(0))));
  const anchor = await chainTo(parsed[0], parsed.slice(1), trusted.map(parseCertificate), at);
  return anchor ? anchor.subject.cn ?? anchor.subject.o ?? 'Aussteller' : null;
}

// PDF date "D:20260706123602+02'00'" → ISO time.
function pdfDate(s) {
  const m = s?.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(Z|[+-])?(\d{2})?'?(\d{2})?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se = '00', sign, oh = '00', om = '00'] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${se}${!sign || sign === 'Z' ? 'Z' : `${sign}${oh}:${om}`}`).toISOString();
}

const MAX_SIGNATURES = 20;

// All signatures of a PDF, in file order. A signature "covers all" when nothing was appended after it.
// `trusted`: DER certificates of issuers the workspace trusts.
export async function readSignatures(bytes, trusted = []) {
  const anchors = trusted.map(parseCertificate);
  const s = latin1(bytes), out = [];
  for (const m of s.matchAll(/\/ByteRange\s*\[\s*(\d{1,12})\s+(\d{1,12})\s+(\d{1,12})\s+(\d{1,12})\s*\]/g)) {
    if (out.length >= MAX_SIGNATURES) break; // each one hashes up to the whole file
    const [a0, a1, b0, b1] = m.slice(1).map(Number);
    const dict = s.slice(Math.max(0, s.lastIndexOf(' obj', m.index)), s.indexOf('endobj', m.index));
    const sub = dict.match(/\/SubFilter\s*\/([\w.]+)/)?.[1] ?? null;
    const type = dict.match(/\/Type\s*\/(\w+)/)?.[1] ?? 'Sig';
    const base = { position: out.length, subfilter: sub, covers_all: b0 + b1 === bytes.length, claimed_at: pdfDate(dict.match(/\/M\s*\((D:[^)]*)\)/)?.[1]) };
    if (type === 'DocTimeStamp' || sub === 'ETSI.RFC3161') { out.push({ ...base, status: 'timestamp', detail: 'Zeitstempel' }); continue; }
    if (a0 !== 0 || b0 + b1 > bytes.length || a1 >= b0) { out.push({ ...base, status: 'invalid', detail: 'ByteRange ungültig' }); continue; }
    if (!['adbe.pkcs7.detached', 'ETSI.CAdES.detached'].includes(sub)) { out.push({ ...base, status: 'unsupported', detail: `Format ${sub ?? '?'} wird nicht geprüft` }); continue; }
    try {
      const gap = s.slice(a1, b0).trim();
      const cms = Uint8Array.from(gap.slice(1, -1).match(/[0-9a-fA-F]{2}/g) ?? [], h => parseInt(h, 16));
      const signed = new Uint8Array(a1 + b1);
      signed.set(bytes.subarray(0, a1), 0);
      signed.set(bytes.subarray(b0, b0 + b1), a1);
      const r = await checkCms(cms, signed, anchors);
      out.push({ ...base, ...r, signed_at: r.signed_at ?? base.claimed_at, claimed_at: undefined });
    } catch (e) {
      out.push({ ...base, status: 'unsupported', detail: `nicht lesbar (${e.message})` });
    }
  }
  return out;
}
