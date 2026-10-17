// Unit check for the session cookie rule (src/core.js sessionFrom): over https only __Host-sid, header order irrelevant.
import assert from 'node:assert/strict';
import { sessionFrom } from '../src/core.js';

assert.equal(sessionFrom('sid=abc0; __Host-sid=def1', true), 'def1', 'a planted sid standing first does not win');
assert.equal(sessionFrom('__Host-sid=def1; sid=abc0', true), 'def1');
assert.equal(sessionFrom('sid=abc0', true), undefined, 'over https a plain sid is no session');
assert.equal(sessionFrom('other=1; sid=abc0', false), 'abc0', 'locally over http: sid');
assert.equal(sessionFrom('x__Host-sid=def1', true), undefined, 'the whole cookie name has to match');
assert.equal(sessionFrom(null, true), undefined);
console.log('ok – session test passed');
