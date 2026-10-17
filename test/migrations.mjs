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
applyUpTo('9999');
const state = Object.fromEntries(all('SELECT id, name, archived_at FROM templates').map(t => [t.id, `${t.name}${t.archived_at ? ' (archiviert)' : ''}`]));
assert.deepEqual(state, { a0: 'Antrag (3)', a1: 'Antrag (archiviert)', a2: 'Antrag (archiviert)', a3: 'Antrag', b1: 'Bericht (archiviert)', b2: 'Bericht', c1: 'Antrag' },
  'nothing renamed; of one name the template a rule picked stays active, the others are archived');
const picked = db.prepare(`SELECT t.id FROM templates t JOIN template_versions v ON v.template_id = t.id
  WHERE t.workspace_id = 'w1' AND t.name = 'Antrag' AND t.archived_at IS NULL ORDER BY v.version DESC LIMIT 1`).get();
assert.equal(picked.id, 'a3', 'the rule query (rules.js) finds the template it found before');
assert.throws(() => template('a4', 'w1', 'Antrag', 1), /UNIQUE/, 'from now on one active template per name');

console.log(`ok – migrations test passed (${files.length} migrations)`);
