// Sessions, passkeys, login links, dev login and the own account.
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { appVersion, arr, fail, hex, json, sessionFrom, sha256, token, uid } from './core.js';
import { caseCtx } from './access.js';
import { checkSenderCap, mailAnswer, outboxStmt, sendFromOutbox } from './notify.js';
import { CONSENT_VERSION } from '../public/shared/consent.js';

// The canonical origin. Not the request URL: wrangler dev rewrites that to the production route.
export const originOf = (rq, url) => rq.env.ORIGIN || url.origin;

const rpOf = (rq, url) => new URL(originOf(rq, url)).hostname;

// Over https the session cookie is "__Host-sid": the prefix makes browsers refuse it unless it is Secure, for this
// host only and for the whole site, so a sibling subdomain cannot plant a session (sessionFrom ignores plain "sid"
// there). Plain "sid" locally over http.
const sidOf = (rq, req) => sessionFrom(req.headers.get('cookie'), originOf(rq, new URL(req.url)).startsWith('https:'));
const CLEAR = [['set-cookie', '__Host-sid=; Path=/; Max-Age=0; Secure'], ['set-cookie', 'sid=; Path=/; Max-Age=0']];

export async function loadUser(rq, req) {
  const { row, time } = rq;
  const sid = sidOf(rq, req);
  return sid
    ? row(`SELECT u.*, EXISTS (SELECT 1 FROM consents c WHERE c.user_id = u.id AND c.version = ? AND c.withdrawn_at IS NULL) AS consented
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`, CONSENT_VERSION, await sha256(sid), time)
    : null;
}

export async function sessionCookie(rq, userId, url) {
  const { sql } = rq;
  const t = token();
  await sql('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    await sha256(t), userId, new Date(Date.now() + 30 * 864e5).toISOString()).run();
  const secure = originOf(rq, url).startsWith('https:');
  return `${secure ? '__Host-' : ''}sid=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`;
}

export async function me(rq) {
  const { user, row, rows, env, rpId } = rq;
  if (!user) return { user: null, dev_users: env.DEV_LOGIN ? await rows('SELECT email, name FROM users ORDER BY name') : null };
  const workspaces = await rows('SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.name', user.id);
  const { n } = await row('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ? AND rp_id IS ?', user.id, rpId);
  const consent = await row('SELECT accepted_at FROM consents WHERE user_id = ? AND version = ? AND withdrawn_at IS NULL', user.id, CONSENT_VERSION);
  return { user: { id: user.id, name: user.name, email: user.email, email_reminders: !!user.email_reminders, email_progress: !!user.email_progress }, workspaces, passkeys: n, dev: !!env.DEV_LOGIN, version: appVersion(env),
    consent: { version: CONSENT_VERSION, accepted: !!consent, accepted_at: consent?.accepted_at ?? null } };
}

export async function updateMe(rq) {
  const { user, body, sql } = rq;
  const keys = ['email_reminders', 'email_progress'].filter(k => k in body);
  if (!keys.length || !keys.every(k => typeof body[k] === 'boolean')) fail(400, 'email_reminders/email_progress müssen true oder false sein');
  await sql(`UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => (body[k] ? 1 : 0)), user.id).run();
}

// One-time login link by mail: requested on the login page, or sent by a case owner to a participant (`sender`).
// At most one unused link per person every 10 minutes and five a day, so nobody can flood an inbox; self-service
// requests (from anyone, no login) have a daily total so strangers cannot use up the mail quota (and a limit per
// address, see worker.js). One statement checks and inserts, so parallel requests cannot all see the same free capacity.
const LOGIN_REQUEST_CAP = 60;
const LINKS_PER_PERSON = 5;

async function mailLoginLink(rq, u, url, kind = null, sender = null) {
  const { row, sql, batch, time } = rq;
  // A link whose mail has not gone out yet (the provider failed): asking again continues it – the same link.
  const open = await row(`SELECT o.id FROM login_links l JOIN mail_outbox o ON o.ref = l.token_hash AND o.status = 'pending'
    WHERE l.user_id = ? AND l.used_at IS NULL AND l.expires_at > ?`, u.id, time);
  if (open) return mailAnswer(await sendFromOutbox(rq, open.id));
  if (sender) await checkSenderCap(rq, sender);
  const t = token(), hash = await sha256(t), at = time, day = 864e5, mailId = uid();
  const link = `${originOf(rq, url)}/#/login/${t}`;
  // The link and its mail in one transaction; the outbox row only goes in if the limits let the link in.
  const [made] = await batch([sql(`INSERT INTO login_links (token_hash, user_id, expires_at, kind) SELECT ?1, ?2, ?3, ?4
    WHERE NOT EXISTS (SELECT 1 FROM login_links WHERE user_id = ?2 AND used_at IS NULL AND expires_at > ?5)
      AND (SELECT COUNT(*) FROM login_links WHERE user_id = ?2 AND expires_at > ?6) < ?7
      AND (?4 IS NULL OR (SELECT COUNT(*) FROM login_links WHERE kind = ?4 AND expires_at > ?6) < ?8)`,
  hash, u.id, new Date(Date.now() + day).toISOString(), kind, new Date(Date.now() + day - 10 * 60e3).toISOString(), at, LINKS_PER_PERSON, LOGIN_REQUEST_CAP),
  outboxStmt(rq, { id: mailId, kind: 'login_link', ref: hash, to: u.email, subject: 'Ihr Anmeldelink für NomoCase', sender, mailKind: kind, paragraphs: [
    `Guten Tag ${u.name},`,
    `mit diesem Link melden Sie sich bei NomoCase an:\n${link}`,
    'Der Link ist 24 Stunden gültig und funktioniert nur einmal. Richten Sie danach am besten einen Passkey ein, dann brauchen Sie keinen Link mehr.',
    'Falls Sie keinen Anmeldelink angefordert haben, ignorieren Sie diese E-Mail einfach.'] })]);
  if (!made.meta.changes) {
    if (kind && (await row('SELECT COUNT(*) AS n FROM login_links WHERE kind = ? AND expires_at > ?', kind, at)).n >= LOGIN_REQUEST_CAP) console.error('login link requests: daily cap reached');
    return { throttled: true };
  }
  return { ...mailAnswer(await sendFromOutbox(rq, mailId)), link };
}

export async function requestLoginLink(rq) {
  const { body, url, exec, row, env } = rq;
  const email = String(body.email ?? '').trim().toLowerCase();
  const u = email ? await row('SELECT id, email, name FROM users WHERE email = ?', email) : null;
  // Same answer, same speed, whether or not the address has an account. Locally the link comes back for testing.
  if (env.DEV_LOGIN) {
    const r = u ? await mailLoginLink(rq, u, url, 'login_request') : {};
    return r.link ? { ok: true, link: r.link } : { ok: true };
  }
  if (u) exec.waitUntil(mailLoginLink(rq, u, url, 'login_request').catch(e => console.error('login link', e.message)));
  return { ok: true };
}

export async function sendParticipantLink(rq) {
  const { user, params, url, row, event, env, time } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  if (!ctx.owner) fail(403, 'Nur Vorgangsverantwortliche');
  const p = (await row(`SELECT u.id, u.email, u.name FROM case_participants p JOIN users u ON u.id = p.user_id
    WHERE p.case_id = ? AND p.user_id = ? AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?)`, ctx.c.id, params.userId, time))
    ?? fail(404, 'Nicht (mehr) beteiligt');
  const r = await mailLoginLink(rq, p, url, null, user.id);
  if (r.throttled) fail(429, 'Es wurde gerade erst (oder heute schon mehrmals) ein Anmeldelink verschickt. Bitte später erneut versuchen.');
  await event(ctx.c.id, user.id, 'participant.link_sent', { name: p.name }, []).run();
  const answer = { sent: r.sent, queued: r.queued }; // queued: the outbox delivers it as soon as the provider takes it
  return env.DEV_LOGIN && r.link ? { ...answer, link: r.link } : answer;
}

export async function useLoginLink(rq) {
  const { body, url, row, time } = rq;
  const link = (await row('UPDATE login_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id',
    time, await sha256(String(body.token ?? '')), time)) ?? fail(404, 'Anmeldelink ungültig oder abgelaufen');
  return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(rq, link.user_id, url) });
}

// RP ID and origin come from ORIGIN (localhost in .dev.vars, the custom domain in production).

async function newChallenge(rq, options, userId = null) {
  const { sql, batch, time } = rq;
  const id = uid();
  await batch([
    sql('DELETE FROM challenges WHERE expires_at < ?', time),
    sql('INSERT INTO challenges (id, challenge, user_id, expires_at) VALUES (?, ?, ?, ?)', id, options.challenge, userId, new Date(Date.now() + 5 * 60e3).toISOString()),
  ]);
  return { challenge_id: id, options };
}

// Registration (signed in): single use, the challenge is deleted by the same statement that reads it.
const takeChallenge = async (rq, id, userId) =>
  (await rq.row('DELETE FROM challenges WHERE id = ? AND user_id IS ? AND expires_at > ? RETURNING challenge', String(id ?? ''), userId, rq.time))?.challenge
  ?? fail(400, 'Anmeldeversuch abgelaufen, bitte erneut versuchen');

export async function passkeyRegisterOptions(rq) {
  const { user, url, rows } = rq;
  const existing = await rows('SELECT id, transports FROM passkeys WHERE user_id = ? AND rp_id IS ?', user.id, rpOf(rq, url));
  return newChallenge(rq, await generateRegistrationOptions({
    rpName: 'NomoCase',
    rpID: rpOf(rq, url),
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    excludeCredentials: existing.map(p => ({ id: p.id, transports: arr(p.transports) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  }), user.id);
}

export async function passkeyRegisterVerify(rq) {
  const { user, url, body, sql, time } = rq;
  const expectedChallenge = await takeChallenge(rq, body.challenge_id, user.id);
  const { verified, registrationInfo } = await verifyRegistrationResponse({ response: body.response, expectedChallenge, expectedOrigin: originOf(rq, url), expectedRPID: rpOf(rq, url) })
    .catch(e => fail(400, `Passkey ungültig: ${e.message}`));
  if (!verified) fail(400, 'Passkey ungültig');
  const { id, publicKey, counter, transports } = registrationInfo.credential;
  await sql('INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at, rp_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, user.id, isoBase64URL.fromBuffer(publicKey), counter, JSON.stringify(transports ?? []), time, rpOf(rq, url)).run();
}

// Login challenges are signed instead of stored ("<expiry>.<nonce>.<HMAC>"): asking for one writes nothing, so anonymous
// requests cannot fill D1. Only a successful login writes, to use its challenge up (no replay of a recorded response).
let loginKey = null; // a cache, not request state: the key is made once, kept in D1 (app_secrets) and never changes
async function challengeKey(rq) {
  const { row, sql } = rq;
  if (loginKey) return loginKey;
  const read = () => row("SELECT value FROM app_secrets WHERE name = 'login_challenge'");
  let r = await read();
  if (!r) { await sql("INSERT OR IGNORE INTO app_secrets (name, value) VALUES ('login_challenge', ?)", token()).run(); r = await read(); }
  return (loginKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(r.value), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
}
const challengeMac = async (rq, body) => hex(await crypto.subtle.sign('HMAC', await challengeKey(rq), new TextEncoder().encode(body)));
const macValid = async (rq, body, mac) => /^[0-9a-f]{64}$/.test(mac ?? '') // compared in constant time by the platform
  && crypto.subtle.verify('HMAC', await challengeKey(rq), Uint8Array.from(mac.match(/../g), h => parseInt(h, 16)), new TextEncoder().encode(body));

// No allowCredentials: discoverable credentials, so the browser offers the user's passkeys without asking for an email.
export async function passkeyLoginOptions(rq) {
  const { url } = rq;
  const body = `${Date.now() + 5 * 60e3}.${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  return { options: await generateAuthenticationOptions({ rpID: rpOf(rq, url), userVerification: 'required', challenge: `${body}.${await challengeMac(rq, body)}` }) };
}

export async function passkeyLoginVerify(rq) {
  const { url, body, row, sql, time } = rq;
  let used = null; // the challenge the response signed, once its signature and expiry check out
  const expectedChallenge = async encoded => {
    const s = isoBase64URL.toUTF8String(encoded), [expiry, nonce, mac] = s.split('.');
    if (!(Number(expiry) > Date.now()) || !(await macValid(rq, `${expiry}.${nonce}`, mac))) return false;
    used = { nonce, expiry: new Date(Number(expiry)).toISOString() };
    return true;
  };
  const pk = (await row('SELECT * FROM passkeys WHERE id = ?', String(body.response?.id ?? ''))) ?? fail(400, 'Passkey unbekannt');
  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response: body.response, expectedChallenge, expectedOrigin: originOf(rq, url), expectedRPID: rpOf(rq, url),
    credential: { id: pk.id, publicKey: isoBase64URL.toBuffer(pk.public_key), counter: pk.counter, transports: arr(pk.transports) },
  }).catch(e => fail(400, /challenge/i.test(e.message) ? 'Anmeldeversuch abgelaufen, bitte erneut versuchen' : `Anmeldung fehlgeschlagen: ${e.message}`));
  if (!verified || !used) fail(400, 'Anmeldung fehlgeschlagen');
  // single use: two requests with the same response get one session
  if (!(await row("INSERT INTO challenges (id, challenge, expires_at) VALUES (?, 'login', ?) ON CONFLICT DO NOTHING RETURNING id", `login:${used.nonce}`, used.expiry))) {
    fail(400, 'Anmeldeversuch abgelaufen, bitte erneut versuchen');
  }
  await sql('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?', authenticationInfo.newCounter, time, pk.id).run();
  return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(rq, pk.user_id, url) });
}

export async function listPasskeys(rq) {
  const { user, url, rows } = rq;
  return (await rows('SELECT id, created_at, last_used_at, rp_id FROM passkeys WHERE user_id = ? ORDER BY created_at', user.id))
    .map(p => ({ ...p, usable: p.rp_id === rpOf(rq, url) }));
}

export async function deletePasskey(rq) {
  const { user, params, sql } = rq;
  const { meta } = await sql('DELETE FROM passkeys WHERE id = ? AND user_id = ?', params.id, user.id).run();
  if (!meta.changes) fail(404, 'Passkey nicht gefunden');
}

// Local-only shortcut (DEV_LOGIN comes from .dev.vars, which is never deployed).
export async function devLogin(rq) {
  const { body, url, row, env } = rq;
  if (!env.DEV_LOGIN) fail(404, 'Nicht gefunden');
  const u = (await row('SELECT id FROM users WHERE email = ?', body.email ?? null)) ?? fail(404, 'Unbekannter Benutzer');
  await consentStmt(rq, u.id).run(); // dev only: test accounts have agreed (the consent gate has its own tests)
  return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(rq, u.id, url) });
}

// --- consent (public/shared/consent.js) ---------------------------------------------------------------------------
// Using NomoCase is voluntary; whoever uses it agrees to the processing first. Every agreement is kept per text version.
export const consentStmt = (rq, userId) => rq.sql(`INSERT INTO consents (user_id, version, accepted_at) VALUES (?, ?, ?)
  ON CONFLICT (user_id, version) DO UPDATE SET accepted_at = excluded.accepted_at, withdrawn_at = NULL`, userId, CONSENT_VERSION, rq.time);
export const hasConsent = async (rq, userId) => !!(await rq.row('SELECT 1 FROM consents WHERE user_id = ? AND version = ? AND withdrawn_at IS NULL', userId, CONSENT_VERSION));

// Who operates NomoCase and whom to contact – shown in the consent text, also before login (invitations, upload links).
export const legalInfo = ({ env }) => ({ version: CONSENT_VERSION, operator: env.OPERATOR ?? '[Betreiber]', contact: env.PRIVACY_CONTACT ?? '[Kontakt]' });

export async function giveConsent(rq) {
  const { user, body } = rq;
  if (body.version !== CONSENT_VERSION) fail(409, 'Der Text wurde inzwischen geändert. Bitte neu laden.');
  await consentStmt(rq, user.id).run();
}

// Withdrawing ends the use: logged out everywhere; the cases' teams learn to continue the conventional way.
export async function withdrawConsent(rq) {
  const { user, rows, sql, batch, event, time } = rq;
  const cases = await rows('SELECT case_id FROM case_participants WHERE user_id = ? AND revoked_at IS NULL', user.id);
  await batch([
    sql('UPDATE consents SET withdrawn_at = ? WHERE user_id = ? AND withdrawn_at IS NULL', time, user.id),
    ...cases.map(c => event(c.case_id, user.id, 'consent.withdrawn', {}, [])),
    sql('DELETE FROM sessions WHERE user_id = ?', user.id),
  ]);
  return json({ ok: true }, 200, CLEAR);
}

export async function logout(rq) {
  const { req, sql } = rq;
  const sid = sidOf(rq, req);
  if (sid) await sql('DELETE FROM sessions WHERE token_hash = ?', await sha256(sid)).run();
  return json({ ok: true }, 200, CLEAR);
}
