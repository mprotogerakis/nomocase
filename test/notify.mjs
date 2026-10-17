// Unit check for bulk mails to the provider (sendBulk in src/notify.js), with stand-ins for D1 and fetch: one request
// for many mails, permissive validation (a refused address fails only its own mail), the daily cap, chunks of 100.
// Locally there is no provider, so the end-to-end tests never take this path.
import assert from 'node:assert/strict';
import { context } from '../src/core.js';
import { sendBulk } from '../src/notify.js';

let sentToday = 0, logged = [], requests = [], answer;
const statement = (text, args) => ({ text, args, first: async () => ({ n: sentToday }), all: async () => ({ results: [] }), run: async () => ({}), raw: async () => [] });
const DB = { prepare: text => ({ bind: (...args) => statement(text, args) }), batch: async stmts => { logged.push(...stmts.map(s => s.args)); return []; } };
globalThis.fetch = async (url, init) => { requests.push({ url, init, mails: JSON.parse(init.body) }); return answer(JSON.parse(init.body)); };
const rq = (env = {}) => context({ DB, RESEND_API_KEY: 'test', MAIL_FROM: 'NomoCase <noreply@example.org>', ORIGIN: 'https://example.org', ...env });
const mails = (...to) => to.map(t => ({ to: t, subject: 'Betreff', paragraphs: ['Hallo', 'Text'] }));
const reset = () => { logged = []; requests = []; };

// one request, permissive: the refused address fails alone
answer = () => Response.json({ data: [{ id: 'a' }, { id: 'c' }], errors: [{ index: 1, message: 'Invalid `to` field.' }] });
assert.deepEqual(await sendBulk(rq(), mails('a@example.org', 'kaputt', 'c@example.org')), [true, false, true]);
assert.equal(requests.length, 1);
assert.equal(requests[0].url, 'https://api.resend.com/emails/batch');
assert.equal(new Headers(requests[0].init.headers).get('x-batch-validation'), 'permissive');
assert.deepEqual(requests[0].mails.map(m => m.to), [['a@example.org'], ['kaputt'], ['c@example.org']]);
assert.deepEqual(requests[0].mails[0], { from: 'NomoCase <noreply@example.org>', to: ['a@example.org'], subject: 'Betreff', text: 'Hallo\n\nText' });
assert.deepEqual(logged.map(args => args[1]), [1, 0, 1], 'every attempt logged, in one batch');
assert.match(logged[1][3], /Invalid/);

// the provider refuses the request: nothing counts as sent
reset();
answer = () => new Response('{"message":"rate limited"}', { status: 429 });
assert.deepEqual(await sendBulk(rq(), mails('a@example.org', 'b@example.org')), [false, false]);
assert.deepEqual(logged.map(args => [args[1], args[2]]), [[0, 429], [0, 429]]);

// no answer at all (timeout, network): the same
reset();
answer = () => { throw new Error('The operation was aborted due to timeout'); };
assert.deepEqual(await sendBulk(rq(), mails('a@example.org')), [false]);

// the daily cap: 79 of 80 gone today, room for one
reset();
sentToday = 79;
answer = batch => Response.json({ data: batch.map((m, i) => ({ id: String(i) })) });
assert.deepEqual(await sendBulk(rq(), mails('a@example.org', 'b@example.org', 'c@example.org')), [true, false, false]);
assert.equal(requests[0].mails.length, 1, 'only what fits under the cap goes out');
sentToday = 80;
reset();
assert.deepEqual(await sendBulk(rq(), mails('a@example.org')), [false]);
assert.equal(requests.length, 0, 'cap reached: no request at all');

// more than 100: chunks of 100
reset();
sentToday = 0;
const many = mails(...Array.from({ length: 150 }, (_, i) => `p${i}@example.org`));
assert.ok((await sendBulk(rq({ MAIL_DAILY_CAP: '500' }), many)).every(Boolean));
assert.deepEqual(requests.map(r => r.mails.length), [100, 50]);
assert.equal(logged.length, 150);

assert.deepEqual(await sendBulk(rq(), []), [], 'nothing to send: no request, no query');

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
