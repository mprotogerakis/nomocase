// Templates: definition check, versions, instantiating a case, turning a case back into a template.
import { ACCESS, arr, DB, DECISIONS, ev, fail, isDate, now, q, row, rows, TASK_TYPES, uid } from './core.js';
import { caseCtx, requireWsOwner } from './access.js';
import { RULE_ACTIONS, RULE_OPS, RULE_TRIGGERS } from './rules.js';
import { scaleProblem } from '../public/shared/assess.js';

export function checkDef(d) {
  const ok = (cond, msg) => cond || fail(400, `Vorlage ungültig: ${msg}`);
  ok(d && typeof d === 'object' && Array.isArray(d.roles) && Array.isArray(d.phases), 'roles und phases müssen Listen sein');
  const roles = new Set(d.roles.map(r => (ok(r.key && r.label && ACCESS.includes(r.access), `Rolle ${JSON.stringify(r)}`), r.key)));
  ok(d.roles.some(r => r.access === 'case_owner'), 'mindestens eine Rolle braucht access "case_owner"');
  ok(d.finance === undefined || typeof d.finance === 'boolean' || (d.finance && typeof d.finance === 'object' && Object.values(d.finance.labels ?? {}).every(v => typeof v === 'string')),
    'finance: true/false oder { "labels": { … } } mit eigenen Begriffen');
  const ruleIds = new Set();
  for (const r of (d.rules ??= [])) {
    const name = JSON.stringify(r?.id ?? r?.name ?? '?');
    ok(r && r.id && !ruleIds.has(r.id) && r.name && RULE_TRIGGERS.includes(r.trigger), `Regel ${name}: eindeutige id, name und ein bekannter trigger nötig`);
    ruleIds.add(r.id);
    ok(Array.isArray(r.conditions ??= []) && r.conditions.every(c => c && typeof c.field === 'string' && RULE_OPS[c.operator]), `Regel ${name}: Bedingung braucht field und operator (${Object.keys(RULE_OPS).join(', ')})`);
    ok(Array.isArray(r.actions) && r.actions.length && r.actions.every(a => RULE_ACTIONS.includes(a?.type)), `Regel ${name}: Aktionen ${RULE_ACTIONS.join(', ')}`);
    for (const a of r.actions) {
      if (a.type === 'create_task') ok(a.title && (!a.assign_to_role || a.assign_to_role === 'owner' || roles.has(a.assign_to_role)) && TASK_TYPES.includes(a.task_type ?? 'task'), `Regel ${name}: create_task braucht title, gültige assign_to_role und task_type`);
      if (a.type === 'complete_tasks') ok(a.key || a.task_type || a.title, `Regel ${name}: complete_tasks braucht key, task_type oder title`);
      if (a.type === 'add_comment') ok(a.text, `Regel ${name}: add_comment braucht text`);
      if (a.type === 'create_subcase') ok(a.template && a.title, `Regel ${name}: create_subcase braucht template (Name einer Vorlage im Workspace) und title`);
    }
  }
  ok(d.retention_days === undefined || (Number.isInteger(d.retention_days) && d.retention_days > 0), 'retention_days muss eine positive ganze Zahl sein');
  for (const f of (d.fields ??= [])) ok(f.key && f.label, `Feld ${JSON.stringify(f)}`);
  const docTypes = new Set((d.document_types ??= []).map(t => (ok(t.key && t.label, `Dokumenttyp ${JSON.stringify(t)}`), (t.visible_to ??= []), t.key)));
  const keys = new Set();
  for (const p of d.phases) {
    ok(p.title, 'Phase ohne Titel');
    for (const t of (p.tasks ??= [])) {
      ok(t.key && !keys.has(t.key), `Aufgaben-Key "${t.key}" fehlt oder ist doppelt`);
      keys.add(t.key);
      ok(t.title, `Aufgabe ${t.key} ohne Titel`);
      ok(TASK_TYPES.includes(t.type ??= 'task'), `Typ "${t.type}" unbekannt`);
      ok(!t.role || roles.has(t.role), `Rolle "${t.role}" unbekannt`);
      ok(!t.doc_type || docTypes.has(t.doc_type), `Dokumenttyp "${t.doc_type}" unbekannt`);
      ok(t.due_field === undefined || d.fields.some(f => f.key === t.due_field && f.type === 'date'), `due_field bei "${t.key}": muss ein Datumsfeld sein`);
      ok(t.labels === undefined || (DECISIONS.includes(t.type) && Array.isArray(t.labels) && t.labels.length === 2 && t.labels.every(l => typeof l === 'string' && l.trim())),
        `labels bei "${t.key}": zwei Beschriftungen, nur bei review/approval/decision`);
      ok(t.assess === undefined || (d.scales?.[t.assess] && DECISIONS.includes(t.type)), `assess bei "${t.key}": eine Skala aus scales, nur bei review/approval/decision`);
      ok(t.visible_to === undefined || (Array.isArray(t.visible_to) && t.visible_to.every(v => v === '*' || roles.has(v))), `visible_to bei "${t.key}": Liste von Rollen oder "*"`);
      const m = t.money;
      ok(m === undefined || (m && typeof m === 'object' && (
        (typeof m.claim === 'string' && ['payable', 'receivable'].includes(m.direction)) || typeof m.decision === 'string' || typeof m.payment === 'string')),
        `money bei "${t.key}": {"claim", "direction"} oder {"decision"} oder {"payment"}`);
    }
  }
  for (const p of d.phases) for (const t of p.tasks) for (const k of t.after ?? []) ok(keys.has(k), `after: "${k}" unbekannt`);
  ok(d.due_base_field === undefined || d.fields.some(f => f.key === d.due_base_field && f.type === 'date'), 'due_base_field muss ein Datumsfeld sein');
  // Assessments: scales the steps are assessed on, and how several assessments combine into one value.
  for (const [k, scale] of Object.entries(d.scales ?? {})) { const problem = scaleProblem(scale); ok(!problem, `Skala "${k}": ${problem}`); }
  const assessed = new Map(d.phases.flatMap(p => p.tasks).filter(t => t.assess).map(t => [t.key, t.assess]));
  for (const a of (d.aggregates ??= [])) {
    ok(a && a.key && a.label && d.scales?.[a.scale], `Verrechnung "${a?.key}": braucht key, label und eine Skala aus scales`);
    ok(Array.isArray(a.from) && a.from.length && a.from.every(k => assessed.get(k) === a.scale), `Verrechnung "${a.key}": from = Schritte, die auf "${a.scale}" bewertet werden`);
    ok(['mean', 'min', 'max', 'sum'].includes(a.method ?? 'mean') && ['truncate', 'half_up'].includes(a.round ?? 'half_up'), `Verrechnung "${a.key}": method mean|min|max|sum, round truncate|half_up`);
    ok(a.field === undefined || d.fields.some(f => f.key === a.field), `Verrechnung "${a.key}": field "${a.field}" gibt es nicht`);
  }
  // Rules refer to steps by key (template steps, or steps a rule creates): a typo would silently never match.
  const ruleKeys = new Set(d.rules.flatMap(r => r.actions.filter(a => a.type === 'create_task' && a.key).map(a => a.key)));
  for (const k of ruleKeys) ok(!keys.has(k), `Regel-Schritt "${k}": der Key gehört schon einem Vorlagen-Schritt`);
  const known = k => keys.has(k) || ruleKeys.has(k);
  for (const r of d.rules) {
    for (const c of r.conditions.filter(c => c.field === 'task.key')) {
      for (const k of [c.value].flat()) ok(known(k), `Regel „${r.name}“: Schritt "${k}" gibt es nicht`);
    }
    for (const a of r.actions.filter(a => a.type === 'complete_tasks' && a.key)) ok(known(a.key), `Regel „${r.name}“: Schritt "${a.key}" gibt es nicht`);
  }
  return d;
}

export async function listTemplates({ user }) {
  const list = await rows(`
    SELECT t.id, t.name, t.workspace_id, w.name AS workspace, v.version, v.definition, v.created_at
    FROM templates t
    JOIN workspaces w ON w.id = t.workspace_id
    JOIN workspace_members m ON m.workspace_id = t.workspace_id AND m.user_id = ?
    JOIN template_versions v ON v.template_id = t.id AND v.version = (SELECT MAX(version) FROM template_versions WHERE template_id = t.id)
    ORDER BY w.name, t.name`, user.id);
  return list.map(t => ({ ...t, definition: JSON.parse(t.definition) }));
}

// Templates are never edited in place: every change is a new version, running cases keep their copy.
const versionStmt = (templateId, version, def, userId) =>
  q('INSERT INTO template_versions (template_id, version, definition, created_at, created_by) VALUES (?, ?, ?, ?, ?)',
    templateId, version, JSON.stringify(def), now(), userId);
const nextVersion = async templateId => (await row('SELECT MAX(version) + 1 AS v FROM template_versions WHERE template_id = ?', templateId)).v;

export async function createTemplate({ user, body }) {
  await requireWsOwner(user, body.workspace_id);
  const name = String(body.name ?? '').trim() || fail(400, 'Name fehlt');
  const def = checkDef(body.definition);
  const id = uid();
  await DB.batch([
    q('INSERT INTO templates (id, workspace_id, name) VALUES (?, ?, ?)', id, body.workspace_id, name),
    versionStmt(id, 1, def, user.id),
  ]);
  return { id };
}

export async function addTemplateVersion({ user, params, body }) {
  const t = (await row('SELECT * FROM templates WHERE id = ?', params.id)) ?? fail(404, 'Vorlage nicht gefunden');
  await requireWsOwner(user, t.workspace_id);
  const def = checkDef(body.definition);
  const v = await nextVersion(t.id);
  await versionStmt(t.id, v, def, user.id).run();
  return { version: v };
}

export const latestTemplate = id => row(`SELECT t.id, t.workspace_id, t.name, v.version, v.definition FROM templates t
  JOIN template_versions v ON v.template_id = t.id WHERE t.id = ? ORDER BY v.version DESC LIMIT 1`, id ?? null);

// Statements that create a case (with phases and tasks) from the latest version of a template.
// `actorId` is null when a rule creates the case (then `by` names the rule).
export function instantiate(tpl, { title, fields: input = {}, ownerId, actorId = ownerId, parentId = null, by = {} }) {
  const def = JSON.parse(tpl.definition);
  const fields = Object.fromEntries(def.fields.map(f => [f.key, String(input?.[f.key] ?? '')]));
  // due_days count from the date field the template names (due_base_field), else from today
  const base = isDate(fields[def.due_base_field]) ? new Date(fields[def.due_base_field]) : new Date();
  const due = days => (days == null ? null : new Date(base.getTime() + days * 864e5).toISOString().slice(0, 10));
  const caseId = uid(), ts = now();
  const ownerRole = def.roles.find(r => r.access === 'case_owner').key;
  const taskIds = Object.fromEntries(def.phases.flatMap(p => p.tasks).map(t => [t.key, uid()]));
  const stmts = [
    q('INSERT INTO cases (id, workspace_id, template_id, template_version, title, definition, fields, created_at, parent_case_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      caseId, tpl.workspace_id, tpl.id, tpl.version, title,
      JSON.stringify({ roles: def.roles, fields: def.fields, document_types: def.document_types, finance: def.finance ?? false, retention_days: def.retention_days ?? null,
        ...(def.due_base_field && { due_base_field: def.due_base_field }),
        rules: def.rules ?? [], ...(def.scales && { scales: def.scales }), ...(def.aggregates?.length && { aggregates: def.aggregates }) }),
      JSON.stringify(fields), ts, parentId),
    q('INSERT INTO case_participants (case_id, user_id, access, role, created_at) VALUES (?, ?, ?, ?, ?)', caseId, ownerId, 'case_owner', ownerRole, ts),
  ];
  def.phases.forEach((p, i) => {
    const phaseId = uid();
    stmts.push(q('INSERT INTO phases (id, case_id, title, position) VALUES (?, ?, ?, ?)', phaseId, caseId, p.title, i));
    p.tasks.forEach((t, j) => stmts.push(q(
      `INSERT INTO tasks (id, case_id, phase_id, title, description, type, role, depends_on, doc_type, due_date, position, created_by, created_at, money, visible_to, labels, assess, key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      taskIds[t.key], caseId, phaseId, t.title, t.description ?? null, t.type, t.role ?? null,
      JSON.stringify((t.after ?? []).map(k => taskIds[k])), t.doc_type ?? null,
      t.due_field ? (isDate(fields[t.due_field]) ? fields[t.due_field] : null) : due(t.due_days), j, ownerId, ts,
      t.money ? JSON.stringify(t.money) : null, JSON.stringify(t.visible_to ?? []), t.labels ? JSON.stringify(t.labels) : null, t.assess ?? null, t.key)));
  });
  stmts.push(ev(caseId, actorId, 'case.created', { template: tpl.name, version: tpl.version, ...by }, ['*']));
  return { caseId, stmts };
}

// A case that has been shaped by hand becomes a template (or a new version of one). Only the structure goes over:
// no field values, documents, messages or people; no guest requests and no tasks a rule created (the rule does that again).

const slug = s => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'schritt';

function caseDefinition(c, def, phases, tasks) {
  const fields = JSON.parse(c.fields);
  const base = isDate(fields[def.due_base_field]) ? fields[def.due_base_field] : c.created_at.slice(0, 10);
  const kept = tasks.filter(t => t.phase_id && t.created_by); // loose tasks are requests or rule-made; rule-made have no creator
  const keys = new Map();
  for (const t of kept.filter(t => t.key)) keys.set(t.id, t.key); // template steps keep their key, rules depend on it
  for (const t of kept.filter(t => !t.key)) {
    let key = slug(t.title);
    while ([...keys.values()].includes(key)) key += '-2';
    keys.set(t.id, key);
  }
  const step = t => {
    const after = arr(t.depends_on).filter(id => keys.has(id)).map(id => keys.get(id));
    const dueField = t.due_date && def.fields.find(f => f.type === 'date' && fields[f.key] === t.due_date)?.key;
    const money = typeof t.money === 'string' ? JSON.parse(t.money) : t.money;
    const labels = typeof t.labels === 'string' ? JSON.parse(t.labels) : t.labels;
    return Object.fromEntries(Object.entries({
      key: keys.get(t.id), title: t.title, type: t.type, role: t.role, doc_type: t.doc_type, description: t.description,
      after: after.length ? after : null,
      due_field: dueField || null,
      due_days: t.due_date && !dueField ? Math.round((Date.parse(t.due_date) - Date.parse(base)) / 864e5) : null,
      visible_to: arr(t.visible_to).length ? arr(t.visible_to) : null, money, labels, assess: t.assess,
    }).filter(([, v]) => v != null && v !== ''));
  };
  return checkDef({
    roles: def.roles, fields: def.fields, document_types: def.document_types,
    ...(def.finance && { finance: def.finance }), ...(def.retention_days && { retention_days: def.retention_days }),
    ...(def.due_base_field && { due_base_field: def.due_base_field }),
    phases: phases.map(p => ({ title: p.title, tasks: kept.filter(t => t.phase_id === p.id).map(step) })),
    rules: def.rules ?? [],
    ...(def.scales && { scales: def.scales }),
    aggregates: (def.aggregates ?? []).filter(a => a.from.every(k => [...keys.values()].includes(k))),
  });
}

export async function saveAsTemplate({ user, params, body }) {
  const ctx = await caseCtx(user, params.id);
  if (!ctx.owner) fail(403, 'Nur Vorgangsverantwortliche');
  await requireWsOwner(user, ctx.c.workspace_id);
  const [phases, tasks] = (await DB.batch([
    q('SELECT * FROM phases WHERE case_id = ? ORDER BY position', ctx.c.id),
    q('SELECT t.* FROM tasks t LEFT JOIN phases p ON p.id = t.phase_id WHERE t.case_id = ? ORDER BY p.position, t.position, t.created_at', ctx.c.id),
  ])).map(r => r.results);
  const def = caseDefinition(ctx.c, ctx.def, phases, tasks);
  let templateId, name, version;
  if (body.template_id) {
    const t = (await row('SELECT * FROM templates WHERE id = ? AND workspace_id = ?', body.template_id, ctx.c.workspace_id)) ?? fail(404, 'Vorlage nicht gefunden');
    [templateId, name, version] = [t.id, t.name, await nextVersion(t.id)];
    await versionStmt(t.id, version, def, user.id).run();
  } else {
    name = String(body.name ?? '').trim().slice(0, 80) || fail(400, 'Name der Vorlage fehlt');
    [templateId, version] = [uid(), 1];
    await DB.batch([
      q('INSERT INTO templates (id, workspace_id, name) VALUES (?, ?, ?)', templateId, ctx.c.workspace_id, name),
      versionStmt(templateId, 1, def, user.id),
    ]);
  }
  await ev(ctx.c.id, user.id, 'case.saved_as_template', { template: name, version }, []).run();
  return { template_id: templateId, name, version };
}
