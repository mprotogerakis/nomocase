// Unit check for bulk mails to the provider (sendBulk, processOutbox in src/notify.js), with a stand-in for fetch and D1
// on node:sqlite with the real schema (so its SQL runs too): one request for many mails, permissive validation (a refused
// address fails only its own mail), each mail sent once – also when an answer gets lost or a run stops on the way –, the
// daily cap (also for two runs at once), chunks of 100. Locally there is no provider, so the end-to-end tests never take
// this path.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { context } from '../src/core.js';
import { processOutbox, sendBulk } from '../src/notify.js';

const sqlite = new DatabaseSync(':memory:');
const dir = new URL('../migrations/', import.meta.url);
for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(f, dir), 'utf8'));
const statement = (text, args) => ({
  text, args,
  first: async () => sqlite.prepare(text).get(...args) ?? null, all: async () => ({ results: sqlite.prepare(text).all(...args) }),
  run: async () => sqlite.prepare(text).run(...args), raw: async () => sqlite.prepare(text).all(...args).map(Object.values),
});
let d1Fails = null; // a statement text: the batch containing it fails (D1 gone at that moment)
const DB = { prepare: text => ({ bind: (...args) => statement(text, args) }), batch: async stmts => {
  if (d1Fails && stmts.some(st => st.text.startsWith(d1Fails))) throw new Error('D1 unavailable (test)');
  return stmts.map(st => ({ results: sqlite.prepare(st.text).all(...st.args) })); // like D1: not through the statements' own calls
} };

let requests = [], answer;
globalThis.fetch = async (url, init) => { requests.push({ url, init, key: new Headers(init.headers).get('idempotency-key'), mails: JSON.parse(init.body) }); return answer(JSON.parse(init.body)); };
const rq = (env = {}) => context({ DB, RESEND_API_KEY: 'test', MAIL_FROM: 'NomoCase <noreply@example.org>', ORIGIN: 'https://example.org', ...env });
const mails = (...to) => to.map(t => ({ to: t, subject: 'Betreff', paragraphs: ['Hallo', 'Text'] }));
// progress mails with their real mark and undo: the person's progress cursor
for (const email of ['a@example.org', 'b@example.org', 'c@example.org', 'kaputt']) {
  sqlite.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)').run(email, email, email, '2026-01-01T00:00:00.000Z');
}
const progress = (ctx, ...to) => mails(...to).map(m => ({ ...m, mark: [ctx.sql('UPDATE users SET progress_cursor = ?, progress_mail_at = ? WHERE id = ?', ctx.time, ctx.time, m.to)],
  undo: { kind: 'progress', user: m.to, at: ctx.time, cursor: null, mailAt: null } }));
const marked = () => sqlite.prepare('SELECT id FROM users WHERE progress_mail_at IS NOT NULL ORDER BY id').all().map(r => r.id);
const pending = () => sqlite.prepare('SELECT attempts FROM bulk_outbox').all().map(r => r.attempts);
const due = () => sqlite.exec("UPDATE bulk_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
// a fresh day with `sent` bulk mails gone out already; logged(): the attempts since
const day = (sent = 0) => {
  requests = [];
  sqlite.exec('DELETE FROM mail_log; DELETE FROM bulk_outbox; UPDATE users SET progress_cursor = NULL, progress_mail_at = NULL');
  for (let i = 0; i < sent; i++) sqlite.prepare('INSERT INTO mail_log (bulk, sent_at, ok) VALUES (1, ?, 1)').run(new Date().toISOString());
  const from = sqlite.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM mail_log').get().id;
  return () => sqlite.prepare('SELECT ok, status, error FROM mail_log WHERE id > ? ORDER BY id').all(from).map(r => ({ ...r }));
};
const accept = batch => Response.json({ data: batch.map((m, i) => ({ id: String(i) })) });
const silence = () => { throw new Error('The operation was aborted due to timeout'); };

// one request, permissive: the refused address fails alone, and only its mark is taken back
let logged = day();
answer = () => Response.json({ data: [{ id: 'a' }, { id: 'c' }], errors: [{ index: 1, message: 'Invalid `to` field.' }] });
let ctx = rq();
assert.deepEqual(await sendBulk(ctx, progress(ctx, 'a@example.org', 'kaputt', 'c@example.org')), [true, false, true]);
assert.deepEqual(marked(), ['a@example.org', 'c@example.org'], 'the refused one is due again with the next run');
assert.equal(requests.length, 1);
assert.equal(requests[0].url, 'https://api.resend.com/emails/batch');
assert.equal(new Headers(requests[0].init.headers).get('x-batch-validation'), 'permissive');
assert.ok(requests[0].key, 'sent with an Idempotency-Key');
assert.deepEqual(requests[0].mails.map(m => m.to), [['a@example.org'], ['kaputt'], ['c@example.org']]);
assert.deepEqual(requests[0].mails[0], { from: 'NomoCase <noreply@example.org>', to: ['a@example.org'], subject: 'Betreff', text: 'Hallo\n\nText' });
assert.deepEqual(logged().map(r => [r.ok, r.status]), [[1, 200], [0, 200], [1, 200]], 'every attempt logged with its answer');
assert.match(logged()[1].error, /Invalid/);
assert.deepEqual(pending(), [], 'answered: nothing left to send');

// the provider refuses the whole request: nothing counts as sent, the next run tries again
logged = day();
answer = () => new Response('{"message":"invalid from"}', { status: 422 });
ctx = rq();
assert.deepEqual(await sendBulk(ctx, progress(ctx, 'a@example.org', 'b@example.org')), [false, false]);
assert.deepEqual(logged().map(r => [r.ok, r.status]), [[0, 422], [0, 422]]);
assert.deepEqual([marked(), pending()], [[], []]);

// no answer to go by (here 429; also 5xx, timeouts, a lost connection): the cron sends the same request with the same
// key again – the provider answers it from its key store instead of sending twice
logged = day();
answer = () => new Response('{"message":"rate limited"}', { status: 429 });
ctx = rq();
assert.deepEqual(await sendBulk(ctx, progress(ctx, 'a@example.org', 'b@example.org')), [null, null], 'not settled yet');
assert.deepEqual([marked(), pending()], [['a@example.org', 'b@example.org'], [1]], 'still counted as sent, the request kept');
answer = accept;
await processOutbox(rq());
assert.equal(requests.length, 1, 'not before it is due');
due();
await processOutbox(rq());
assert.deepEqual([requests[1].key, requests[1].mails], [requests[0].key, requests[0].mails], 'the same request, the same key');
assert.deepEqual(logged().map(r => [r.ok, r.status]), [[1, 200], [1, 200]]);
assert.deepEqual([marked(), pending()], [['a@example.org', 'b@example.org'], []]);

// the run stops on the way (here: while sending): before anything goes out, all a later attempt needs is stored
day();
let stored;
answer = () => { stored = { pending: pending(), marked: marked() }; throw new Error('worker stopped (test)'); };
ctx = rq();
await sendBulk(ctx, progress(ctx, 'a@example.org'));
assert.deepEqual(stored, { pending: [0], marked: ['a@example.org'] }, 'request and marks stored before sending: nothing is lost');
answer = accept;
due();
await processOutbox(rq());
assert.deepEqual([requests[1].key, pending()], [requests[0].key, []], 'the cron sent it, with its key');

// the answer came, but recording it failed: the request stays, and the cron's attempt with the same key sends nothing twice
day();
answer = accept;
ctx = rq();
d1Fails = 'UPDATE mail_log';
await assert.rejects(sendBulk(ctx, progress(ctx, 'a@example.org', 'b@example.org')), /D1 unavailable/);
d1Fails = null;
assert.deepEqual([marked(), pending()], [['a@example.org', 'b@example.org'], [0]]);
due();
await processOutbox(rq());
assert.deepEqual([requests[1].key, pending()], [requests[0].key, []]);

// no answer, ever: after 1, 5, 15, 60 minutes every 240, always with the same key, as long as the key holds (24 hours);
// only then it counts as not sent
logged = day();
answer = silence;
ctx = rq();
await sendBulk(ctx, progress(ctx, 'a@example.org'));
for (let i = 0; i < 5; i++) { due(); await processOutbox(rq()); }
const waitMinutes = () => (Date.parse(sqlite.prepare('SELECT next_attempt_at AS at FROM bulk_outbox').get().at) - Date.now()) / 60e3;
assert.deepEqual(pending(), [6], 'still trying');
assert.ok(Math.abs(waitMinutes() - 240) < 1, 'by now every 240 minutes');
const firstTried = hours => sqlite.exec(`UPDATE bulk_outbox SET created_at = '${new Date(Date.now() - hours * 36e5).toISOString()}'`);
firstTried(18);
due();
await processOutbox(rq());
assert.deepEqual([pending(), marked()], [[7], ['a@example.org']], 'the next attempt (in 4 hours) is still inside the 23 hours: it keeps trying');
firstTried(20);
due();
await processOutbox(rq());
assert.equal(new Set(requests.map(r => r.key)).size, 1, 'every attempt with the same key');
assert.deepEqual([requests.length, pending(), marked()], [8, [], []], 'the key would run out: given up, the mark taken back, the next run tries anew');
assert.deepEqual(logged().map(r => [r.ok, r.error]), [[0, 'keine Antwort des Anbieters']]);

// the daily cap: 79 of 80 gone today, room for one
day(79);
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

// more than 100: chunks of 100, each its own request and key
logged = day();
const many = mails(...Array.from({ length: 150 }, (_, i) => `p${i}@example.org`));
assert.ok((await sendBulk(rq({ MAIL_DAILY_CAP: '500' }), many)).every(Boolean));
assert.deepEqual(requests.map(r => r.mails.length), [100, 50]);
assert.notEqual(requests[0].key, requests[1].key);
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
