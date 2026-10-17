// Workspaces: create, rename and delete them, manage members (owner or member) and invitations into a workspace.
// Owners see every case of the workspace and manage its templates; members create cases from its templates and see
// the cases they take part in. A workspace always keeps at least one owner.
import { fail, sha256, token, uid } from './core.js';
import { requireWsOwner } from './access.js';
import { originOf } from './auth.js';
import { checkSenderCap, mailAnswer, outboxStmt, sendFromOutbox } from './notify.js';
import { trustedIssuersOf } from './signatures.js';

export const WORKSPACE_ROLES = { owner: 'Owner', member: 'Mitglied' };
const checkRole = r => (['owner', 'member'].includes(r) ? r : fail(400, 'Rolle muss owner oder member sein'));
const checkName = n => String(n ?? '').trim().slice(0, 80) || fail(400, 'Name fehlt');
const owners = async (rq, wsId) => (await rq.row("SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND role = 'owner'", wsId)).n;

// The user's workspaces; owners also get members, open invitations and what the workspace holds.
export async function listWorkspaces(rq) {
  const { user, rows, sql, batch, time, rpId } = rq;
  const list = await rows(`SELECT w.id, w.name, m.role, w.accent, w.logo IS NOT NULL AS has_logo,
      (SELECT COUNT(*) FROM cases c WHERE c.workspace_id = w.id) AS cases,
      (SELECT COUNT(*) FROM templates t WHERE t.workspace_id = w.id) AS templates
    FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.name`, user.id);
  const owned = JSON.stringify(list.filter(w => w.role === 'owner').map(w => w.id));
  const [members, invitations] = (await batch([
    sql(`SELECT m.workspace_id, m.role, u.id AS user_id, u.name, u.email, (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id AND p.rp_id IS ?) AS passkeys
       FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id IN (SELECT value FROM json_each(?)) ORDER BY m.role DESC, u.name`, rpId, owned),
    sql(`SELECT workspace_id, email, role, created_at, expires_at, expires_at <= ? AS expired FROM workspace_invitations
       WHERE workspace_id IN (SELECT value FROM json_each(?)) AND accepted_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC`, time, owned),
  ])).map(r => r.results);
  const issuers = await trustedIssuersOf(rq, JSON.parse(owned));
  return list.map(w => ({ ...w, ...(w.role === 'owner' && {
    members: members.filter(m => m.workspace_id === w.id),
    invitations: invitations.filter(i => i.workspace_id === w.id),
    issuers: issuers.filter(i => i.workspace_id === w.id),
  }) }));
}

// The look of the workspace's forms: accent colour and logo. PNG/JPEG only (no SVG: it can carry scripts), kept small.
const MAX_LOGO = 300 * 1024;
export const branding = async (rq, wsId) => (await rq.row('SELECT accent, logo FROM workspaces WHERE id = ?', wsId)) ?? {};

export async function getBranding(rq) {
  const { user, params, row } = rq;
  if (!(await row('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', params.id, user.id))) fail(404, 'Workspace nicht gefunden');
  return branding(rq, params.id);
}

export async function setBranding({ user, params, body, sql, batch, wsEvent }) {
  await requireWsOwner(user, params.id);
  const set = {};
  if ('accent' in body) set.accent = body.accent ? (/^#[0-9a-f]{6}$/i.test(body.accent) ? body.accent.toLowerCase() : fail(400, 'Farbe als #rrggbb')) : null;
  if ('logo' in body) {
    const m = body.logo && /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(body.logo);
    if (body.logo && !m) fail(400, 'Logo bitte als PNG oder JPEG');
    if (m) {
      const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
      if (bytes.length > MAX_LOGO) fail(413, 'Das Logo ist zu groß (höchstens 300 KB).');
      const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47, jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      if (!(m[1] === 'png' ? png : jpeg)) fail(400, 'Die Datei ist kein PNG- bzw. JPEG-Bild.');
    }
    set.logo = body.logo || null;
  }
  const keys = Object.keys(set);
  if (keys.length) {
    await batch([sql(`UPDATE workspaces SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(set), params.id),
      wsEvent(params.id, user.id, 'workspace.look', { ...('accent' in set && { accent: set.accent }), ...('logo' in set && { logo: set.logo ? 'neu' : 'entfernt' }) })]);
  }
}

// The workspace's log, newest first (owners only).
export async function workspaceLog({ user, params, rows }) {
  await requireWsOwner(user, params.id);
  return (await rows(`SELECT e.id, e.type, e.payload, e.created_at, u.name AS actor FROM workspace_events e LEFT JOIN users u ON u.id = e.actor_id
    WHERE e.workspace_id = ? ORDER BY e.id DESC LIMIT 200`, params.id)).map(e => ({ ...e, payload: JSON.parse(e.payload) }));
}

// New workspaces come from people who already own one (no self-service for guests).
export async function createWorkspace({ user, body, row, sql, batch, wsEvent }) {
  if (!(await row("SELECT 1 FROM workspace_members WHERE user_id = ? AND role = 'owner'", user.id))) fail(403, 'Nur Owner eines Workspaces können weitere anlegen');
  const id = uid();
  await batch([
    sql('INSERT INTO workspaces (id, name) VALUES (?, ?)', id, checkName(body.name)),
    sql("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')", id, user.id),
    wsEvent(id, user.id, 'workspace.created', { name: checkName(body.name) }),
  ]);
  return { id };
}

export async function renameWorkspace({ user, params, body, row, sql, batch, wsEvent }) {
  await requireWsOwner(user, params.id);
  const { name } = await row('SELECT name FROM workspaces WHERE id = ?', params.id);
  await batch([sql('UPDATE workspaces SET name = ? WHERE id = ?', checkName(body.name), params.id),
    wsEvent(params.id, user.id, 'workspace.renamed', { from: name, to: checkName(body.name) })]);
}

// Only without cases (deleted cases leave just a tombstone): its templates go along.
export async function deleteWorkspace({ user, params, row, sql, batch }) {
  await requireWsOwner(user, params.id);
  if ((await row('SELECT COUNT(*) AS n FROM cases WHERE workspace_id = ?', params.id)).n) fail(409, 'Der Workspace enthält noch Vorgänge.');
  await batch([
    sql('DELETE FROM template_versions WHERE template_id IN (SELECT id FROM templates WHERE workspace_id = ?)', params.id),
    sql('DELETE FROM templates WHERE workspace_id = ?', params.id),
    sql('DELETE FROM workspace_invitations WHERE workspace_id = ?', params.id),
    sql('DELETE FROM trusted_issuers WHERE workspace_id = ?', params.id),
    sql('DELETE FROM workspace_members WHERE workspace_id = ?', params.id),
    sql('DELETE FROM workspace_events WHERE workspace_id = ?', params.id),
    sql('DELETE FROM workspaces WHERE id = ?', params.id),
  ]);
}

export async function setMemberRole(rq) {
  const { user, params, body, row, sql, batch, wsEvent } = rq;
  await requireWsOwner(user, params.id);
  const role = checkRole(body.role);
  const m = (await row('SELECT m.role, u.name FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?', params.id, params.userId))
    ?? fail(404, 'Kein Mitglied');
  if (m.role === 'owner' && role !== 'owner' && (await owners(rq, params.id)) === 1) fail(409, 'Ein Workspace braucht mindestens einen Owner.');
  await batch([sql('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?', role, params.id, params.userId),
    wsEvent(params.id, user.id, 'member.role', { member: m.name, role })]);
}

// Leaves the person's part in single cases untouched: those are ended per case.
export async function removeMember(rq) {
  const { user, params, row, sql, batch, wsEvent } = rq;
  await requireWsOwner(user, params.id);
  const m = (await row('SELECT m.role, u.name FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND m.user_id = ?', params.id, params.userId))
    ?? fail(404, 'Kein Mitglied');
  if (m.role === 'owner' && (await owners(rq, params.id)) === 1) fail(409, 'Ein Workspace braucht mindestens einen Owner.');
  await batch([sql('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?', params.id, params.userId),
    wsEvent(params.id, user.id, params.userId === user.id ? 'member.left' : 'member.removed', { member: m.name })]);
}

export async function inviteToWorkspace({ user, params, body, url, row, sql, batch, wsEvent, env, time }) {
  await requireWsOwner(user, params.id);
  const ws = await row('SELECT name FROM workspaces WHERE id = ?', params.id);
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'E-Mail ungültig');
  const role = checkRole(body.role ?? 'member');
  if (await row('SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? AND u.email = ?', params.id, email)) {
    fail(409, 'Diese Person ist schon im Workspace.');
  }
  // Every invitation is a mail: at most five per address and day from one inviter.
  if ((await row('SELECT COUNT(*) AS n FROM workspace_invitations WHERE created_by = ? AND email = ? AND created_at >= ?', user.id, email, time.slice(0, 10))).n >= 5) {
    fail(429, 'An diese Adresse gingen heute schon fünf Einladungen.');
  }
  // The open invitation's mail has not gone out yet: asking again continues it – same link (as for case invitations).
  const open = await row(`SELECT o.id FROM workspace_invitations i JOIN mail_outbox o ON o.ref = i.token_hash AND o.status = 'pending'
    WHERE i.workspace_id = ? AND i.email = ? AND i.role = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL`, params.id, email, role);
  if (open) return mailAnswer(await sendFromOutbox(open.id));
  await checkSenderCap(user.id);
  const t = token(), hash = await sha256(t), mailId = uid();
  const link = `${originOf(url)}/#/invite/${t}`;
  await batch([
    // inviting again replaces the open invitation
    sql('UPDATE workspace_invitations SET revoked_at = ? WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL', time, params.id, email),
    sql('INSERT INTO workspace_invitations (token_hash, workspace_id, email, role, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      hash, params.id, email, role, new Date(Date.now() + 14 * 864e5).toISOString(), user.id, time),
    outboxStmt({ id: mailId, kind: 'workspace_invitation', ref: hash, to: email, subject: `Einladung in den Workspace „${ws.name}“`,
      replyTo: user.email, sender: user.id, paragraphs: [
        'Guten Tag,',
        `${user.name} lädt Sie in NomoCase in den Workspace „${ws.name}“ ein, als ${WORKSPACE_ROLES[role]}.`,
        `Einladung annehmen:\n${link}`,
        'Der Link ist 14 Tage gültig und funktioniert nur einmal. Danach richten Sie einen Passkey ein, mit dem Sie sich künftig anmelden.',
        'Falls Sie diese Einladung nicht erwartet haben, ignorieren Sie diese E-Mail einfach.'] }),
    wsEvent(params.id, user.id, 'member.invited', { email, role }),
  ]);
  const answer = mailAnswer(await sendFromOutbox(mailId));
  // As with case invitations: only the invitee may hold the link (locally it comes back for testing).
  return env.DEV_LOGIN ? { ...answer, link } : answer;
}

export async function withdrawWorkspaceInvitation({ user, params, sql, wsEvent, time }) {
  await requireWsOwner(user, params.id);
  const email = decodeURIComponent(params.email).toLowerCase();
  const { meta } = await sql('UPDATE workspace_invitations SET revoked_at = ? WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL',
    time, params.id, email).run();
  if (!meta.changes) fail(404, 'Keine offene Einladung an diese Adresse');
  await wsEvent(params.id, user.id, 'member.withdrawn', { email }).run();
}

// Looked up by the shared invitation page (people.js) when the token is not a case invitation.
export const workspaceInvitation = async (rq, hash) => rq.row(`SELECT i.*, w.name AS workspace, u.name AS inviter FROM workspace_invitations i
  JOIN workspaces w ON w.id = i.workspace_id JOIN users u ON u.id = i.created_by
  WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?`, hash, rq.time);
