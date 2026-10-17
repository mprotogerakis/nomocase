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

// Before 0037: claims were found by title. Case c1 has a step's claim and a younger one added by hand with the same
// title (ambiguous); case c2 has one claim per title, one of them made by a step.
applyUpTo('0037');
const task = (id, caseId, money) => db.prepare(`INSERT INTO tasks (id, case_id, title, type, depends_on, position, created_at, money)
  VALUES (?, ?, ?, 'task', '[]', 0, '2026-01-01', ?)`).run(id, caseId, id, money ? JSON.stringify(money) : null);
const claim = (id, caseId, title, at) => db.prepare(`INSERT INTO financial_claims (id, case_id, title, direction, amount_cents, created_by, created_at)
  VALUES (?, ?, ?, 'payable', 100, 'u', ?)`).run(id, caseId, title, at);
task('t1', 'c1', { claim: 'Rechnung', direction: 'payable' });
task('t2', 'c2', { claim: 'PKV', direction: 'receivable' });
claim('k1', 'c1', 'Rechnung', '2026-01-02');
claim('k2', 'c1', 'Rechnung', '2026-01-03'); // by hand, younger
claim('k3', 'c2', 'PKV', '2026-01-02');
claim('k4', 'c2', 'Sonstiges', '2026-01-02'); // by hand, no step
applyUpTo('0038');
assert.deepEqual(all('SELECT id, task_id FROM financial_claims ORDER BY id'),
  [{ id: 'k1', task_id: null }, { id: 'k2', task_id: null }, { id: 'k3', task_id: 't2' }, { id: 'k4', task_id: null }],
  'only unambiguous claims get their step; two of one title stay unassigned (no booking on the wrong one)');

// Before 0038: several active templates could share a name in a workspace.
const template = (id, ws, name, archived = null) => db.prepare('INSERT INTO templates (id, workspace_id, name, archived_at) VALUES (?, ?, ?, ?)').run(id, ws, name, archived);
template('a1', 'w1', 'Antrag');
template('a2', 'w1', 'Antrag'); // a second active one
template('b1', 'w1', 'Bericht', '2026-01-01'); // archived …
template('b2', 'w1', 'Bericht'); // … and an active one: fine
template('a3', 'w2', 'Antrag'); // another workspace: fine
applyUpTo('9999');
const names = Object.fromEntries(all('SELECT id, name FROM templates').map(t => [t.id, t.name]));
assert.equal(names.a1, 'Antrag', 'the oldest keeps its name');
assert.match(names.a2, /^Antrag \(\d+\)$/, 'the later one gets a suffix');
assert.deepEqual([names.b1, names.b2, names.a3], ['Bericht', 'Bericht', 'Antrag']);
assert.throws(() => template('a4', 'w1', 'Antrag'), /UNIQUE/, 'from now on one active template per name');

console.log(`ok – migrations test passed (${files.length} migrations)`);
