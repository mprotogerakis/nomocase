// People: invitations, participants, the admin overview of people. (Works on the request context, core.js.)
import { fail, isDate, json, sha256, token, uid } from './core.js';
import { caseCtx } from './access.js';
import { consentStmt, hasConsent, originOf, sessionCookie } from './auth.js';
import { bulkCap, checkSenderCap, DAILY_CRON, mailAnswer, outboxStmt, sendFromOutbox, UNCLEAR } from './notify.js';
import { workspaceInvitation, WORKSPACE_ROLES } from './workspaces.js';
import { CONSENT_VERSION } from '../public/shared/consent.js';

export async function invite(rq) {
  const { user, params, body, url, row, sql, batch, event, env, time } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  if (!ctx.owner) fail(403, 'Nur Vorgangsverantwortliche können einladen');
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'E-Mail ungültig');
  if (body.access_until && !isDate(body.access_until)) fail(400, 'Datum ungültig');
  const stmts = [];
  let role;
  if (body.new_role) {
    // A role is a seat in the case; new seats can be added while inviting (e.g. "Steuerberater" in a free case).
    const label = String(body.new_role.label ?? '').trim().slice(0, 60) || fail(400, 'Name der Rolle fehlt');
    if (!['case_editor', 'guest_contributor', 'guest_viewer'].includes(body.new_role.access)) fail(400, 'Unbekannte Zugriffsstufe');
    role = { key: `r_${uid().slice(0, 8)}`, label, access: body.new_role.access };
    stmts.push(
      sql('UPDATE cases SET definition = ? WHERE id = ?', JSON.stringify({ ...ctx.def, roles: [...ctx.def.roles, role] }), ctx.c.id),
      event(ctx.c.id, user.id, 'role.added', { role: label }, []),
    );
  } else {
    role = ctx.def.roles.find(r => r.key === body.role) ?? fail(400, 'Unbekannte Rolle');
  }
  const access = role.access;
  // Each invitation is a mail: at most five per address and day from one inviter. Counted in the log (index on actor and
  // time), because re-inviting replaces the invitation row.
  const sentToday = await row(`SELECT COUNT(*) AS n FROM events WHERE actor_id = ? AND created_at >= ? AND type = 'participant.invited'
    AND json_extract(payload, '$.email') = ?`, user.id, time.slice(0, 10), email);
  if (sentToday.n >= 5) fail(429, 'An diese Adresse gingen heute schon fünf Einladungen.');
  // The open invitation's mail has not gone out yet (the provider failed): asking again continues it – same link.
  const open = !body.new_role && await row(`SELECT o.id FROM invitations i JOIN mail_outbox o ON o.ref = i.token_hash AND o.status = 'pending'
    WHERE i.case_id = ? AND i.email = ? AND i.role = ? AND i.accepted_at IS NULL`, ctx.c.id, email, role.key);
  if (open) return { ...mailAnswer(await sendFromOutbox(rq, open.id)), role: role.key };
  await checkSenderCap(rq, user.id);
  const t = token(), hash = await sha256(t), mailId = uid();
  // Inviting the same address again (e.g. after the link expired) replaces the open invitation: one row, a fresh link.
  const again = await row('SELECT 1 FROM invitations WHERE case_id = ? AND email = ? AND accepted_at IS NULL', ctx.c.id, email);
  const link = `${originOf(rq, url)}/#/invite/${t}`;
  await batch([
    ...stmts,
    sql('DELETE FROM invitations WHERE case_id = ? AND email = ? AND accepted_at IS NULL', ctx.c.id, email),
    sql('INSERT INTO invitations (token_hash, case_id, email, role, access, access_until, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      hash, ctx.c.id, email, role.key, access, body.access_until ? `${body.access_until}T23:59:59` : null,
      new Date(Date.now() + 14 * 864e5).toISOString(), user.id, time),
    // the mail with the link, in the same transaction (migration 0043); replies go to the inviter, the sender address has no mailbox
    outboxStmt(rq, { id: mailId, kind: 'invitation', ref: hash, to: email, subject: `Einladung: ${ctx.c.title}`, replyTo: user.email, sender: user.id, paragraphs: [
      'Guten Tag,',
      `${user.name} lädt Sie in NomoCase zum Vorgang „${ctx.c.title}“ ein. Sie sind dort als ${role.label} beteiligt.`,
      `Einladung annehmen:\n${link}`,
      'Der Link ist 14 Tage gültig und funktioniert nur einmal. Danach richten Sie einen Passkey ein, mit dem Sie sich künftig anmelden.',
      'Falls Sie diese Einladung nicht erwartet haben, ignorieren Sie diese E-Mail einfach.'] }),
    event(ctx.c.id, user.id, 'participant.invited', { email, role: role.label, ...(again && { again: true }) }, []),
  ]);
  const answer = { ...mailAnswer(await sendFromOutbox(rq, mailId)), role: role.key };
  // Only the invitee may ever hold the link: whoever accepts it chooses name and passkey of the new account.
  // (Locally it comes back for testing.)
  return env.DEV_LOGIN ? { ...answer, link } : answer;
}

export const accountByEmail = (rq, email) =>
  rq.row('SELECT u.id, u.name, (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id AND p.rp_id IS ?) AS passkeys FROM users u WHERE u.email = ?', rq.rpId, email);

// The inviter could get hold of the link, so it must never open an existing account – with or without passkey.
const needsLogin = (existing, user) => !!existing && user?.id !== existing.id;

// One link page for both kinds of invitation: into a case (a seat in it) or into a workspace.
export async function getInvitation(rq) {
  const { user, body, row, time } = rq;
  const hash = await sha256(String(body.token ?? ''));
  const inv = await row(`
    SELECT i.email, i.role, i.access, c.title, c.definition, u.name AS inviter FROM invitations i
    JOIN cases c ON c.id = i.case_id JOIN users u ON u.id = i.created_by
    WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?`, hash, time);
  const ws = inv ? null : (await workspaceInvitation(rq, hash)) ?? fail(404, 'Einladung ungültig oder abgelaufen');
  const existing = await accountByEmail(rq, (inv ?? ws).email);
  const who = { existing: !!existing, needs_login: needsLogin(existing, user) };
  if (ws) return { kind: 'workspace', email: ws.email, workspace: ws.workspace, role: WORKSPACE_ROLES[ws.role], inviter: ws.inviter, ...who };
  const role = JSON.parse(inv.definition).roles.find(r => r.key === inv.role);
  return { kind: 'case', email: inv.email, case_title: inv.title, role: role?.label ?? inv.role, access: inv.access, inviter: inv.inviter, ...who };
}

// An invitation never opens an existing account (log in first); a new address gets an account here.
// Joining needs consent to the processing (unless given already); declining keeps the conventional way open.
async function invitee(rq, email, user, body) {
  const existing = await accountByEmail(rq, email);
  // signed in as someone else: 403, so that a 401 for a signed-in page only ever means its session is gone (lib.js)
  if (needsLogin(existing, user)) fail(user ? 403 : 401, 'Für diese E-Mail gibt es schon ein Konto. Bitte zuerst mit Passkey anmelden.');
  const userId = existing?.id ?? uid();
  const name = existing?.name ?? (String(body.name ?? '').trim() || email);
  const agreed = existing && await hasConsent(rq, existing.id);
  if (!agreed && body.consent !== true) fail(400, 'Bitte stimmen Sie der Nutzung zu – oder wählen Sie den bisherigen Weg per E-Mail.');
  return { userId, stmts: [
    ...(existing ? [] : [rq.sql('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', userId, email, name, rq.time)]),
    ...(agreed ? [] : [consentStmt(rq, userId)]),
  ] };
}

// "Lieber per E-Mail": the invitation ends, the team learns it in the case (or it simply lapses for a workspace).
export async function declineInvitation(rq) {
  const { body, row, sql, batch, event, time } = rq;
  const hash = await sha256(String(body.token ?? ''));
  const inv = await row('SELECT * FROM invitations WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > ?', hash, time);
  if (inv) {
    await batch([sql('DELETE FROM invitations WHERE token_hash = ?', hash), event(inv.case_id, null, 'participant.declined', { email: inv.email }, [])]);
    return;
  }
  (await workspaceInvitation(rq, hash)) ?? fail(404, 'Einladung ungültig oder abgelaufen');
  await sql('UPDATE workspace_invitations SET revoked_at = ? WHERE token_hash = ?', time, hash).run();
}

// An invitation is taken in one statement, and only while it is still open – not withdrawn, replaced or expired since it
// was read: that moment decides against a withdrawal at the same time, and the access granted is the one of the
// invitation as taken. Should the rest of the acceptance fail, it is given back (the link is not used up).
const OPEN = { invitations: 'accepted_at IS NULL AND expires_at > ?1', workspace_invitations: 'accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?1' };
async function takeInvitation(rq, table, hash) {
  const taken = (await rq.row(`UPDATE ${table} SET accepted_at = ?1 WHERE token_hash = ?2 AND ${OPEN[table]} RETURNING *`, rq.time, hash))
    ?? fail(404, 'Einladung ungültig oder abgelaufen');
  const giveBack = async e => {
    await rq.sql(`UPDATE ${table} SET accepted_at = NULL WHERE token_hash = ? AND accepted_at = ?`, hash, rq.time).run();
    throw e;
  };
  return { taken, giveBack };
}

// Possession of the emailed link stands in for email verification. That's enough for new
// accounts (and old ones without a passkey); accounts with a passkey must log in first.
export async function acceptInvitation(rq) {
  const { user, body, url, row, sql, batch, event, time } = rq;
  const hash = await sha256(String(body.token ?? ''));
  const inv = await row('SELECT i.*, c.definition FROM invitations i JOIN cases c ON c.id = i.case_id WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?', hash, time);
  if (!inv) return acceptWorkspaceInvitation(rq, hash);
  const { userId, stmts } = await invitee(rq, inv.email, user, body); // may refuse (log in first, consent): before taking it
  const { taken, giveBack } = await takeInvitation(rq, 'invitations', hash);
  const role = JSON.parse(inv.definition).roles.find(r => r.key === taken.role);
  await batch([
    ...stmts,
    sql(`INSERT INTO case_participants (case_id, user_id, access, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (case_id, user_id) DO UPDATE SET access = excluded.access, role = excluded.role, expires_at = excluded.expires_at, revoked_at = NULL`,
      taken.case_id, userId, taken.access, taken.role, taken.access_until, time),
    event(taken.case_id, userId, 'participant.joined', { role: role?.label ?? taken.role }, ['*']),
  ]).catch(giveBack);
  return json({ case_id: taken.case_id }, 200, { 'set-cookie': await sessionCookie(rq, userId, url) });
}

async function acceptWorkspaceInvitation(rq, hash) {
  const { user, body, url, sql, batch, wsEvent } = rq;
  const ws = (await workspaceInvitation(rq, hash)) ?? fail(404, 'Einladung ungültig oder abgelaufen');
  const { userId, stmts } = await invitee(rq, ws.email, user, body);
  const { taken, giveBack } = await takeInvitation(rq, 'workspace_invitations', hash);
  await batch([
    ...stmts,
    // someone who is in the workspace already keeps their role
    sql('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (workspace_id, user_id) DO NOTHING', taken.workspace_id, userId, taken.role),
    wsEvent(taken.workspace_id, userId, 'member.joined', { member: String(body.name ?? '').trim() || user?.name || taken.email, role: taken.role }),
  ]).catch(giveBack);
  return json({ workspace_id: taken.workspace_id }, 200, { 'set-cookie': await sessionCookie(rq, userId, url) });
}

export async function revoke(rq) {
  const { user, params, row, sql, batch, event, time } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  if (!ctx.owner) fail(403, 'Nur Vorgangsverantwortliche');
  if (params.userId === user.id) fail(400, 'Eigenen Zugang nicht widerrufbar');
  const p = (await row('SELECT u.name, u.email FROM case_participants p JOIN users u ON u.id = p.user_id WHERE p.case_id = ? AND p.user_id = ?', ctx.c.id, params.userId))
    ?? fail(404, 'Nicht beteiligt');
  await batch([
    sql('UPDATE case_participants SET revoked_at = ? WHERE case_id = ? AND user_id = ?', time, ctx.c.id, params.userId),
    sql('DELETE FROM invitations WHERE case_id = ? AND email = ? AND accepted_at IS NULL', ctx.c.id, p.email), // no way back in
    event(ctx.c.id, user.id, 'participant.revoked', { name: p.name }, []),
  ]);
}

export async function withdrawInvitation(rq) {
  const { user, params, sql, event } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  if (!ctx.owner) fail(403, 'Nur Vorgangsverantwortliche');
  const email = decodeURIComponent(params.email).toLowerCase();
  const { meta } = await sql('DELETE FROM invitations WHERE case_id = ? AND email = ? AND accepted_at IS NULL', ctx.c.id, email).run();
  if (!meta.changes) fail(404, 'Keine offene Einladung an diese Adresse');
  await event(ctx.c.id, user.id, 'invitation.withdrawn', { email }, []).run();
}

// Admin overview for workspace owners: everyone in their workspaces (members and case participants, also former ones),
// open invitations and today's mail volume. Scoped to owned workspaces; other workspaces' cases stay hidden.
export async function peopleOverview(rq) {
  const { user, row, rows, rpId, time } = rq;
  const owned = (await rows("SELECT workspace_id FROM workspace_members WHERE user_id = ? AND role = 'owner'", user.id)).map(r => r.workspace_id);
  if (!owned.length) fail(403, 'Nur für Workspace-Owner');
  const ws = JSON.stringify(owned);
  const operator = !(await row('SELECT 1 FROM workspaces WHERE id NOT IN (SELECT value FROM json_each(?)) LIMIT 1', ws));
  const IN_WS = 'IN (SELECT value FROM json_each(?1))';
  const roleLabel = (c, p) => `(SELECT json_extract(r.value, '$.label') FROM json_each(${c}.definition, '$.roles') r WHERE json_extract(r.value, '$.key') = ${p}.role)`;
  const [list, seats, invitations, cases, mails, cronRuns, pending] = await Promise.all([
    rows(`SELECT u.id, u.name, u.email, u.created_at, u.email_reminders, u.email_progress,
        (SELECT COUNT(*) FROM passkeys WHERE user_id = u.id AND rp_id IS ?3) AS passkeys,
        (SELECT accepted_at FROM consents WHERE user_id = u.id AND version = ?4 AND withdrawn_at IS NULL) AS consent_at,
        (SELECT MAX(e.created_at) FROM events e JOIN cases c ON c.id = e.case_id
          WHERE e.actor_id = u.id AND c.workspace_id ${IN_WS}) AS last_seen, -- activity here, not the account's elsewhere
        (SELECT group_concat(w.name, ', ') FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.user_id = u.id AND m.workspace_id ${IN_WS}) AS workspaces
      FROM users u WHERE u.id IN (SELECT user_id FROM workspace_members WHERE workspace_id ${IN_WS}
        UNION SELECT p.user_id FROM case_participants p JOIN cases c ON c.id = p.case_id WHERE c.workspace_id ${IN_WS})
      ORDER BY u.name COLLATE NOCASE`, ws, null, rpId, CONSENT_VERSION),
    rows(`SELECT p.user_id, c.id AS case_id, c.title, c.status, p.access, p.revoked_at, p.expires_at, ${roleLabel('c', 'p')} AS role
      FROM case_participants p JOIN cases c ON c.id = p.case_id WHERE c.workspace_id ${IN_WS} ORDER BY c.created_at DESC`, ws),
    // Expired ones too: otherwise nobody notices that someone never joined.
    rows(`SELECT i.email, i.created_at, i.expires_at, i.expires_at <= ?2 AS expired, i.role AS role_key, c.id AS case_id, c.title, ${roleLabel('c', 'i')} AS role
      FROM invitations i JOIN cases c ON c.id = i.case_id
      WHERE c.workspace_id ${IN_WS} AND i.accepted_at IS NULL ORDER BY expired, i.created_at DESC`, ws, time),
    row(`SELECT SUM(status = 'open') AS open, SUM(status = 'closed') AS closed FROM cases WHERE workspace_id ${IN_WS}`, ws),
    // sent: taken by the provider – not digest or progress mails still waiting for its answer (counted for the cap, no status
    // yet); failed: not sent for sure. Unclear (no answer within the key's lifetime: maybe sent, maybe not) on their own, over
    // the days the log keeps, since such a mail is logged at the day it was first tried.
    row(`SELECT SUM(ok = 1 AND (bulk = 0 OR status IS NOT NULL)) AS total, COALESCE(SUM(bulk * ok), 0) AS bulk, SUM(ok = 0 AND error IS NOT ?2) AS failed,
      -- the provider's error text can name recipients of other workspaces: only the status here (details: test mail)
      (SELECT COALESCE('Status ' || status, 'ohne Antwort') FROM mail_log WHERE ok = 0 AND error IS NOT ?2 ORDER BY id DESC LIMIT 1) AS last_error,
      (SELECT sent_at FROM mail_log WHERE ok = 0 AND error IS NOT ?2 ORDER BY id DESC LIMIT 1) AS last_error_at,
      (SELECT COUNT(*) FROM mail_log WHERE error = ?2) AS unclear
      FROM mail_log WHERE sent_at >= ?1`, time.slice(0, 10), UNCLEAR),
    operator ? rows('SELECT cron, ran_at, failed FROM cron_runs') : [],
    operator ? row('SELECT COALESCE(SUM(json_array_length(mails)), 0) AS mails, MIN(created_at) AS since FROM bulk_outbox') : null,
  ]);
  return {
    people: list.map(u => ({
      ...u, email_reminders: !!u.email_reminders, email_progress: !!u.email_progress,
      cases: seats.filter(s => s.user_id === u.id).map(({ user_id, revoked_at, expires_at, ...s }) =>
        ({ ...s, active: !revoked_at && (!expires_at || expires_at > time) })),
    })),
    invitations,
    stats: { cases_open: cases.open ?? 0, cases_closed: cases.closed ?? 0,
      // the mail log is not per workspace: only who owns every workspace (in practice the operator) sees its numbers
      ...(operator && { mails_today: mails.total ?? 0, bulk_today: mails.bulk, bulk_cap: bulkCap(rq), mails_failed: mails.failed ?? 0,
        last_error: mails.last_error, last_error_at: mails.last_error_at, mails_pending: pending.mails, pending_since: pending.since, mails_unclear: mails.unclear,
        // each schedule's last run, null for one that never ran (a missing trigger must not go unnoticed)
        cron: Object.fromEntries([['daily', r => r.cron === DAILY_CRON], ['frequent', r => r.cron !== DAILY_CRON]].map(([k, is]) => {
          const r = cronRuns.find(is);
          return [k, r ? { ran_at: r.ran_at, failed: JSON.parse(r.failed) } : null];
        })) }) },
  };
}
