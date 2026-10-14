// Sessions, passkeys, login links, dev login and the own account.
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { appVersion, arr, DB, E, ev, fail, json, now, q, row, rows, rpId, sha256, token, uid } from './core.js';
import { caseCtx } from './access.js';
import { sendMail } from './notify.js';
import { CONSENT_VERSION } from '../public/shared/consent.js';

// The canonical origin. Not the request URL: wrangler dev rewrites that to the production route.
export const originOf = url => E.ORIGIN || url.origin;

const rpOf = url => new URL(originOf(url)).hostname;

const sidOf = req => req.headers.get('cookie')?.match(/(?:^|;\s*)sid=([0-9a-f]+)/)?.[1];

export async function loadUser(req) {
  const sid = sidOf(req);
  return sid
    ? row(`SELECT u.*, EXISTS (SELECT 1 FROM consents c WHERE c.user_id = u.id AND c.version = ? AND c.withdrawn_at IS NULL) AS consented
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`, CONSENT_VERSION, await sha256(sid), now())
    : null;
}

export async function sessionCookie(userId, url) {
  const t = token();
  await q('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    await sha256(t), userId, new Date(Date.now() + 30 * 864e5).toISOString()).run();
  return `sid=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${originOf(url).startsWith('https:') ? '; Secure' : ''}`;
}

export async function me({ user }) {
  if (!user) return { user: null, dev_users: E.DEV_LOGIN ? await rows('SELECT email, name FROM users ORDER BY name') : null };
  const workspaces = await rows('SELECT w.id, w.name, m.role FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.name', user.id);
  const { n } = await row('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ? AND rp_id IS ?', user.id, rpId());
  const consent = await row('SELECT accepted_at FROM consents WHERE user_id = ? AND version = ? AND withdrawn_at IS NULL', user.id, CONSENT_VERSION);
  return { user: { id: user.id, name: user.name, email: user.email, email_reminders: !!user.email_reminders, email_progress: !!user.email_progress }, workspaces, passkeys: n, dev: !!E.DEV_LOGIN, version: appVersion(),
    consent: { version: CONSENT_VERSION, accepted: !!consent, accepted_at: consent?.accepted_at ?? null } };
}

export async function updateMe({ user, body }) {
  const keys = ['email_reminders', 'email_progress'].filter(k => k in body);
  if (!keys.length || !keys.every(k => typeof body[k] === 'boolean')) fail(400, 'email_reminders/email_progress müssen true oder false sein');
  await q(`UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => (body[k] ? 1 : 0)), user.id).run();
}

// One-time login link by mail: requested on the login page, or sent by a case owner to a participant.
// At most one unused link per person every 10 minutes, so nobody can flood an inbox.
const LOGIN_REQUEST_CAP = 20; // self-service login link mails per day, so strangers cannot use up the mail quota

async function mailLoginLink(u, url, kind = null) {
  if (await row('SELECT 1 FROM login_links WHERE user_id = ? AND used_at IS NULL AND expires_at > ?', u.id, new Date(Date.now() + 864e5 - 10 * 60e3).toISOString())) return { throttled: true };
  if (kind && (await row('SELECT COUNT(*) AS n FROM mail_log WHERE kind = ? AND ok = 1 AND sent_at >= ?', kind, now().slice(0, 10))).n >= LOGIN_REQUEST_CAP) {
    console.error('login link requests: daily cap reached');
    return { throttled: true };
  }
  const t = token();
  await q('INSERT INTO login_links (token_hash, user_id, expires_at) VALUES (?, ?, ?)', await sha256(t), u.id, new Date(Date.now() + 864e5).toISOString()).run();
  const link = `${originOf(url)}/#/login/${t}`;
  const sent = await sendMail(u.email, 'Ihr Anmeldelink für NomoCase', [
    `Guten Tag ${u.name},`,
    `mit diesem Link melden Sie sich bei NomoCase an:\n${link}`,
    'Der Link ist 24 Stunden gültig und funktioniert nur einmal. Richten Sie danach am besten einen Passkey ein, dann brauchen Sie keinen Link mehr.',
    'Falls Sie keinen Anmeldelink angefordert haben, ignorieren Sie diese E-Mail einfach.',
  ], { kind });
  return { sent, link };
}

export async function requestLoginLink({ body, url, exec }) {
  const email = String(body.email ?? '').trim().toLowerCase();
  const u = email ? await row('SELECT id, email, name FROM users WHERE email = ?', email) : null;
  // Same answer, same speed, whether or not the address has an account. Locally the link comes back for testing.
  if (E.DEV_LOGIN) {
    const r = u ? await mailLoginLink(u, url, 'login_request') : {};
    return r.link ? { ok: true, link: r.link } : { ok: true };
  }
  if (u) exec.waitUntil(mailLoginLink(u, url, 'login_request').catch(e => console.error('login link', e.message)));
  return { ok: true };
}

export async function sendParticipantLink({ user, params, url }) {
  const ctx = await caseCtx(user, params.id);
  if (!ctx.owner) fail(403, 'Nur Vorgangsverantwortliche');
  const p = (await row(`SELECT u.id, u.email, u.name FROM case_participants p JOIN users u ON u.id = p.user_id
    WHERE p.case_id = ? AND p.user_id = ? AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?)`, ctx.c.id, params.userId, now()))
    ?? fail(404, 'Nicht (mehr) beteiligt');
  const r = await mailLoginLink(p, url);
  if (r.throttled) fail(429, 'Es wurde gerade erst ein Anmeldelink verschickt. Bitte in ein paar Minuten erneut versuchen.');
  if (!r.sent) fail(502, 'Die E-Mail konnte nicht verschickt werden.');
  await ev(ctx.c.id, user.id, 'participant.link_sent', { name: p.name }, []).run();
  return E.DEV_LOGIN ? { sent: true, link: r.link } : { sent: true };
}

export async function useLoginLink({ body, url }) {
  const link = (await row('UPDATE login_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id',
    now(), await sha256(String(body.token ?? '')), now())) ?? fail(404, 'Anmeldelink ungültig oder abgelaufen');
  return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(link.user_id, url) });
}

// RP ID and origin come from ORIGIN (localhost in .dev.vars, the custom domain in production).

async function newChallenge(options, userId = null) {
  const id = uid();
  await DB.batch([
    q('DELETE FROM challenges WHERE expires_at < ?', now()),
    q('INSERT INTO challenges (id, challenge, user_id, expires_at) VALUES (?, ?, ?, ?)', id, options.challenge, userId, new Date(Date.now() + 5 * 60e3).toISOString()),
  ]);
  return { challenge_id: id, options };
}

// Single use: the challenge is deleted by the same statement that reads it.
const takeChallenge = async (id, userId = null) =>
  (await row('DELETE FROM challenges WHERE id = ? AND user_id IS ? AND expires_at > ? RETURNING challenge', String(id ?? ''), userId, now()))?.challenge
  ?? fail(400, 'Anmeldeversuch abgelaufen, bitte erneut versuchen');

export async function passkeyRegisterOptions({ user, url }) {
  const existing = await rows('SELECT id, transports FROM passkeys WHERE user_id = ? AND rp_id IS ?', user.id, rpOf(url));
  return newChallenge(await generateRegistrationOptions({
    rpName: 'NomoCase',
    rpID: rpOf(url),
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    excludeCredentials: existing.map(p => ({ id: p.id, transports: arr(p.transports) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  }), user.id);
}

export async function passkeyRegisterVerify({ user, url, body }) {
  const expectedChallenge = await takeChallenge(body.challenge_id, user.id);
  const { verified, registrationInfo } = await verifyRegistrationResponse({ response: body.response, expectedChallenge, expectedOrigin: originOf(url), expectedRPID: rpOf(url) })
    .catch(e => fail(400, `Passkey ungültig: ${e.message}`));
  if (!verified) fail(400, 'Passkey ungültig');
  const { id, publicKey, counter, transports } = registrationInfo.credential;
  await q('INSERT INTO passkeys (id, user_id, public_key, counter, transports, created_at, rp_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, user.id, isoBase64URL.fromBuffer(publicKey), counter, JSON.stringify(transports ?? []), now(), rpOf(url)).run();
}

// No allowCredentials: discoverable credentials, so the browser offers the user's passkeys without asking for an email.
export const passkeyLoginOptions = async ({ url }) => newChallenge(await generateAuthenticationOptions({ rpID: rpOf(url), userVerification: 'required' }));

export async function passkeyLoginVerify({ url, body }) {
  const expectedChallenge = await takeChallenge(body.challenge_id);
  const pk = (await row('SELECT * FROM passkeys WHERE id = ?', String(body.response?.id ?? ''))) ?? fail(400, 'Passkey unbekannt');
  const { verified, authenticationInfo } = await verifyAuthenticationResponse({
    response: body.response, expectedChallenge, expectedOrigin: originOf(url), expectedRPID: rpOf(url),
    credential: { id: pk.id, publicKey: isoBase64URL.toBuffer(pk.public_key), counter: pk.counter, transports: arr(pk.transports) },
  }).catch(e => fail(400, `Anmeldung fehlgeschlagen: ${e.message}`));
  if (!verified) fail(400, 'Anmeldung fehlgeschlagen');
  await q('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?', authenticationInfo.newCounter, now(), pk.id).run();
  return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(pk.user_id, url) });
}

export const listPasskeys = async ({ user, url }) => (await rows('SELECT id, created_at, last_used_at, rp_id FROM passkeys WHERE user_id = ? ORDER BY created_at', user.id))
  .map(p => ({ ...p, usable: p.rp_id === rpOf(url) }));

export async function deletePasskey({ user, params }) {
  const { meta } = await q('DELETE FROM passkeys WHERE id = ? AND user_id = ?', params.id, user.id).run();
  if (!meta.changes) fail(404, 'Passkey nicht gefunden');
}

// Local-only shortcut (DEV_LOGIN comes from .dev.vars, which is never deployed).
export async function devLogin({ body, url }) {
  if (!E.DEV_LOGIN) fail(404, 'Nicht gefunden');
  const u = (await row('SELECT id FROM users WHERE email = ?', body.email ?? null)) ?? fail(404, 'Unbekannter Benutzer');
  await consentStmt(u.id).run(); // dev only: test accounts have agreed (the consent gate has its own tests)
  return json({ ok: true }, 200, { 'set-cookie': await sessionCookie(u.id, url) });
}

// --- consent (public/shared/consent.js) ---------------------------------------------------------------------------
// Using NomoCase is voluntary; whoever uses it agrees to the processing first. Every agreement is kept per text version.
export const consentStmt = userId => q(`INSERT INTO consents (user_id, version, accepted_at) VALUES (?, ?, ?)
  ON CONFLICT (user_id, version) DO UPDATE SET accepted_at = excluded.accepted_at, withdrawn_at = NULL`, userId, CONSENT_VERSION, now());
export const hasConsent = async userId => !!(await row('SELECT 1 FROM consents WHERE user_id = ? AND version = ? AND withdrawn_at IS NULL', userId, CONSENT_VERSION));

// Who operates NomoCase and whom to contact – shown in the consent text, also before login (invitations, upload links).
export const legalInfo = () => ({ version: CONSENT_VERSION, operator: E.OPERATOR ?? '[Betreiber]', contact: E.PRIVACY_CONTACT ?? '[Kontakt]' });

export async function giveConsent({ user, body }) {
  if (body.version !== CONSENT_VERSION) fail(409, 'Der Text wurde inzwischen geändert. Bitte neu laden.');
  await consentStmt(user.id).run();
}

// Withdrawing ends the use: logged out everywhere; the cases' teams learn to continue the conventional way.
export async function withdrawConsent({ user }) {
  const cases = await rows('SELECT case_id FROM case_participants WHERE user_id = ? AND revoked_at IS NULL', user.id);
  await DB.batch([
    q('UPDATE consents SET withdrawn_at = ? WHERE user_id = ? AND withdrawn_at IS NULL', now(), user.id),
    ...cases.map(c => ev(c.case_id, user.id, 'consent.withdrawn', {}, [])),
    q('DELETE FROM sessions WHERE user_id = ?', user.id),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
}

export async function logout({ req }) {
  const sid = sidOf(req);
  if (sid) await q('DELETE FROM sessions WHERE token_hash = ?', await sha256(sid)).run();
  return json({ ok: true }, 200, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
}
