// Tasks: blocked state, editing, actions (complete, decide, assess, ask back, skip, reopen).
import { arr, DB, DECISIONS, ev, fail, isDate, NEEDS_FILE, now, q, roleList, row, rows, TASK_TYPES, uid } from './core.js';
import { canSeeTask, canWork, caseCtx, taskAudience } from './access.js';
import { moneyStmts } from './finance.js';
import { formatScore, parseScore, passes, verdict } from '../public/shared/assess.js';

// A task is blocked while a dependency is open or was rejected. Deleted dependencies don't block.
// Decisions with own labels (e.g. "Bestanden" / "Nicht bestanden") or an assessment record a result and never block:
// a failed result still has to be reported. Without labels a rejection is a closed gate.
export function markBlocked(tasks) {
  const ids = new Set(tasks.map(t => t.id));
  const ok = new Set(tasks.filter(t => t.status === 'skipped' || (t.status === 'done' && (t.outcome !== 'rejected' || t.labels || t.assess))).map(t => t.id));
  for (const t of tasks) {
    t.depends_on = arr(t.depends_on);
    t.visible_to = arr(t.visible_to);
    t.money = typeof t.money === 'string' ? JSON.parse(t.money) : t.money ?? null;
    t.labels = typeof t.labels === 'string' ? JSON.parse(t.labels) : t.labels ?? null;
    t.blocked = t.depends_on.some(d => ids.has(d) && !ok.has(d));
  }
  return tasks;
}

export async function loadTask(user, taskId) {
  const { case_id } = (await row('SELECT case_id FROM tasks WHERE id = ?', taskId)) ?? fail(404, 'Aufgabe nicht gefunden');
  const ctx = await caseCtx(user, case_id);
  const tasks = markBlocked(await rows('SELECT * FROM tasks WHERE case_id = ?', case_id));
  const t = tasks.find(x => x.id === taskId);
  if (!canSeeTask(ctx, t)) fail(404, 'Aufgabe nicht gefunden');
  return { ctx, t, tasks };
}

async function cleanTask(ctx, b, tasks, selfId) {
  const t = {};
  for (const k of ['title', 'description', 'type', 'role', 'phase_id', 'due_date', 'doc_type']) if (k in b) t[k] = b[k] ? String(b[k]).trim().slice(0, k === 'description' ? 5000 : 200) : null;
  if ('title' in t && !t.title) fail(400, 'Titel fehlt');
  if (t.type && !TASK_TYPES.includes(t.type)) fail(400, 'Unbekannter Aufgabentyp');
  if (t.role && !ctx.def.roles.some(r => r.key === t.role)) fail(400, 'Unbekannte Rolle');
  if (t.doc_type && !ctx.def.document_types.some(d => d.key === t.doc_type)) fail(400, 'Unbekannter Dokumenttyp');
  if (t.due_date && !isDate(t.due_date)) fail(400, 'Datum ungültig');
  if (t.phase_id && !(await row('SELECT 1 FROM phases WHERE id = ? AND case_id = ?', t.phase_id, ctx.c.id))) fail(400, 'Unbekannte Phase');
  if ('visible_to' in b) {
    // who else may follow this step, besides the role doing it
    const list = roleList(b.visible_to);
    if (!list.every(v => v === '*' || ctx.def.roles.some(r => r.key === v))) fail(400, 'Unbekannte Rolle');
    t.visible_to = JSON.stringify(list);
  }
  if ('depends_on' in b) {
    const ids = new Set(tasks.map(x => x.id));
    if (!Array.isArray(b.depends_on) || !b.depends_on.every(d => ids.has(d) && d !== selfId)) fail(400, 'Ungültige Abhängigkeit');
    t.depends_on = JSON.stringify(b.depends_on);
  }
  return t;
}

export async function addTask({ user, params, body }) {
  const ctx = await caseCtx(user, params.id);
  const tasks = await rows('SELECT id FROM tasks WHERE case_id = ?', ctx.c.id);
  let t;
  if (ctx.staff) {
    t = { type: 'task', depends_on: '[]', visible_to: '[]', ...(await cleanTask(ctx, body, tasks)) };
  } else if (ctx.access === 'guest_contributor') {
    // Guests can't change the process, but they can file a request (e.g. an extension),
    // which lands as a decision task for the case owner.
    t = {
      ...(await cleanTask(ctx, { title: body.title, description: body.description }, tasks)),
      type: 'decision', role: ctx.def.roles.find(r => r.access === 'case_owner').key, depends_on: '[]', visible_to: JSON.stringify([ctx.role]),
    };
  } else fail(403, 'Keine Berechtigung');
  if (!t.title) fail(400, 'Titel fehlt');
  t.id = uid();
  await DB.batch([
    q(`INSERT INTO tasks (id, case_id, phase_id, title, description, type, role, depends_on, visible_to, doc_type, due_date, position, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.id, ctx.c.id, t.phase_id ?? null, t.title, t.description ?? null, t.type, t.role ?? null, t.depends_on, t.visible_to,
      t.doc_type ?? null, t.due_date ?? null, 1e6, user.id, now()),
    ev(ctx.c.id, user.id, ctx.staff ? 'task.added' : 'request.created', { task: t.title, task_id: t.id, description: t.description ?? '' }, taskAudience(t)),
  ]);
  return { id: t.id };
}

export async function updateTask({ user, params, body }) {
  const { ctx, t, tasks } = await loadTask(user, params.id);
  if (!ctx.staff) fail(403, 'Nur Bearbeiter können Aufgaben ändern');
  const changes = await cleanTask(ctx, body, tasks, t.id);
  if (!Object.keys(changes).length) fail(400, 'Keine Änderungen');
  await DB.batch([
    q(`UPDATE tasks SET ${Object.keys(changes).map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(changes), t.id),
    ev(ctx.c.id, user.id, 'task.updated', { task: t.title, changes }, taskAudience({ ...t, ...changes })),
  ]);
}

export async function deleteTask({ user, params }) {
  const { ctx, t } = await loadTask(user, params.id);
  if (!ctx.staff) fail(403, 'Nur Bearbeiter können Aufgaben entfernen');
  await DB.batch([q('DELETE FROM tasks WHERE id = ?', t.id), ev(ctx.c.id, user.id, 'task.removed', { task: t.title }, taskAudience(t))]);
}

export async function taskAction({ user, params, body }) {
  const { ctx, t, tasks } = await loadTask(user, params.id);
  let { action } = body;
  const note = String(body.note ?? '').trim().slice(0, 5000);
  // Assessed steps are decided by the value given: a value that does not pass the scale counts as a rejection.
  const scale = t.assess ? ctx.def.scales?.[t.assess] ?? fail(500, `Skala "${t.assess}" fehlt im Vorgang`) : null;
  const score = scale && ['assess', 'approve', 'reject'].includes(action)
    ? parseScore(scale, body.score) ?? fail(400, `${scale.label}: ${scale.hint ?? 'Wert ungültig'}`) : null;
  if (score !== null) action = passes(scale, score) ? 'approve' : 'reject';
  else if (action === 'assess') fail(400, 'Dieser Schritt wird nicht bewertet');
  if (['complete', 'approve', 'reject', 'question'].includes(action)) {
    if (!canWork(ctx, t)) fail(403, 'Keine Berechtigung für diese Aufgabe');
    if (t.status !== 'open') fail(409, 'Aufgabe ist nicht offen');
    if (t.blocked) fail(409, 'Vorherige Aufgaben sind noch offen');
    if (action !== 'complete' && !DECISIONS.includes(t.type)) fail(400, 'Aktion passt nicht zum Aufgabentyp');
    if (action === 'complete' && NEEDS_FILE.includes(t.type)) fail(400, 'Diese Aufgabe wird erledigt, indem die Datei hochgeladen wird.');
    if (action === 'question' && !t.depends_on.length) fail(400, 'Diese Aufgabe hat keinen Vorgänger, an den eine Rückfrage gehen könnte.');
  } else if (['skip', 'reopen'].includes(action)) {
    if (!ctx.staff) fail(403, 'Nur Bearbeiter');
  } else fail(400, 'Unbekannte Aktion');

  // Outcomes of reviews and decisions also go to whoever did the work before (e.g. the student who uploaded).
  // Assessments stay with whoever may see the assessing step: the person assessed learns the overall result, not single values.
  const deps = tasks.filter(x => t.depends_on.includes(x.id));
  const audience = ['approve', 'reject', 'question'].includes(action) && score === null ? [...new Set([...taskAudience(t), ...deps.flatMap(taskAudience)])] : taskAudience(t);
  const stmts = [];
  if (action === 'question') {
    // "Rückfrage": send the work back by reopening the direct dependencies; this task stays open and waits for them.
    if (!note) fail(400, 'Rückfrage braucht einen Text');
    stmts.push(
      q("UPDATE tasks SET status = 'open', outcome = NULL, completed_at = NULL, completed_by = NULL WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(t.depends_on)),
      q('DELETE FROM notifications WHERE task_id IN (SELECT value FROM json_each(?))', JSON.stringify(t.depends_on)), // reopened = new again in the digest
    );
  } else {
    const [status, outcome] = { complete: ['done', null], approve: ['done', 'approved'], reject: ['done', 'rejected'], skip: ['skipped', null], reopen: ['open', null] }[action];
    const closed = status !== 'open';
    stmts.push(q('UPDATE tasks SET status = ?, outcome = ?, completed_at = ?, completed_by = ?, score = ? WHERE id = ?',
      status, outcome, closed ? now() : null, closed ? user.id : null, closed ? score : null, t.id));
    if (action === 'complete') stmts.push(...await moneyStmts(ctx, user, t, body.amount_cents));
    if (action === 'reopen') stmts.push(q('DELETE FROM notifications WHERE task_id = ?', t.id));
  }
  stmts.push(ev(ctx.c.id, user.id, `task.${action}`, { task: t.title, task_id: t.id, type: t.type, note, ...(action === 'question' && { reopened: t.depends_on }),
    ...(t.labels && ['approve', 'reject'].includes(action) && { verdict: t.labels[action === 'approve' ? 0 : 1] }),
    ...(score !== null && { score, score_label: formatScore(scale, score), verdict: t.labels?.[action === 'approve' ? 0 : 1] ?? verdict(scale, score) }) }, audience));
  await DB.batch(stmts);
}
