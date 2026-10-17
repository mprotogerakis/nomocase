// Cases: dashboard, case view, fields, status, comments, phases, subcases, deletion and retention, change stamps.
import { appVersion, arr, fail, isDate, roleList, STAFF, uid } from './core.js';
import { ACCESSIBLE, canSee, canSeeTask, caseCtx, requireWsOwner } from './access.js';
import { instantiate, latestTemplate } from './templates.js';
import { markBlocked } from './tasks.js';
import { financeSummary, loadFinance, sum } from './finance.js';
import { deDate, sendMail } from './notify.js';
import { explainSignatures } from './signatures.js';
import { inboxAddress } from './inbox.js';

export async function createCase(rq) {
  const { user, body, row, batch } = rq;
  const tpl = (await latestTemplate(rq, body.template_id)) ?? fail(404, 'Vorlage nicht gefunden');
  if (tpl.archived_at) fail(409, 'Diese Vorlage ist archiviert.');
  (await row('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?', tpl.workspace_id, user.id)) ?? fail(403, 'Kein Mitglied dieses Workspaces');
  const title = String(body.title ?? '').trim().slice(0, 200) || fail(400, 'Titel fehlt');
  const { caseId, stmts } = instantiate(rq, tpl, { title, fields: body.fields, ownerId: user.id });
  await batch(stmts);
  return { id: caseId };
}

// A subcase is a case of its own (template, participants, rules); the parent only knows it exists.
export async function addSubcase(rq) {
  const { user, params, body, batch, event } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  if (!ctx.owner) fail(403, 'Nur Vorgangsverantwortliche');
  const tpl = (await latestTemplate(rq, body.template_id)) ?? fail(404, 'Vorlage nicht gefunden');
  if (tpl.workspace_id !== ctx.c.workspace_id) fail(400, 'Die Vorlage gehört zu einem anderen Workspace');
  if (tpl.archived_at) fail(409, 'Diese Vorlage ist archiviert.');
  const title = String(body.title ?? '').trim().slice(0, 200) || fail(400, 'Titel fehlt');
  const { caseId, stmts } = instantiate(rq, tpl, { title, fields: body.fields, ownerId: user.id, parentId: ctx.c.id });
  await batch([...stmts, event(ctx.c.id, user.id, 'subcase.created', { title, case_id: caseId, template: tpl.name }, [])]);
  return { id: caseId };
}

// Change stamp for live updates: moves whenever something in the case, or in the set of cases the user sees, changes.
// Every case-relevant write appends an event; the case count covers deletions and ended access. Only events the user
// may see count (the rule of canSee), so a guest cannot tell from the stamp that something hidden happened.
// `u`: the placeholder of the user's id in the query it goes into
const seesEvent = u => `(e.actor_id = ${u} OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = c.workspace_id AND m.user_id = ${u} AND m.role = 'owner')
  OR EXISTS (SELECT 1 FROM case_participants p WHERE p.case_id = c.id AND p.user_id = ${u} AND p.revoked_at IS NULL
    AND (p.access IN ('case_owner', 'case_editor') OR EXISTS (SELECT 1 FROM json_each(e.visible_to) j WHERE j.value IN ('*', p.role)))))`;
const caseStamp = async (rq, caseId, user) => String((await rq.row(`SELECT MAX(e.id) AS v FROM events e JOIN cases c ON c.id = e.case_id
  WHERE e.case_id = ?1 AND ${seesEvent('?2')}`, caseId, user.id)).v ?? 0);

const dashboardStamp = async (rq, user) => {
  const r = await rq.row(`SELECT COUNT(*) AS n, MAX((SELECT MAX(e.id) FROM events e WHERE e.case_id = c.id AND ${seesEvent('?2')})) AS v
    FROM cases c WHERE ${ACCESSIBLE}`, null, user.id, rq.time);
  return `${r.n}:${r.v ?? 0}`;
};

// Polled by open pages (see app.js); one indexed lookup per call.
export async function getChanges(rq) {
  const { user, url } = rq;
  const caseId = url.searchParams.get('case');
  if (!caseId) return { stamp: await dashboardStamp(rq, user), version: appVersion(rq.env) };
  await caseCtx(rq, user, caseId);
  return { stamp: await caseStamp(rq, caseId, user), version: appVersion(rq.env) };
}

const currentPhase = (phases, tasks) => phases.find(p => tasks.some(t => t.phase_id === p.id && t.status === 'open'))?.title ?? null;

export async function getCase(rq) {
  const { user, params, row, rows, sql, batch, time } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  const id = ctx.c.id;
  const [phases, tasks, docs, versions, events, parts, invites] = (await batch([
    sql('SELECT * FROM phases WHERE case_id = ? ORDER BY position', id),
    sql(`SELECT t.*, cb.name AS completed_by_name FROM tasks t LEFT JOIN phases p ON p.id = t.phase_id LEFT JOIN users cb ON cb.id = t.completed_by
       WHERE t.case_id = ? ORDER BY p.position IS NULL, p.position, t.position, t.created_at`, id),
    sql('SELECT * FROM documents WHERE case_id = ? ORDER BY created_at', id),
    sql(`SELECT v.id, v.document_id, v.version, v.filename, v.content_type, v.size, v.created_at, v.task_id, v.uploaded_by, v.sha256, v.form_values,
         COALESCE(v.uploader_label, u.name) AS uploader
       FROM document_versions v JOIN documents d ON d.id = v.document_id LEFT JOIN users u ON u.id = v.uploaded_by
       WHERE d.case_id = ? ORDER BY v.version`, id),
    sql('SELECT e.*, u.name AS actor FROM events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.case_id = ? ORDER BY e.id', id),
    sql('SELECT p.user_id, p.role, p.access, p.expires_at, p.revoked_at, u.name, u.email FROM case_participants p JOIN users u ON u.id = p.user_id WHERE p.case_id = ? ORDER BY p.created_at', id),
    sql('SELECT email, role, access, access_until, expires_at, expires_at <= ? AS expired FROM invitations WHERE case_id = ? AND accepted_at IS NULL', time, id),
  ])).map(r => r.results);
  markBlocked(tasks);
  // Guests see the phases (and the current one) of the steps they may see: titles of the others tell too much.
  const visibleTasks = tasks.filter(t => canSeeTask(ctx, t));
  const visiblePhases = ctx.staff ? phases : phases.filter(p => visibleTasks.some(t => t.phase_id === p.id));
  const roleLabel = key => ctx.def.roles.find(r => r.key === key)?.label ?? key;
  // Guests may add versions only through a task, or on top of their own latest, non-final version:
  // otherwise a guest file could silently replace a signed or approved one.
  const visibleDocs = docs.filter(d => canSee(ctx, d));
  const visibleVersions = versions.filter(v => visibleDocs.some(d => d.id === v.document_id)).map(v => v.id);
  const signatures = visibleVersions.length ? await explainSignatures(rq, ctx.c, await rows(
    'SELECT * FROM document_signatures WHERE version_id IN (SELECT value FROM json_each(?)) ORDER BY version_id, position', JSON.stringify(visibleVersions))) : [];
  const canVersion = (d, vs) => ctx.staff || (ctx.access !== 'guest_viewer' && !d.final && vs.at(-1)?.uploaded_by === user.id);
  return {
    stamp: String(events.filter(e => canSee(ctx, e)).at(-1)?.id ?? 0), // same value as caseStamp(rq), read in the same batch as the data
    case: {
      id, title: ctx.c.title, status: ctx.c.status, fields: ctx.staff ? JSON.parse(ctx.c.fields) : {}, created_at: ctx.c.created_at,
      template_name: ctx.c.template_name, template_version: ctx.c.template_version, phase: currentPhase(visiblePhases, visibleTasks),
      template_id: ctx.c.template_id, workspace_id: ctx.c.workspace_id, inbox: ctx.staff ? inboxAddress(rq, ctx.c) : null,
      closed_at: ctx.c.closed_at, retention_days: ctx.def.retention_days ?? null,
      // who the case is waiting for (role labels only, no task titles of other roles)
      waiting_on: [...new Set(tasks.filter(t => t.status === 'open' && !t.blocked && t.role && t.role !== ctx.role).map(t => roleLabel(t.role)))],
    },
    // externals only need role and document type names; field values and rules stay with the team
    definition: ctx.staff ? ctx.def : { roles: ctx.def.roles, document_types: ctx.def.document_types, scales: ctx.def.scales,
      forms: (ctx.def.forms ?? []).map(f => ({ key: f.key, title: f.title })) },
    me: { role: ctx.role, access: ctx.access, staff: ctx.staff, owner: ctx.owner, can_upload: ctx.access !== 'guest_viewer' },
    phases: visiblePhases,
    tasks: visibleTasks,
    documents: visibleDocs.map(d => {
      const vs = versions.filter(v => v.document_id === d.id);
      return { ...d, visible_to: arr(d.visible_to), can_version: canVersion(d, vs),
        versions: vs.map(({ uploaded_by, form_values, ...v }) => ({ ...v, mine: uploaded_by === user.id, signatures: signatures.filter(s => s.version_id === v.id),
          ...(ctx.staff && form_values && { form: JSON.parse(form_values) }) })) };
    }),
    events: events.filter(e => canSee(ctx, e)).map(e => ({ ...e, payload: JSON.parse(e.payload), visible_to: arr(e.visible_to) })),
    participants: ctx.staff ? parts : parts.filter(p => !p.revoked_at).map(({ name, role }) => ({ name, role })),
    invitations: ctx.owner ? invites : [],
    finance: ctx.staff ? financeSummary(await loadFinance(rq, [id])) : null, // guests never see money
    parent: ctx.c.parent_case_id ? await row(`SELECT c.id, c.title FROM cases c WHERE c.id = ?1 AND ${ACCESSIBLE}`, ctx.c.parent_case_id, user.id, time) : null,
    // the phase of a subcase only for the team (it is computed from all its steps)
    subcases: (await rows(`SELECT c.id, c.title, c.status, t.name AS template,
        (SELECT ph.title FROM phases ph WHERE ph.case_id = c.id AND EXISTS (SELECT 1 FROM tasks k WHERE k.phase_id = ph.id AND k.status = 'open') ORDER BY ph.position LIMIT 1) AS phase
      FROM cases c LEFT JOIN templates t ON t.id = c.template_id WHERE c.parent_case_id = ?1 AND ${ACCESSIBLE} ORDER BY c.created_at`, id, user.id, time))
      .map(s => (ctx.staff ? s : { ...s, phase: null })),
    templates: ctx.owner ? await rows('SELECT id, name FROM templates WHERE workspace_id = ? AND archived_at IS NULL ORDER BY name', ctx.c.workspace_id) : [],
    upload_links: ctx.staff ? await rows(`SELECT task_id, label, expires_at, single_use FROM upload_links
      WHERE case_id = ? AND revoked_at IS NULL AND expires_at > ? AND (single_use = 0 OR used_at IS NULL)`, id, time) : [],
    rule_runs: ctx.staff ? await rows(`SELECT rule_id, SUM(status = 'done') AS n, MAX(CASE WHEN status = 'done' THEN created_at END) AS last,
        SUM(status = 'error') AS errors, SUM(status = 'retry') AS retrying, (SELECT detail FROM automation_runs x WHERE x.case_id = r.case_id
          AND x.rule_id = r.rule_id AND x.status IN ('error', 'retry') ORDER BY x.created_at DESC LIMIT 1) AS error
      FROM automation_runs r WHERE case_id = ? GROUP BY rule_id`, id) : [],
  };
}

// Statements that set field values (checked like the Angaben form) and move open deadlines that come from a changed
// date field: those of steps that remember the field, and older ones still on the old date.
// The log names the changed fields, not their values (personal data stays out of the trail).
export function fieldStmts(rq, c, def, input, actorId, extra = {}) {
  const { sql, event } = rq;
  const old = JSON.parse(c.fields);
  const next = { ...old };
  const changed = [];
  for (const [key, value] of Object.entries(input)) {
    const f = def.fields.find(x => x.key === key) ?? fail(400, `Unbekanntes Feld „${key}“`);
    const v = String(value ?? '').trim().slice(0, 500);
    if (f.type === 'date' && v && !isDate(v)) fail(400, `${f.label}: Datum ungültig`);
    if ((old[key] ?? '') !== v) { next[key] = v; changed.push(f); }
  }
  if (!changed.length) return { changed, stmts: [] };
  const moves = changed.filter(f => f.type === 'date')
    .map(f => sql("UPDATE tasks SET due_date = ? WHERE case_id = ? AND status = 'open' AND (due_field = ? OR (due_date IS NOT NULL AND due_date = ?))",
      isDate(next[f.key]) ? next[f.key] : null, c.id, f.key, old[f.key] ?? ''));
  return { changed, stmts: [
    sql('UPDATE cases SET fields = ? WHERE id = ?', JSON.stringify(next), c.id),
    ...moves,
    event(c.id, actorId, 'case.fields_updated', { fields: changed.map(f => f.label), ...extra }, []),
  ] };
}

// Edit the case's field values (Angaben).
export async function updateFields(rq) {
  const { user, params, body, batch } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  if (!ctx.staff) fail(403, 'Nur das Team bearbeitet die Angaben');
  const input = body.fields && typeof body.fields === 'object' ? body.fields : fail(400, 'fields fehlt');
  const { changed, stmts } = fieldStmts(rq, ctx.c, ctx.def, input, user.id);
  if (changed.length) await batch(stmts);
  return { changed: changed.length };
}

// A case moves to another workspace, with its sub-cases (those still in the same workspace). Only owners of both
// workspaces may do this: it changes who oversees the case. Participants keep their seats, files stay where they are
// (their storage keys only record where they began); logo, colour and trusted issuers now come from the new workspace.
export async function moveCase(rq) {
  const { user, params, body, row, rows, sql, batch, event, wsEvent, time } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  await requireWsOwner(rq, user, ctx.c.workspace_id);
  const to = (await row('SELECT id, name FROM workspaces WHERE id = ?', body.workspace_id ?? null)) ?? fail(404, 'Workspace nicht gefunden');
  if (to.id === ctx.c.workspace_id) fail(400, 'Der Vorgang ist schon in diesem Workspace.');
  await requireWsOwner(rq, user, to.id);
  const from = await row('SELECT name FROM workspaces WHERE id = ?', ctx.c.workspace_id);
  const ids = (await rows(`WITH RECURSIVE tree(id) AS (SELECT ?1 UNION SELECT c.id FROM cases c JOIN tree ON c.parent_case_id = tree.id WHERE c.workspace_id = ?2)
    SELECT id FROM tree`, ctx.c.id, ctx.c.workspace_id)).map(r => r.id);
  await batch([
    sql('UPDATE cases SET workspace_id = ? WHERE id IN (SELECT value FROM json_each(?))', to.id, JSON.stringify(ids)),
    // links handed out for the old workspace end: whoever gets one for the new workspace gets it from its team
    sql('UPDATE upload_links SET revoked_at = ? WHERE case_id IN (SELECT value FROM json_each(?)) AND revoked_at IS NULL', time, JSON.stringify(ids)),
    ...ids.map(id => event(id, user.id, 'case.moved', { from: from.name, to: to.name }, [])),
    wsEvent(ctx.c.workspace_id, user.id, 'case.moved_out', { case: ctx.c.title, to: to.name, count: ids.length }),
    wsEvent(to.id, user.id, 'case.moved_in', { case: ctx.c.title, from: from.name, count: ids.length }),
  ]);
  // rules start sub-cases from templates by name, looked up in the case's (now new) workspace
  const wanted = [...new Set((ctx.def.rules ?? []).flatMap(r => r.actions).filter(a => a.type === 'create_subcase').map(a => a.template))];
  const there = new Set((await rows('SELECT name FROM templates WHERE workspace_id = ? AND archived_at IS NULL', to.id)).map(t => t.name));
  return { moved: ids.length, workspace: to.name, missing_templates: wanted.filter(n => !there.has(n)) };
}

export async function updateCase(rq) {
  const { user, params, body, sql, batch, event, time } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  if (!ctx.owner) fail(403, 'Nur Vorgangsverantwortliche');
  if (!['open', 'closed'].includes(body.status)) fail(400, 'Status ungültig');
  const closing = body.status === 'closed';
  await batch([
    ...(closing && ctx.c.parent_case_id
      ? [event(ctx.c.parent_case_id, user.id, 'subcase.closed', { title: ctx.c.title, case_id: ctx.c.id, template: ctx.c.template_name }, [])] : []),
    sql('UPDATE cases SET status = ?, closed_at = ? WHERE id = ?', body.status, closing ? time : null, ctx.c.id),
    sql("DELETE FROM notifications WHERE task_id = ? AND stage = 'retention'", ctx.c.id), // a later close announces again
    event(ctx.c.id, user.id, closing ? 'case.closed' : 'case.reopened', {}, ['*']),
  ]);
}

export async function deleteCase(rq) {
  const { user, params } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  if (!ctx.owner) fail(403, 'Nur Vorgangsverantwortliche können löschen');
  await purgeCase(rq, ctx.c, user.id, 'manual');
}

// Removes a case with everything in it (files in R2 included) and leaves only a tombstone.
// People who were only part of this case lose their account too.
async function purgeCase(rq, c, actorId, reason) {
  const { rows, sql, batch, env, time } = rq;
  for (const child of await rows('SELECT c.id, c.workspace_id, t.name AS template_name FROM cases c LEFT JOIN templates t ON t.id = c.template_id WHERE c.parent_case_id = ?', c.id)) {
    await purgeCase(rq, child, actorId, reason);
  }
  const keys = (await rows('SELECT v.r2_key FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.case_id = ?', c.id)).map(r => r.r2_key);
  const people = (await rows('SELECT user_id FROM case_participants WHERE case_id = ?', c.id)).map(r => r.user_id);
  const ofClaims = 'IN (SELECT id FROM financial_claims WHERE case_id = ?)';
  await batch([
    sql('INSERT INTO case_deletions (case_id, workspace_id, template_name, reason, deleted_by, deleted_at) VALUES (?, ?, ?, ?, ?, ?)',
      c.id, c.workspace_id, c.template_name ?? null, reason, actorId, time),
    sql('DELETE FROM notifications WHERE task_id = ? OR task_id IN (SELECT id FROM tasks WHERE case_id = ?)', c.id, c.id),
    sql('DELETE FROM document_signatures WHERE version_id IN (SELECT v.id FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.case_id = ?)', c.id),
    sql('DELETE FROM document_versions WHERE document_id IN (SELECT id FROM documents WHERE case_id = ?)', c.id),
    sql('DELETE FROM documents WHERE case_id = ?', c.id),
    sql(`DELETE FROM financial_transactions WHERE claim_id ${ofClaims}`, c.id),
    sql(`DELETE FROM financial_decisions WHERE claim_id ${ofClaims}`, c.id),
    sql('DELETE FROM financial_claims WHERE case_id = ?', c.id),
    sql('DELETE FROM tasks WHERE case_id = ?', c.id),
    sql('DELETE FROM phases WHERE case_id = ?', c.id),
    sql('DELETE FROM events WHERE case_id = ?', c.id),
    sql('DELETE FROM invitations WHERE case_id = ?', c.id),
    sql('DELETE FROM case_participants WHERE case_id = ?', c.id),
    sql('DELETE FROM upload_links WHERE case_id = ?', c.id),
    sql('DELETE FROM inbound_mail WHERE case_id = ?', c.id),
    sql('DELETE FROM automation_runs WHERE case_id = ?', c.id),
    sql('DELETE FROM cases WHERE id = ?', c.id),
  ]);
  // the rows are gone now: files R2 fails to delete here are found and removed by the daily sweep (sweepOrphanFiles)
  for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000)).catch(e => console.error('R2 delete failed (the daily sweep retries)', c.id, e.message));
  const orphans = await rows(`SELECT id FROM users WHERE id IN (SELECT value FROM json_each(?))
    AND NOT EXISTS (SELECT 1 FROM case_participants WHERE user_id = users.id) AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE user_id = users.id)`, JSON.stringify(people));
  for (const { id } of orphans) {
    await batch(['sessions', 'passkeys', 'login_links', 'challenges', 'notifications', 'signing_keys', 'consents'].map(t => sql(`DELETE FROM ${t} WHERE user_id = ?`, id))
      .concat(sql('UPDATE signing_keys SET vouched_by = NULL WHERE vouched_by = ?', id), sql('DELETE FROM users WHERE id = ?', id)))
      .catch(e => console.error('user purge failed', id, e.message));
  }
}

// Closed cases whose template sets retention_days: announce 14 days ahead, then delete.
export async function applyRetention(rq) {
  const { rows, sql, env, time } = rq;
  const today = time.slice(0, 10);
  const cases = await rows(`SELECT c.id, c.workspace_id, c.title, c.closed_at, json_extract(c.definition, '$.retention_days') AS days, t.name AS template_name
    FROM cases c LEFT JOIN templates t ON t.id = c.template_id
    WHERE c.status = 'closed' AND c.closed_at IS NOT NULL AND json_extract(c.definition, '$.retention_days') IS NOT NULL`);
  for (const c of cases) {
    const deleteOn = new Date(Date.parse(c.closed_at) + c.days * 864e5).toISOString().slice(0, 10);
    if (deleteOn <= today) {
      await purgeCase(rq, c, null, 'retention');
      continue;
    }
    if (Date.parse(deleteOn) - Date.parse(today) > 14 * 864e5) continue;
    const owners = await rows(`SELECT u.id, u.email, u.name FROM case_participants p JOIN users u ON u.id = p.user_id
      WHERE p.case_id = ? AND p.access = 'case_owner' AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?)
      AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = u.id AND n.task_id = p.case_id AND n.stage = 'retention')`, c.id, time);
    for (const o of owners) {
      const ok = await sendMail(rq, o.email, `Wird gelöscht: ${c.title}`, [
        `Guten Tag ${o.name},`,
        `der abgeschlossene Vorgang „${c.title}“ wird gemäß Aufbewahrungsfrist am ${deDate(deleteOn)} endgültig gelöscht, mit allen Dokumenten und Nachrichten.`,
        `Wenn Sie ihn behalten möchten, öffnen Sie ihn wieder:
${env.ORIGIN}/#/case/${c.id}`,
      ]);
      if (ok) await sql("INSERT OR IGNORE INTO notifications (user_id, task_id, stage, sent_at) VALUES (?, ?, 'retention', ?)", o.id, c.id, time).run();
    }
  }
}

export async function dashboard(rq) {
  const { user, rows, sql, batch, time } = rq;
  const stamp = await dashboardStamp(rq, user); // before the data: a change in between only causes one extra refresh
  const cases = await rows(`
    SELECT c.id, c.title, c.status, c.workspace_id, c.parent_case_id, w.name AS workspace, t.name AS template,
      json_extract(c.definition, '$.roles') AS roles, p.role, p.access, m.role AS ws_role,
      (SELECT MAX(e.created_at) FROM events e WHERE e.case_id = c.id AND ${seesEvent('?1')}) AS last_activity -- like the stamp: what the user may see
    FROM cases c
    JOIN workspaces w ON w.id = c.workspace_id
    LEFT JOIN templates t ON t.id = c.template_id
    LEFT JOIN case_participants p ON p.case_id = c.id AND p.user_id = ?1 AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?2)
    LEFT JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = ?1
    WHERE p.user_id IS NOT NULL OR m.role = 'owner'
    ORDER BY c.created_at DESC`, user.id, time);
  const caseIds = JSON.stringify(cases.map(c => c.id));
  const [phases, tasks, holders] = (await batch([
    sql('SELECT * FROM phases WHERE case_id IN (SELECT value FROM json_each(?)) ORDER BY position', caseIds),
    sql('SELECT * FROM tasks WHERE case_id IN (SELECT value FROM json_each(?)) ORDER BY position, created_at', caseIds),
    sql(`SELECT p.case_id, p.role, u.name FROM case_participants p JOIN users u ON u.id = p.user_id
       WHERE p.case_id IN (SELECT value FROM json_each(?)) AND p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?)`, caseIds, time),
  ])).map(r => r.results);
  const today = time.slice(0, 10);
  markBlocked(tasks);
  for (const c of cases) {
    c.staff = c.ws_role === 'owner' || STAFF.includes(c.access);
    c.parent_title = cases.find(x => x.id === c.parent_case_id)?.title ?? null; // only parents the user can open anyway
  }
  const claims = await loadFinance(rq, cases.filter(c => c.staff).map(c => c.id));
  const openReceivable = cs => sum(cs.filter(x => x.direction === 'receivable'), x => x.open_cents);
  const myTasks = [];
  for (const c of cases) {
    const ctx = { user, role: c.role, staff: c.staff };
    const all = tasks.filter(t => t.case_id === c.id);
    const open = c.status === 'closed' ? [] : all.filter(t => t.status === 'open' && canSeeTask(ctx, t)); // closed: nothing left to do
    c.phase = currentPhase(phases.filter(p => p.case_id === c.id), all.filter(t => canSeeTask(ctx, t))); // a guest: of the steps they see
    c.next_due = open.map(t => t.due_date).filter(Boolean).sort()[0] ?? null;
    c.open_tasks = open.length;
    c.open_receivable_cents = openReceivable(claims.filter(x => x.case_id === c.id));
    // Worklist: whom the case waits for (names only for the team, guests see roles), and overdue steps of others.
    const roles = JSON.parse(c.roles ?? '[]');
    delete c.roles;
    const othersOpen = open.filter(t => !t.blocked && !(c.role && t.role === c.role));
    c.waiting_for = [...new Set(othersOpen.map(t => t.role).filter(Boolean))].map(r => ({
      role: roles.find(x => x.key === r)?.label ?? r,
      names: c.staff ? holders.filter(h => h.case_id === c.id && h.role === r).map(h => h.name) : [],
    }));
    c.overdue_others = c.staff ? othersOpen.filter(t => t.due_date && t.due_date < today).length : 0;
    for (const t of open) if (c.role && t.role === c.role && !t.blocked) myTasks.push({ id: t.id, title: t.title, type: t.type, assess: t.assess, due_date: t.due_date, case_id: c.id, case_title: c.title });
  }
  myTasks.sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'));
  return { stamp, cases, my_tasks: myTasks, open_receivable_cents: claims.length ? openReceivable(claims) : null };
}

export async function addPhase(rq) {
  const { user, params, body, sql, batch, event } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  if (!ctx.staff) fail(403, 'Nur Bearbeiter');
  const title = String(body.title ?? '').trim() || fail(400, 'Titel fehlt');
  await batch([
    sql('INSERT INTO phases (id, case_id, title, position) SELECT ?, ?, ?, COALESCE(MAX(position), -1) + 1 FROM phases WHERE case_id = ?', uid(), ctx.c.id, title, ctx.c.id),
    event(ctx.c.id, user.id, 'phase.added', { phase: title }, ['*']),
  ]);
}

export async function addComment(rq) {
  const { user, params, body, event } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  if (ctx.access === 'guest_viewer') fail(403, 'Mit Lesezugriff können Sie keine Nachrichten schreiben');
  const text = String(body.body ?? '').trim() || fail(400, 'Nachricht ist leer');
  if (text.length > 10000) fail(413, 'Nachricht zu lang (höchstens 10.000 Zeichen)');
  // Guests always write to staff + their own role; staff choose the audience ([] = internal).
  await event(ctx.c.id, user.id, 'comment', { body: text }, ctx.staff ? roleList(body.visible_to ?? []) : [ctx.role]).run();
}
