// Unit check for bulk mails to the provider (sendBulk in src/notify.js), with a stand-in for fetch and D1 on node:sqlite
// with the real schema (so its SQL runs too): one request for many mails, permissive validation (a refused address fails
// only its own mail), the daily cap – also for two runs at once –, chunks of 100. Locally there is no provider, so the
// end-to-end tests never take this path.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { context } from '../src/core.js';
import { sendBulk } from '../src/notify.js';

const sqlite = new DatabaseSync(':memory:');
const dir = new URL('../migrations/', import.meta.url);
for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(f, dir), 'utf8'));
const statement = (text, args) => ({
  text, args,
  first: async () => sqlite.prepare(text).get(...args) ?? null, all: async () => ({ results: sqlite.prepare(text).all(...args) }),
  run: async () => sqlite.prepare(text).run(...args), raw: async () => sqlite.prepare(text).all(...args).map(Object.values),
});
const DB = { prepare: text => ({ bind: (...args) => statement(text, args) }), batch: async stmts => stmts.map(st => ({ results: sqlite.prepare(st.text).all(...st.args) })) }; // like D1: not through the statements' own calls

let requests = [], answer;
globalThis.fetch = async (url, init) => { requests.push({ url, init, mails: JSON.parse(init.body) }); return answer(JSON.parse(init.body)); };
const rq = (env = {}) => context({ DB, RESEND_API_KEY: 'test', MAIL_FROM: 'NomoCase <noreply@example.org>', ORIGIN: 'https://example.org', ...env });
const mails = (...to) => to.map(t => ({ to: t, subject: 'Betreff', paragraphs: ['Hallo', 'Text'] }));
// a fresh day with `sent` bulk mails gone out already; logged(): the attempts since
const day = (sent = 0) => {
  requests = [];
  sqlite.exec('DELETE FROM mail_log');
  for (let i = 0; i < sent; i++) sqlite.prepare('INSERT INTO mail_log (bulk, sent_at, ok) VALUES (1, ?, 1)').run(new Date().toISOString());
  const from = sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM mail_log').get().id;
  return () => sqlite.prepare('SELECT ok, status, error FROM mail_log WHERE id > ? ORDER BY id').all(from).map(r => ({ ...r }));
};
const accept = batch => Response.json({ data: batch.map((m, i) => ({ id: String(i) })) });

// one request, permissive: the refused address fails alone
let logged = day();
answer = () => Response.json({ data: [{ id: 'a' }, { id: 'c' }], errors: [{ index: 1, message: 'Invalid `to` field.' }] });
assert.deepEqual(await sendBulk(rq(), mails('a@example.org', 'kaputt', 'c@example.org')), [true, false, true]);
assert.equal(requests.length, 1);
assert.equal(requests[0].url, 'https://api.resend.com/emails/batch');
assert.equal(new Headers(requests[0].init.headers).get('x-batch-validation'), 'permissive');
assert.deepEqual(requests[0].mails.map(m => m.to), [['a@example.org'], ['kaputt'], ['c@example.org']]);
assert.deepEqual(requests[0].mails[0], { from: 'NomoCase <noreply@example.org>', to: ['a@example.org'], subject: 'Betreff', text: 'Hallo\n\nText' });
assert.deepEqual(logged().map(r => [r.ok, r.status]), [[1, 200], [0, 200], [1, 200]], 'every attempt logged with its answer');
assert.match(logged()[1].error, /Invalid/);

// the provider refuses the request: nothing counts as sent
logged = day();
answer = () => new Response('{"message":"rate limited"}', { status: 429 });
assert.deepEqual(await sendBulk(rq(), mails('a@example.org', 'b@example.org')), [false, false]);
assert.deepEqual(logged().map(r => [r.ok, r.status]), [[0, 429], [0, 429]]);

// no answer at all (timeout, network): the same
logged = day();
answer = () => { throw new Error('The operation was aborted due to timeout'); };
assert.deepEqual(await sendBulk(rq(), mails('a@example.org')), [false]);
assert.deepEqual(logged().map(r => r.ok), [0]);

// the daily cap: 79 of 80 gone today, room for one
logged = day(79);
answer = accept;
assert.deepEqual(await sendBulk(rq(), mails('a@example.org', 'b@example.org', 'c@example.org')), [true, false, false]);
assert.equal(requests[0].mails.length, 1, 'only what fits under the cap goes out');
day(80);
assert.deepEqual(await sendBulk(rq(), mails('a@example.org')), [false]);
assert.equal(requests.length, 0, 'cap reached: no request at all');

// two runs at once (daily digest and progress mails at 05:00), room for one: only one of them sends
day(79);
const both = await Promise.all([sendBulk(rq(), mails('a@example.org')), sendBulk(rq(), mails('b@example.org'))]);
assert.deepEqual(both.flat().sort(), [false, true], 'the room was taken by one run, not used twice');
assert.equal(requests.length, 1);
assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mail_log WHERE ok = 1').get().n, 80, 'the cap holds');

// more than 100: chunks of 100
logged = day();
const many = mails(...Array.from({ length: 150 }, (_, i) => `p${i}@example.org`));
assert.ok((await sendBulk(rq({ MAIL_DAILY_CAP: '500' }), many)).every(Boolean));
assert.deepEqual(requests.map(r => r.mails.length), [100, 50]);
assert.equal(logged().length, 150);

day();
assert.deepEqual(await sendBulk(rq(), []), [], 'nothing to send: no request, no query');
assert.equal(requests.length, 0);

// The subrequest count behind all this (core.js): statements, batches and R2 calls count; room() knows what is left
// (a cron run keeps a reserve for its later steps); locally the 51st fails, as it would in production.
const FILES = { list: async () => ({ objects: [] }) };
const request = new Request('http://localhost:8787/');
const local = context({ DB, FILES, ORIGIN: 'http://localhost:8787' }, request);
await local.row('SELECT 1');
await local.batch([local.sql('SELECT 1'), local.sql('SELECT 2')]);
await local.env.FILES.list();
local.spend(); // a fetch
assert.ok(local.room(46) && !local.room(47), 'four counted: a statement, a batch, an R2 call, a fetch');
for (let i = 0; i < 46; i++) await local.row('SELECT 1');
assert.throws(() => local.row('SELECT 1'), /Too many subrequests/);
const cron = context({ DB, ORIGIN: 'http://localhost:8787' });
assert.ok(cron.room(38) && !cron.room(39), 'a cron run keeps 12 for its later steps');
const production = context({ DB, ORIGIN: 'https://example.org' }, request);
for (let i = 0; i < 60; i++) await production.row('SELECT 1'); // there the platform itself refuses
console.log('ok – notify test passed');
