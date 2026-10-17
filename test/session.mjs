// Unit check for the session cookie rule (src/core.js sessionFrom): over https only __Host-sid, header order irrelevant.
import assert from 'node:assert/strict';
import { E, init, sessionFrom } from '../src/core.js';

assert.equal(sessionFrom('sid=abc0; __Host-sid=def1', true), 'def1', 'a planted sid standing first does not win');
assert.equal(sessionFrom('__Host-sid=def1; sid=abc0', true), 'def1');
assert.equal(sessionFrom('sid=abc0', true), undefined, 'over https a plain sid is no session');
assert.equal(sessionFrom('other=1; sid=abc0', false), 'abc0', 'locally over http: sid');
assert.equal(sessionFrom('x__Host-sid=def1', true), undefined, 'the whole cookie name has to match');
assert.equal(sessionFrom(null, true), undefined);
// DEV_LOGIN counts only for a local origin and a request that did not come through Cloudflare (CF-Connecting-IP)
const from = ip => new Request('http://localhost:8787/', ip ? { headers: { 'cf-connecting-ip': ip } } : {});
const dev = (origin, req) => (init({ DEV_LOGIN: '1', ORIGIN: origin }, req), E.DEV_LOGIN);
assert.equal(dev('http://localhost:8787', from('::1')), '1', 'wrangler dev: the loopback address');
assert.equal(dev('http://localhost:8787', from(null)), '1');
assert.equal(dev('http://localhost:8787', from('203.0.113.7')), undefined, 'a local ORIGIN deployed by mistake: still off through Cloudflare');
assert.equal(dev('https://nomocase.example.org', from('::1')), undefined, 'a public ORIGIN: off');
console.log('ok – session test passed');
