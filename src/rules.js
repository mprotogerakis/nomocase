// Rule engine: triggers, conditions, actions; processed after writes and by cron, idempotent per event.
import { addDays, fail, uid } from './core.js';
import { caseCtx, taskAudience } from './access.js';
import { instantiate, RULE_OPS } from './templates.js';
import { eur, loadFinance, sum } from './finance.js';
import { deDate } from './notify.js';

// Declarative automations (spec section 9): {id, name, trigger, conditions: [{field, operator, value}], actions: [...]}.
// They run right after the request that wrote the triggering event (and again from the cron as a catch-up).
// Safety: the (event, rule) key in automation_runs makes each rule run once per event; events caused by a rule
// carry payload.rule and never trigger rules themselves, so rules cannot loop.

// Amounts are cents in conditions and euros in texts.
const MONEY_FACTS = ['claim.amount', 'claim.recognized', 'claim.cut', 'claim.settled', 'claim.open', 'case.payables_open', 'case.receivables_open'];

// Everything a condition or a {placeholder} can refer to, for one event.
async function ruleFacts(rq, c, e, p) {
  const { row } = rq;
  const f = { 'event.type': e.type, 'event.actor': e.actor ?? '', 'case.title': c.title };
  if (e.actor_id) f['event.actor_role'] = (await row('SELECT role FROM case_participants WHERE case_id = ? AND user_id = ?', c.id, e.actor_id))?.role ?? '';
  if (p.task_id) {
    const t = await row('SELECT key, title, type, role, outcome FROM tasks WHERE id = ?', p.task_id);
    if (t) Object.assign(f, { 'task.key': t.key ?? '', 'task.title': t.title, 'task.type': t.type, 'task.role': t.role ?? '', 'task.outcome': t.outcome ?? '' });
  }
  if (p.version_id) {
    const d = await row('SELECT d.title, d.doc_type, v.version, v.filename FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = ?', p.version_id);
    if (d) Object.assign(f, { 'document.title': d.title, 'document.type': d.doc_type ?? '', 'document.version': d.version, 'document.filename': d.filename });
  }
  if (p.claim_id) {
    const claims = await loadFinance(rq, [c.id]);
    const cl = claims.find(x => x.id === p.claim_id);
    if (cl) {
      Object.assign(f, { 'claim.title': cl.title, 'claim.direction': cl.direction, 'claim.amount': cl.amount_cents, 'claim.recognized': cl.recognized_cents ?? cl.amount_cents,
        'claim.cut': cl.cut_cents, 'claim.settled': cl.settled_cents, 'claim.open': Math.max(cl.open_cents, 0) });
    }
    const open = dir => sum(claims.filter(x => x.direction === dir), x => Math.max(x.open_cents, 0));
    Object.assign(f, { 'case.payables_open': open('payable'), 'case.receivables_open': open('receivable') });
  }
  if (e.type === 'comment') f['comment.text'] = p.body;
  if (e.type.startsWith('subcase.')) Object.assign(f, { 'subcase.title': p.title, 'subcase.template': p.template ?? '' });
  return f;
}

async function ruleStmts(rq, c, def, rule, f) {
  const { row, rows, sql, event, time } = rq;
  const fill = text => String(text ?? '')
    .replace(/\{date(?:\+(\d+))?\}/g, (_, n) => deDate(addDays(rq.today, Number(n ?? 0))))
    .replace(/\{([\w.]+)\}/g, (_, k) => (MONEY_FACTS.includes(k) ? eur(f[k] ?? 0) : String(f[k] ?? '')));
  const ownerRole = def.roles.find(r => r.access === 'case_owner').key;
  const by = { rule: rule.name };
  const stmts = [];
  for (const a of rule.actions) {
    if (a.type === 'create_task') {
      const t = { id: uid(), title: fill(a.title), role: !a.assign_to_role || a.assign_to_role === 'owner' ? ownerRole : a.assign_to_role, visible_to: a.visible_to ?? [] };
      stmts.push(
        sql('INSERT INTO tasks (id, case_id, title, description, type, role, visible_to, due_date, position, created_at, key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          t.id, c.id, t.title, a.description ? fill(a.description) : null, a.task_type ?? 'task', t.role, JSON.stringify(t.visible_to),
          a.due_days != null ? addDays(rq.today, a.due_days) : null, 1e6, time, a.key ?? null),
        event(c.id, null, 'task.added', { task: t.title, task_id: t.id, ...by }, taskAudience(t)),
      );
    } else if (a.type === 'complete_tasks') {
      const open = await rows(`SELECT id, title, role, visible_to FROM tasks WHERE case_id = ? AND status = 'open'
        AND (? IS NULL OR key = ?) AND (? IS NULL OR type = ?) AND (? IS NULL OR title = ?)`,
        c.id, a.key ?? null, a.key ?? null, a.task_type ?? null, a.task_type ?? null, a.title ?? null, a.title ?? null);
      for (const t of open) {
        stmts.push(
          sql("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ? AND status = 'open'", time, t.id),
          event(c.id, null, 'task.complete', { task: t.title, task_id: t.id, ...by }, taskAudience(t)),
        );
      }
    } else if (a.type === 'add_comment') {
      stmts.push(event(c.id, null, 'comment', { body: fill(a.text), ...by }, a.visible_to ?? [])); // team only unless the template shares it
    } else if (a.type === 'create_subcase') {
      const tpl = await row(`SELECT t.id, t.workspace_id, t.name, v.version, v.definition FROM templates t JOIN template_versions v ON v.template_id = t.id
        WHERE t.workspace_id = ? AND t.name = ? AND t.archived_at IS NULL ORDER BY v.version DESC LIMIT 1`, c.workspace_id, a.template);
      if (!tpl) throw new Error(`Vorlage „${a.template}“ gibt es in diesem Workspace nicht (oder sie ist archiviert)`);
      const owner = await row("SELECT user_id FROM case_participants WHERE case_id = ? AND access = 'case_owner' AND revoked_at IS NULL ORDER BY created_at LIMIT 1", c.id);
      if (!owner) throw new Error('Der Vorgang hat keine Verantwortlichen');
      const title = fill(a.title).slice(0, 200);
      const sub = instantiate(rq, tpl, { title, ownerId: owner.user_id, actorId: null, parentId: c.id, by });
      stmts.push(...sub.stmts, event(c.id, null, 'subcase.created', { title, case_id: sub.caseId, template: tpl.name, ...by }, []));
    }
  }
  return stmts;
}

// A failed run is tried again after these minutes (by the cron), then it stays an error, shown at the case's rules.
const RETRY_MINUTES = [1, 5, 30];
const ATTEMPTS = RETRY_MINUTES.length + 1;

const loadCases = async (rq, ids) => new Map((await rq.rows('SELECT id, title, workspace_id, definition FROM cases WHERE id IN (SELECT value FROM json_each(?))',
  JSON.stringify([...new Set(ids)]))).map(c => [c.id, { ...c, def: JSON.parse(c.definition) }]));

// One rule on one event. Run record and effects commit together (a batch is one transaction): a crash leaves neither
// behind, and a parallel run of the same rule fails on the primary key without changing anything – also for a retry,
// whose 'retry' record is swapped for the 'done' one in the same batch. A failure is recorded for the next attempt.
async function runRule(rq, c, e, rule, f, attemptsBefore = 0) {
  const { sql, batch, time } = rq;
  try {
    await batch([
      ...(attemptsBefore ? [sql("DELETE FROM automation_runs WHERE event_id = ? AND rule_id = ? AND status = 'retry'", e.id, rule.id)] : []),
      sql("INSERT INTO automation_runs (event_id, rule_id, case_id, status, created_at) VALUES (?, ?, ?, 'done', ?)", e.id, rule.id, c.id, time),
      ...await ruleStmts(rq, c, c.def, rule, f),
    ]);
  } catch (err) {
    if (/UNIQUE constraint/i.test(err.message)) return; // done meanwhile
    await recordFailure(rq, c.id, e.id, rule.id, attemptsBefore + 1, String(err.message).slice(0, 500));
  }
}

async function recordFailure(rq, caseId, eventId, ruleId, attempts, detail) {
  const { sql, time } = rq;
  const last = attempts >= ATTEMPTS;
  console.error('rule failed', ruleId, `attempt ${attempts}${last ? ' (last)' : ''}`, detail);
  await sql(`INSERT INTO automation_runs (event_id, rule_id, case_id, status, detail, attempts, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (event_id, rule_id) DO UPDATE SET status = excluded.status, detail = excluded.detail, attempts = excluded.attempts,
      next_attempt_at = excluded.next_attempt_at WHERE automation_runs.status = 'retry'`,
  eventId, ruleId, caseId, last ? 'error' : 'retry', detail, attempts, last ? null : new Date(Date.now() + RETRY_MINUTES[attempts - 1] * 60e3).toISOString(), time).run();
}

// New events, each looked at once (the cursor); `retries` (the cron): also the failed runs that are due again. The
// cursor is not what guarantees a run – a failed one stays in automation_runs until it succeeds or gives up.
// As many as the invocation has room for (a run: up to five subrequests): the cursor only passes events looked at
// completely, the next request or cron run goes on from there (rules that ran already are skipped).
export async function processRules(rq, { retries = false } = {}) {
  const { row, rows, sql, room } = rq;
  const events = await rows(`SELECT e.*, u.name AS actor FROM events e LEFT JOIN users u ON u.id = e.actor_id
    WHERE e.id > (SELECT last_event_id FROM rule_cursor WHERE id = 1) ORDER BY e.id LIMIT 200`);
  if (events.length) {
    const cases = await loadCases(rq, events.map(e => e.case_id));
    let seen = null;
    events: for (const e of events) {
      const c = cases.get(e.case_id);
      const p = JSON.parse(e.payload);
      const rules = (c?.def.rules ?? []).filter(r => r.trigger === e.type && r.enabled !== false);
      if (rules.length && !p.rule) { // something to do, and not caused by a rule (no chains)
        if (!room(8)) break; // the facts, one run, the cursor
        const f = await ruleFacts(rq, c, e, p);
        for (const rule of rules) {
          if (!rule.conditions.every(cond => RULE_OPS[cond.operator](f[cond.field], cond.value))) continue;
          if (!room(6)) break events;
          if (await row('SELECT 1 FROM automation_runs WHERE event_id = ? AND rule_id = ?', e.id, rule.id)) continue; // ran already
          await runRule(rq, c, e, rule, f);
        }
      }
      seen = e.id;
    }
    if (seen != null) await sql('UPDATE rule_cursor SET last_event_id = MAX(last_event_id, ?) WHERE id = 1', seen).run();
  }
  if (retries) await retryRules(rq);
}

// Failed runs that are due: the same rule on the same event (its conditions held then), with the facts of now.
async function retryRules(rq) {
  const { rows, room, time } = rq;
  const due = await rows(`SELECT r.rule_id, r.attempts, e.*, u.name AS actor FROM automation_runs r JOIN events e ON e.id = r.event_id
    LEFT JOIN users u ON u.id = e.actor_id WHERE r.status = 'retry' AND r.next_attempt_at <= ? ORDER BY r.next_attempt_at LIMIT 20`, time);
  if (!due.length) return;
  const cases = await loadCases(rq, due.map(d => d.case_id));
  for (const { rule_id: ruleId, attempts, ...e } of due) {
    if (!room(8)) break; // the rest is due again in the next run
    const c = cases.get(e.case_id), rule = c?.def.rules?.find(r => r.id === ruleId);
    if (!rule || rule.enabled === false) {
      await recordFailure(rq, e.case_id, e.id, ruleId, ATTEMPTS, 'nicht wiederholt: Regel inzwischen ausgeschaltet oder entfernt');
      continue;
    }
    await runRule(rq, c, e, rule, await ruleFacts(rq, c, e, JSON.parse(e.payload)), attempts);
  }
}

export async function toggleRule(rq) {
  const { user, params, body, sql, batch, event } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  if (!ctx.owner) fail(403, 'Nur Vorgangsverantwortliche');
  if (typeof body.enabled !== 'boolean') fail(400, 'enabled muss true oder false sein');
  const rule = (ctx.def.rules ?? []).find(r => r.id === params.ruleId) ?? fail(404, 'Regel nicht gefunden');
  rule.enabled = body.enabled;
  await batch([
    sql('UPDATE cases SET definition = ? WHERE id = ?', JSON.stringify(ctx.def), ctx.c.id),
    event(ctx.c.id, user.id, 'rule.toggled', { rule: rule.name, enabled: body.enabled }, []),
  ]);
}
