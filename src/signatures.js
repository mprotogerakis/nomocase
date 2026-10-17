// Signatures in documents: which person a signing key belongs to (confirmed on first contact, optionally vouched for by
// the team), which issuers a workspace trusts, and what that means for each signature shown in a case. Recognition, not
// legal validation: a known key proves "the same signer as before", a trusted issuer "identified by that issuer".
import { fail } from './core.js';
import { canSee, caseCtx, requireWsOwner } from './access.js';
import { parseCertificate, readSignatures, trustedIssuer } from './pdfsig.js';
import { readUpload, uploadForm } from './documents.js';

const der = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const anchors = async (rq, wsId) => (await rq.rows('SELECT certificate FROM trusted_issuers WHERE workspace_id = ?', wsId)).map(r => der(r.certificate));

// Does the certificate name this person? The same e-mail, or the same name without academic titles.
const plain = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/\b(prof|dr|dipl|ing|rer|nat|habil)\b\.?/g, ' ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const sameEmail = (s, u) => !!s.subject_email && s.subject_email.toLowerCase() === u.email.toLowerCase();
const namesPerson = (s, u) => sameEmail(s, u) || (!!s.subject_name && !!plain(s.subject_name) && plain(s.subject_name) === plain(u.name));

// A parsed signature (pdfsig.js) as stored.
const asRow = s => ({
  position: s.position, status: s.status, detail: s.detail ?? null, subject_name: s.subject?.cn ?? null, subject_email: s.subject?.email ?? null,
  issuer_name: s.issuer?.cn ?? s.issuer?.o ?? null, self_signed: s.self_signed == null ? null : s.self_signed ? 1 : 0,
  key_fingerprint: s.key_fingerprint ?? null, certs: s.certs ? JSON.stringify(s.certs) : null, signed_at: s.signed_at ?? null, covers_all: s.covers_all ? 1 : 0,
});
export const signatureStmts = (rq, versionId, sigs) => sigs.map(asRow).map(r => rq.sql(`INSERT INTO document_signatures (version_id, position, status, detail,
    subject_name, subject_email, issuer_name, self_signed, key_fingerprint, certs, signed_at, covers_all) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  versionId, r.position, r.status, r.detail, r.subject_name, r.subject_email, r.issuer_name, r.self_signed, r.key_fingerprint, r.certs, r.signed_at, r.covers_all));

// Everyone a signature in this case could belong to: its participants and the workspace's members. Only their keys
// and names are used: whose a key is (and who vouched for it) stays unsaid when that person has nothing to do here.
const peopleOf = (rq, c) => rq.rows(`SELECT u.id, u.name, u.email FROM users u WHERE u.id IN (SELECT user_id FROM case_participants WHERE case_id = ?)
  OR u.id IN (SELECT user_id FROM workspace_members WHERE workspace_id = ?)`, c.id, c.workspace_id);

// What each stored signature means in this case:
//   known     – a key confirmed for a person            trusted – chains up to an issuer the workspace trusts
//   changed   – names a person who signed with another key before       unknown – not assigned yet
//   invalid / unsupported / timestamp – as read from the file
export async function explainSignatures(rq, c, sigs) {
  if (!sigs.length) return [];
  const people = await peopleOf(rq, c);
  const keys = await rq.rows(`SELECT k.*, u.name, v.name AS vouched_name FROM signing_keys k JOIN users u ON u.id = k.user_id
    LEFT JOIN users v ON v.id = k.vouched_by
    WHERE k.user_id IN (SELECT value FROM json_each(?))`, JSON.stringify(people.map(p => p.id)));
  const trusted = await anchors(rq, c.workspace_id);
  return Promise.all(sigs.map(async s => {
    const base = { version_id: s.version_id, position: s.position, status: s.status, detail: s.detail, subject_name: s.subject_name,
      subject_email: s.subject_email, issuer_name: s.issuer_name, self_signed: !!s.self_signed, signed_at: s.signed_at, covers_all: !!s.covers_all };
    if (s.status !== 'valid') return { ...base, state: s.status };
    const known = keys.find(k => k.key_fingerprint === s.key_fingerprint);
    if (known) {
      return { ...base, state: 'known', signer: known.name, signer_id: known.user_id, since: known.confirmed_at,
        vouched_by: people.some(p => p.id === known.vouched_by) ? known.vouched_name : null };
    }
    const person = people.find(p => sameEmail(s, p)) ?? people.find(p => namesPerson(s, p)); // the address beats a mere name
    const issuer = await trustedIssuer(JSON.parse(s.certs ?? '[]'), trusted, s.signed_at);
    if (issuer) return { ...base, state: 'trusted', trusted_issuer: issuer, signer: person?.name ?? s.subject_name, signer_id: person?.id ?? null };
    const before = person && keys.some(k => k.user_id === person.id);
    return { ...base, state: before ? 'changed' : 'unknown', candidate: person?.name ?? null, candidate_id: person?.id ?? null };
  }));
}

// After an upload: signatures by a person who signed with another key before are logged (and can trigger rules).
export async function signatureEvents(rq, c, versionId, doc, sigs, actorId) {
  const explained = await explainSignatures(rq, c, sigs.map(s => ({ ...asRow(s), version_id: versionId })));
  const changed = explained.filter(s => s.state === 'changed');
  return changed.length ? [rq.event(c.id, actorId, 'signature.changed', { document: doc.title, version_id: versionId, signers: changed.map(s => s.candidate) }, [])] : [];
}

async function loadSignature(rq, user, versionId, position) {
  const { row } = rq;
  const v = (await row(`SELECT v.id, d.case_id, d.visible_to, d.created_by, d.title FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = ?`, versionId))
    ?? fail(404, 'Fassung nicht gefunden');
  const ctx = await caseCtx(rq, user, v.case_id);
  if (!canSee(ctx, v)) fail(404, 'Fassung nicht gefunden');
  const sig = (await row('SELECT * FROM document_signatures WHERE version_id = ? AND position = ?', versionId, Number(position))) ?? fail(404, 'Signatur nicht gefunden');
  if (sig.status !== 'valid' || !sig.key_fingerprint) fail(400, 'Diese Signatur ist nicht gültig und lässt sich nicht zuordnen.');
  return { ctx, sig, doc: v };
}

// Binds a key to a person. A key belongs to one person; vouchedBy marks a team member who confirmed it.
async function bind(rq, sig, userId, vouchedBy, extra = []) {
  const { row, sql, batch, time } = rq;
  const existing = await row('SELECT user_id, vouched_by FROM signing_keys WHERE key_fingerprint = ?', sig.key_fingerprint);
  if (existing && existing.user_id !== userId) fail(409, 'Dieser Schlüssel ist schon einer anderen Person zugeordnet.');
  await batch([
    existing ? sql('UPDATE signing_keys SET vouched_by = COALESCE(vouched_by, ?), vouched_at = COALESCE(vouched_at, ?) WHERE key_fingerprint = ?', vouchedBy, vouchedBy && time, sig.key_fingerprint)
      : sql('INSERT INTO signing_keys (key_fingerprint, user_id, subject_name, issuer_name, confirmed_at, vouched_by, vouched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        sig.key_fingerprint, userId, sig.subject_name, sig.issuer_name, time, vouchedBy, vouchedBy && time),
    ...extra,
  ]);
}

// "Das ist meine Signatur": only when the certificate carries the account's e-mail address (a display name anyone can
// choose for themselves); anything else goes through the team.
export async function claimSignature(rq) {
  const { user, body, event } = rq;
  const { ctx, sig, doc } = await loadSignature(rq, user, body.version_id, body.position);
  if (!sameEmail(sig, user)) fail(403, 'Das Zertifikat nennt nicht Ihre E-Mail-Adresse. Die Verantwortlichen des Vorgangs können die Signatur zuordnen.');
  await bind(rq, sig, user.id, null, [event(ctx.c.id, user.id, 'signature.assigned', { document: doc.title, signer: user.name, self: true }, [])]);
}

// The team assigns (and thereby vouches for) a signature, e.g. when the certificate spells the name differently.
export async function assignSignature(rq) {
  const { user, body, event } = rq;
  const { ctx, sig, doc } = await loadSignature(rq, user, body.version_id, body.position);
  if (!ctx.owner) fail(403, 'Nur Vorgangsverantwortliche können Signaturen zuordnen');
  const person = (await peopleOf(rq, ctx.c)).find(p => p.id === body.user_id) ?? fail(400, 'Diese Person ist nicht beteiligt');
  await bind(rq, sig, person.id, user.id, [event(ctx.c.id, user.id, 'signature.assigned', { document: doc.title, signer: person.name }, [])]);
}

export async function mySigningKeys({ user, rows }) {
  return rows(`SELECT k.key_fingerprint, k.subject_name, k.issuer_name, k.confirmed_at, k.vouched_at, v.name AS vouched_by FROM signing_keys k
    LEFT JOIN users v ON v.id = k.vouched_by WHERE k.user_id = ? ORDER BY k.confirmed_at`, user.id);
}

// Account page: register the own key from a signed sample PDF (nothing is stored but the key binding).
export async function addSigningKey(rq) {
  const { user, req } = rq;
  const form = await uploadForm(req);
  const f = await readUpload(form.get('file'), true);
  if (f.problem) fail(422, f.problem);
  const mine = (await readSignatures(f.bytes, [], f.pdf)).map(asRow).filter(s => s.status === 'valid' && sameEmail(s, user));
  if (!mine.length) fail(400, 'In dieser PDF ist keine gültige Signatur, deren Zertifikat Ihre E-Mail-Adresse nennt. Die Verantwortlichen eines Vorgangs können Ihre Signatur dort zuordnen.');
  if (new Set(mine.map(s => s.key_fingerprint)).size > 1) fail(409, 'Die PDF enthält mehrere Schlüssel mit Ihrer E-Mail-Adresse. Bitte eine PDF mit nur Ihrer Signatur verwenden.');
  await bind(rq, mine[0], user.id, null);
  return { subject_name: mine[0].subject_name, issuer_name: mine[0].issuer_name };
}

export async function removeSigningKey({ user, params, sql }) {
  const { meta } = await sql('DELETE FROM signing_keys WHERE key_fingerprint = ? AND user_id = ?', params.fp, user.id).run();
  if (!meta.changes) fail(404, 'Schlüssel nicht gefunden');
}

// Workspace owners: issuers whose certificates count as identified (PEM or base64 DER of the issuer certificate).
export async function addTrustedIssuer(rq) {
  const { user, params, body, sql, batch, wsEvent, time } = rq;
  await requireWsOwner(rq, user, params.id);
  const b64 = String(body.certificate ?? '').replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  let cert;
  try { cert = parseCertificate(der(b64)); } catch { fail(400, 'Das ist kein lesbares Zertifikat (PEM oder DER).'); }
  const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', cert.spki))].map(x => x.toString(16).padStart(2, '0')).join('');
  await batch([sql(`INSERT INTO trusted_issuers (workspace_id, fingerprint, name, certificate, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, fingerprint) DO NOTHING`, params.id, fingerprint, cert.subject.cn ?? cert.subject.o ?? 'Aussteller', b64, user.id, time),
    wsEvent(params.id, user.id, 'issuer.added', { issuer: cert.subject.cn ?? cert.subject.o ?? 'Aussteller' })]);
  return { name: cert.subject.cn ?? cert.subject.o, fingerprint };
}

export async function removeTrustedIssuer(rq) {
  const { user, params, row, sql, batch, wsEvent } = rq;
  await requireWsOwner(rq, user, params.id);
  const issuer = await row('SELECT name FROM trusted_issuers WHERE workspace_id = ? AND fingerprint = ?', params.id, params.fp);
  if (!issuer) return;
  await batch([sql('DELETE FROM trusted_issuers WHERE workspace_id = ? AND fingerprint = ?', params.id, params.fp),
    wsEvent(params.id, user.id, 'issuer.removed', { issuer: issuer.name })]);
}

export const trustedIssuersOf = (rq, wsIds) => rq.rows(`SELECT workspace_id, fingerprint, name, added_at FROM trusted_issuers
  WHERE workspace_id IN (SELECT value FROM json_each(?)) ORDER BY name`, JSON.stringify(wsIds));
