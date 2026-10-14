// People: invitations, participants, the admin overview of people.
import { DB, E, ev, fail, isDate, json, now, q, row, rows, sha256, token, uid } from './core.js';
import { caseCtx } from './access.js';
import { originOf, sessionCookie } from './auth.js';
import { bulkCap, sendMail } from './notify.js';

export async function invite({ user, params, body, url }) {
  const ctx = await caseCtx(user, params.id);
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
      q('UPDATE cases SET definition = ? WHERE id = ?', JSON.stringify({ ...ctx.def, roles: [...ctx.def.roles, role] }), ctx.c.id),
      ev(ctx.c.id, user.id, 'role.added', { role: label }, []),
    );
  } else {
    role = ctx.def.roles.find(r => r.key === body.role) ?? fail(400, 'Unbekannte Rolle');
  }
  const access = role.access;
  if ((await row('SELECT COUNT(*) AS n FROM invitations WHERE email = ? AND created_at >= ?', email, now().slice(0, 10))).n >= 5) {
    fail(429, 'An diese Adresse gingen heute schon fünf Einladungen.');
  }
  const t = token();
  await DB.batch([
    ...stmts,
    q('INSERT INTO invitations (token_hash, case_id, email, role, access, access_until, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      await sha256(t), ctx.c.id, email, role.key, access, body.access_until ? `${body.access_until}T23:59:59` : null,
      new Date(Date.now() + 14 * 864e5).toISOString(), user.id, now()),
    ev(ctx.c.id, user.id, 'participant.invited', { email, role: role.label }, []),
  ]);
  const link = `${originOf(url)}/#/invite/${t}`;
  const sent = await sendMail(email, `Einladung: ${ctx.c.title}`, [
    'Guten Tag,',
    `${user.name} lädt Sie in NomoCase zum Vorgang „${ctx.c.title}“ ein. Sie sind dort als ${role.label} beteiligt.`,
    `Einladung annehmen:\n${link}`,
    'Der Link ist 14 Tage gültig und funktioniert nur einmal. Danach richten Sie einen Passkey ein, mit dem Sie sich künftig anmelden.',
    'Falls Sie diese Einladung nicht erwartet haben, ignorieren Sie diese E-Mail einfach.',
  ], { replyTo: user.email }); // replies go to the inviter, the sender address has no mailbox
  // Only the invitee should hold the link. The inviter gets it as a fallback when mail fails – but never for an
  // existing account (locally always, for testing).
  if (E.DEV_LOGIN) return { sent, role: role.key, link };
  if (sent) return { sent, role: role.key };
  if (await accountByEmail(email)) fail(502, 'Die Einladung konnte nicht per E-Mail verschickt werden. Bitte später erneut versuchen.');
  return { sent, role: role.key, link };
}

const accountByEmail = email =>
  row('SELECT u.id, u.name, (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys FROM users u WHERE u.email = ?', email);

// The inviter could get hold of the link, so it must never open an existing account – with or without passkey.
const needsLogin = (existing, user) => !!existing && user?.id !== existing.id;

export async function getInvitation({ user, params }) {
  const inv = (await row(`
    SELECT i.email, i.role, i.access, c.title, c.definition, u.name AS inviter FROM invitations i
    JOIN cases c ON c.id = i.case_id JOIN users u ON u.id = i.created_by
    WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?`, await sha256(params.token), now()))
    ?? fail(404, 'Einladung ungültig oder abgelaufen');
  const role = JSON.parse(inv.definition).roles.find(r => r.key === inv.role);
  const existing = await accountByEmail(inv.email);
  return { email: inv.email, case_title: inv.title, role: role?.label ?? inv.role, access: inv.access, inviter: inv.inviter, existing: !!existing, needs_login: needsLogin(existing, user) };
}

// Possession of the emailed link stands in for email verification. That's enough for new
// accounts (and old ones without a passkey); accounts with a passkey must log in first.
export async function acceptInvitation({ user, body, url }) {
  const hash = await sha256(String(body.token ?? ''));
  const inv = (await row('SELECT i.*, c.definition FROM invitations i JOIN cases c ON c.id = i.case_id WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?', hash, now()))
    ?? fail(404, 'Einladung ungültig oder abgelaufen');
  const existing = await accountByEmail(inv.email);
  if (needsLogin(existing, user)) fail(401, 'Für diese E-Mail gibt es schon ein Konto. Bitte zuerst mit Passkey anmelden.');
  const userId = existing?.id ?? uid();
  const name = existing?.name ?? (String(body.name ?? '').trim() || inv.email);
  const role = JSON.parse(inv.definition).roles.find(r => r.key === inv.role);
  await DB.batch([
    ...(existing ? [] : [q('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', userId, inv.email, name, now())]),
    q('UPDATE invitations SET accepted_at = ? WHERE token_hash = ?', now(), hash),
    q(`INSERT INTO case_participants (case_id, user_id, access, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (case_id, user_id) DO UPDATE SET access = excluded.access, role = excluded.role, expires_at = excluded.expires_at, revoked_at = NULL`,
      inv.case_id, userId, inv.access, inv.role, inv.access_until, now()),
    ev(inv.case_id, userId, 'participant.joined', { role: role?.label ?? inv.role }, ['*']),
  ]);
  return json({ case_id: inv.case_id }, 200, { 'set-cookie': await sessionCookie(userId, url) });
}

export async function revoke({ user, params }) {
  const ctx = await caseCtx(user, params.id);
  if (!ctx.owner) fail(403, 'Nur Vorgangsverantwortliche');
  if (params.userId === user.id) fail(400, 'Eigenen Zugang nicht widerrufbar');
  const p = (await row('SELECT u.name, u.email FROM case_participants p JOIN users u ON u.id = p.user_id WHERE p.case_id = ? AND p.user_id = ?', ctx.c.id, params.userId))
    ?? fail(404, 'Nicht beteiligt');
  await DB.batch([
    q('UPDATE case_participants SET revoked_at = ? WHERE case_id = ? AND user_id = ?', now(), ctx.c.id, params.userId),
    q('DELETE FROM invitations WHERE case_id = ? AND email = ? AND accepted_at IS NULL', ctx.c.id, p.email), // no way back in
    ev(ctx.c.id, user.id, 'participant.revoked', { name: p.name }, []),
  ]);
}

export async function withdrawInvitation({ user, params }) {
  const ctx = await caseCtx(user, params.id);
  if (!ctx.owner) fail(403, 'Nur Vorgangsverantwortliche');
  const email = decodeURIComponent(params.email).toLowerCase();
  const { meta } = await q('DELETE FROM invitations WHERE case_id = ? AND email = ? AND accepted_at IS NULL', ctx.c.id, email).run();
  if (!meta.changes) fail(404, 'Keine offene Einladung an diese Adresse');
  await ev(ctx.c.id, user.id, 'invitation.withdrawn', { email }, []).run();
}

// Admin overview for workspace owners: everyone in their workspaces (members and case participants, also former ones),
// open invitations and today's mail volume. Scoped to owned workspaces; other workspaces' cases stay hidden.
export async function peopleOverview({ user }) {
  const owned = (await rows("SELECT workspace_id FROM workspace_members WHERE user_id = ? AND role = 'owner'", user.id)).map(r => r.workspace_id);
  if (!owned.length) fail(403, 'Nur für Workspace-Owner');
  const ws = JSON.stringify(owned);
  const IN_WS = 'IN (SELECT value FROM json_each(?1))';
  const roleLabel = (c, p) => `(SELECT json_extract(r.value, '$.label') FROM json_each(${c}.definition, '$.roles') r WHERE json_extract(r.value, '$.key') = ${p}.role)`;
  const [list, seats, invitations, cases, mails] = await Promise.all([
    rows(`SELECT u.id, u.name, u.email, u.created_at, u.email_reminders, u.email_progress,
        (SELECT COUNT(*) FROM passkeys WHERE user_id = u.id) AS passkeys,
        (SELECT MAX(t) FROM (SELECT last_used_at AS t FROM passkeys WHERE user_id = u.id
          UNION ALL SELECT used_at FROM login_links WHERE user_id = u.id
          UNION ALL SELECT MAX(created_at) FROM events WHERE actor_id = u.id)) AS last_seen,
        (SELECT group_concat(w.name, ', ') FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
          WHERE m.user_id = u.id AND m.workspace_id ${IN_WS}) AS workspaces
      FROM users u WHERE u.id IN (SELECT user_id FROM workspace_members WHERE workspace_id ${IN_WS}
        UNION SELECT p.user_id FROM case_participants p JOIN cases c ON c.id = p.case_id WHERE c.workspace_id ${IN_WS})
      ORDER BY u.name COLLATE NOCASE`, ws),
    rows(`SELECT p.user_id, c.id AS case_id, c.title, c.status, p.access, p.revoked_at, p.expires_at, ${roleLabel('c', 'p')} AS role
      FROM case_participants p JOIN cases c ON c.id = p.case_id WHERE c.workspace_id ${IN_WS} ORDER BY c.created_at DESC`, ws),
    rows(`SELECT i.email, i.created_at, i.expires_at, c.id AS case_id, c.title, ${roleLabel('c', 'i')} AS role
      FROM invitations i JOIN cases c ON c.id = i.case_id
      WHERE c.workspace_id ${IN_WS} AND i.accepted_at IS NULL AND i.expires_at > ?2 ORDER BY i.created_at DESC`, ws, now()),
    row(`SELECT SUM(status = 'open') AS open, SUM(status = 'closed') AS closed FROM cases WHERE workspace_id ${IN_WS}`, ws),
    row('SELECT COUNT(*) AS total, COALESCE(SUM(bulk), 0) AS bulk FROM mail_log WHERE sent_at >= ?', now().slice(0, 10)),
  ]);
  const t = now();
  return {
    people: list.map(u => ({
      ...u, email_reminders: !!u.email_reminders, email_progress: !!u.email_progress,
      cases: seats.filter(s => s.user_id === u.id).map(({ user_id, revoked_at, expires_at, ...s }) =>
        ({ ...s, active: !revoked_at && (!expires_at || expires_at > t) })),
    })),
    invitations,
    stats: { cases_open: cases.open ?? 0, cases_closed: cases.closed ?? 0, mails_today: mails.total, bulk_today: mails.bulk, bulk_cap: bulkCap() },
  };
}
