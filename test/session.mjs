// Unit check for the session cookie rule (src/core.js sessionFrom): over https only __Host-sid, header order irrelevant.
import assert from 'node:assert/strict';
import { context, sessionFrom } from '../src/core.js';
import { addDays, localDay } from '../public/shared/day.js';

assert.equal(sessionFrom('sid=abc0; __Host-sid=def1', true), 'def1', 'a planted sid standing first does not win');
assert.equal(sessionFrom('__Host-sid=def1; sid=abc0', true), 'def1');
assert.equal(sessionFrom('sid=abc0', true), undefined, 'over https a plain sid is no session');
assert.equal(sessionFrom('other=1; sid=abc0', false), 'abc0', 'locally over http: sid');
assert.equal(sessionFrom('x__Host-sid=def1', true), undefined, 'the whole cookie name has to match');
assert.equal(sessionFrom(null, true), undefined);
// DEV_LOGIN counts only for a local origin and a request that did not come through Cloudflare (CF-Connecting-IP)
const from = ip => new Request('http://localhost:8787/', ip ? { headers: { 'cf-connecting-ip': ip } } : {});
const dev = (origin, req) => context({ DEV_LOGIN: '1', ORIGIN: origin }, req).env.DEV_LOGIN;
assert.equal(dev('http://localhost:8787', from('::1')), '1', 'wrangler dev: the loopback address');
assert.equal(dev('http://localhost:8787', from(null)), '1');
assert.equal(dev('http://localhost:8787', from('203.0.113.7')), undefined, 'a local ORIGIN deployed by mistake: still off through Cloudflare');
assert.equal(dev('https://nomocase.example.org', from('::1')), undefined, 'a public ORIGIN: off');

// Calendar days in the instance's time zone (server and browser alike): just after midnight in Berlin the UTC date is
// still yesterday's; summer and winter time; adding days across the change of clocks.
assert.equal(localDay(Date.parse('2026-10-19T22:30:00Z')), '2026-10-20', '00:30 summer time in Berlin: already the 20th');
assert.equal(localDay(Date.parse('2026-10-19T21:59:00Z')), '2026-10-19', '23:59 in Berlin: still the 19th');
assert.equal(localDay(Date.parse('2026-12-31T23:30:00Z')), '2027-01-01', '00:30 winter time: the new year');
assert.equal(localDay(Date.parse('2026-10-19T22:30:00Z'), 'UTC'), '2026-10-19', 'another zone, another day');
assert.equal(addDays('2026-10-25', 1), '2026-10-26', 'across the end of summer time');
assert.equal(addDays('2026-03-29', -1), '2026-03-28', 'and its start');
assert.equal(addDays('2026-10-20', 84), '2027-01-12');
const here = context({ ORIGIN: 'https://nomocase.example.org' });
assert.equal(here.today, localDay(Date.parse(here.time)), 'the context: today in Europe/Berlin by default');
assert.equal(context({ TIME_ZONE: 'UTC' }).today, new Date().toISOString().slice(0, 10), 'or the zone configured');
console.log('ok – session test passed');
