// Unit check for migrations/: all apply in order on an empty SQLite (D1 is SQLite), and the ones that rework existing
// rows handle data from before them as intended. node:sqlite, no server needed.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const dir = new URL('../migrations/', import.meta.url);
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false }); // rows without their parents are enough here
const applyUpTo = (() => { let i = 0; return before => { for (; i < files.length && files[i] < before; i++) db.exec(readFileSync(new URL(files[i], dir), 'utf8')); }; })();
const all = (sql, ...args) => db.prepare(sql).all(...args).map(r => ({ ...r }));

// Before 0037: claims were found by title. Which one a step made cannot be told from the data – not even when there is
// only one (it may have been added by hand while the step was still open) – so none is assigned to a step.
applyUpTo('0037');
const task = (id, caseId, money, status = 'open') => db.prepare(`INSERT INTO tasks (id, case_id, title, type, depends_on, position, created_at, money, status)
  VALUES (?, ?, ?, 'task', '[]', 0, '2026-01-01', ?, ?)`).run(id, caseId, id, money ? JSON.stringify(money) : null, status);
const claim = (id, caseId, title, at) => db.prepare(`INSERT INTO financial_claims (id, case_id, title, direction, amount_cents, created_by, created_at)
  VALUES (?, ?, ?, 'payable', 100, 'u', ?)`).run(id, caseId, title, at);
task('t1', 'c1', { claim: 'Rechnung', direction: 'payable' }, 'done');
task('t2', 'c2', { claim: 'PKV', direction: 'receivable' }); // not done yet …
claim('k1', 'c1', 'Rechnung', '2026-01-02');
claim('k2', 'c1', 'Rechnung', '2026-01-03'); // by hand, younger
claim('k3', 'c2', 'PKV', '2026-01-02'); // … so this one was added by hand, though it is the only one of its title
applyUpTo('0038');
assert.deepEqual(all('SELECT id, task_id FROM financial_claims ORDER BY id').map(c => c.task_id), [null, null, null],
  'claims from before stay unassigned: no automatic booking on a claim a person made');

// Before 0038: several active templates could share a name; a rule took the one with the highest version.
const template = (id, ws, name, versions, archived = null) => {
  db.prepare('INSERT INTO templates (id, workspace_id, name, archived_at) VALUES (?, ?, ?, ?)').run(id, ws, name, archived);
  for (let v = 1; v <= versions; v++) db.prepare("INSERT INTO template_versions (template_id, version, definition, created_at) VALUES (?, ?, '{}', '2026-01-01')").run(id, v);
};
template('a0', 'w1', 'Antrag (3)', 1); // a name a suffix scheme could have collided with
template('a1', 'w1', 'Antrag', 1);
template('a2', 'w1', 'Antrag', 2); // newer and with the higher version: what rules picked
template('a3', 'w1', 'Antrag', 2); // same version, newest: the tie goes to it
template('b1', 'w1', 'Bericht', 3, '2026-01-01'); // archived …
template('b2', 'w1', 'Bericht', 1); // … and an active one: fine
template('c1', 'w2', 'Antrag', 1); // another workspace: fine

// Before 0039: a step done, reopened and done again made a second claim with its task_id.
const stepClaim = (id, taskId) => db.prepare(`INSERT INTO financial_claims (id, case_id, title, direction, amount_cents, created_by, created_at, task_id)
  VALUES (?, 'c3', 'Rechnung', 'payable', 100, 'u', '2026-01-04', ?)`).run(id, taskId);
stepClaim('k5', 't9');
stepClaim('k6', 't9');
applyUpTo('9999');
assert.deepEqual(all("SELECT id, task_id FROM financial_claims WHERE case_id = 'c3' ORDER BY id"), [{ id: 'k5', task_id: 't9' }, { id: 'k6', task_id: null }],
  'the first claim stays the step\'s, the later one becomes a claim of its own');
assert.throws(() => stepClaim('k7', 't9'), /UNIQUE/, 'a step books once from now on');
for (const table of ['financial_decisions', 'financial_transactions']) {
  const book = id => db.prepare(`INSERT INTO ${table} (id, claim_id, ${table === 'financial_decisions' ? 'approved_cents, decided_on' : 'amount_cents, booked_on'}, created_by, created_at, task_id)
    VALUES (?, 'k5', 1, '2026-01-05', 'u', '2026-01-05', 't8')`).run(id);
  book(`${table}-1`);
  assert.throws(() => book(`${table}-2`), /UNIQUE/, `${table}: one per step`);
}
const state = Object.fromEntries(all('SELECT id, name, archived_at FROM templates').map(t => [t.id, `${t.name}${t.archived_at ? ' (archiviert)' : ''}`]));
assert.deepEqual(state, { a0: 'Antrag (3)', a1: 'Antrag (archiviert)', a2: 'Antrag (archiviert)', a3: 'Antrag', b1: 'Bericht (archiviert)', b2: 'Bericht', c1: 'Antrag' },
  'nothing renamed; of one name the template a rule picked stays active, the others are archived');
const picked = db.prepare(`SELECT t.id FROM templates t JOIN template_versions v ON v.template_id = t.id
  WHERE t.workspace_id = 'w1' AND t.name = 'Antrag' AND t.archived_at IS NULL ORDER BY v.version DESC LIMIT 1`).get();
assert.equal(picked.id, 'a3', 'the rule query (rules.js) finds the template it found before');
assert.throws(() => template('a4', 'w1', 'Antrag', 1), /UNIQUE/, 'from now on one active template per name');

// 0040/0041: a version through an upload link is stored only while the link is valid and its case and step are open
// (checked in the same transaction as the version row).
const kase = (id, status) => db.prepare("INSERT INTO cases (id, workspace_id, title, definition, status, created_at) VALUES (?, 'w1', ?, '{}', ?, '2026-01-01')").run(id, id, status);
kase('open-case', 'open');
kase('closed-case', 'open');
task('open-step', 'open-case', null);
task('done-step', 'open-case', null, 'done');
task('step-of-closed', 'closed-case', null);
const link = (hash, revoked, expires, caseId = 'open-case', taskId = 'open-step') => db.prepare(`INSERT INTO upload_links (token_hash, case_id, task_id, label, created_by, created_at, expires_at, revoked_at)
  VALUES (?, ?, ?, 'x', 'u', '2026-01-01', ?, ?)`).run(hash, caseId, taskId, expires, revoked);
const later = '2999-01-01T00:00:00.000Z';
link('valid', null, later);
link('revoked', '2026-01-02', later);
link('expired', null, '2000-01-01T00:00:00.000Z');
link('step-done', null, later, 'open-case', 'done-step');
link('case-closed', null, later, 'closed-case', 'step-of-closed');
link('step-gone', null, later, 'open-case', 'deleted-step');
db.prepare("UPDATE cases SET status = 'closed' WHERE id = 'closed-case'").run(); // closed after its step and link were made (0042)
const version = (id, uploadLink) => db.prepare(`INSERT INTO document_versions (id, document_id, version, filename, content_type, size, r2_key, uploaded_by, created_at, upload_link)
  VALUES (?, 'd1', ?, 'a.pdf', 'application/pdf', 1, ?, 'u', '2026-01-01', ?)`).run(id, Number(id.slice(1)), id, uploadLink);
version('v1', 'valid');
version('v2', null); // not through a link: not affected
for (const [n, hash] of ['revoked', 'expired', 'step-done', 'case-closed', 'step-gone'].entries()) {
  assert.throws(() => version(`v${n + 3}`, hash), /upload link no longer valid/, hash);
}

// 0042: a closed case is read-only – steps, comments, fields; other events (reopening) and deleting it still work.
kase('shut', 'open');
task('t-shut', 'shut', null);
const setStatus = status => db.prepare("UPDATE cases SET status = ? WHERE id = 'shut'").run(status);
const event = type => db.prepare("INSERT INTO events (case_id, type, created_at) VALUES ('shut', ?, '2026-01-02')").run(type);
setStatus('closed');
assert.throws(() => task('t-new', 'shut', null), /case closed/, 'no new step');
assert.throws(() => db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't-shut'").run(), /case closed/, 'no step done');
assert.throws(() => event('comment'), /case closed/, 'no comment');
assert.throws(() => db.prepare("UPDATE cases SET fields = '{\"a\":1}' WHERE id = 'shut'").run(), /case closed/, 'no field changed');
assert.throws(() => db.prepare("DELETE FROM tasks WHERE id = 't-shut'").run(), /case closed/, 'no step removed');
event('case.reopened');
setStatus('open');
db.prepare("UPDATE tasks SET status = 'done' WHERE id = 't-shut'").run(); // open again: changes work
setStatus('closed');
db.prepare("INSERT INTO case_deletions (case_id, workspace_id, reason, deleted_at) VALUES ('shut', 'w1', 'manual', '2026-01-03')").run();
db.prepare("DELETE FROM tasks WHERE case_id = 'shut'").run(); // deleting the case: the tombstone lets it through

console.log(`ok – migrations test passed (${files.length} migrations)`);
