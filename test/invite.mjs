// Unit check for accepting invitations (src/people.js) against D1 on node:sqlite: an invitation withdrawn or revoked
// between being read and being taken gives no access – the race the end-to-end tests cannot time –, a failed
// acceptance does not use the link up, and a link works once.
import assert from 'node:assert/strict';
import { context, sha256 } from '../src/core.js';
import { acceptInvitation } from '../src/people.js';
import { d1 } from './d1.mjs';

const { sqlite, DB, failOn, afterRead } = d1();
const now = new Date().toISOString(), tomorrow = new Date(Date.now() + 864e5).toISOString();
sqlite.exec(`INSERT INTO users (id, email, name, created_at) VALUES ('owner', 'owner@example.org', 'Owner', '${now}');
  INSERT INTO workspaces (id, name) VALUES ('ws', 'WS');
  INSERT INTO cases (id, workspace_id, title, definition, created_at) VALUES ('c', 'ws', 'Fall',
    '${JSON.stringify({ roles: [{ key: 'guest', label: 'Gast', access: 'guest_contributor' }] })}', '${now}');`);
const invite = async (token, email) => sqlite.prepare(`INSERT INTO invitations (token_hash, case_id, email, role, access, expires_at, created_by, created_at)
  VALUES (?, 'c', ?, 'guest', 'guest_contributor', ?, 'owner', ?)`).run(await sha256(token), email, tomorrow, now);
const inviteToWorkspace = async (token, email) => sqlite.prepare(`INSERT INTO workspace_invitations (token_hash, workspace_id, email, role, expires_at, created_by, created_at)
  VALUES (?, 'ws', ?, 'member', ?, 'owner', ?)`).run(await sha256(token), email, tomorrow, now);
const accept = token => acceptInvitation({ ...context({ DB, ORIGIN: 'https://example.org' }), user: null,
  body: { token, consent: true, name: 'Neu' }, url: new URL('https://example.org/api/invitations/accept') });
const count = (table, where) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
const refused = e => e.status === 404;

// withdrawn by the owner right after it was read: no access, and no account made for it
await invite('t1', 'eins@example.org');
afterRead(/FROM invitations i JOIN cases/, () => sqlite.exec('DELETE FROM invitations'));
await assert.rejects(accept('t1'), refused);
assert.equal(count('case_participants', "case_id = 'c'"), 0, 'no access from a withdrawn invitation');
assert.equal(count('users', "email = 'eins@example.org'"), 0, 'nor an account');

// a workspace invitation revoked right after it was read: the same
await inviteToWorkspace('t2', 'zwei@example.org');
afterRead(/FROM workspace_invitations i/, () => sqlite.exec(`UPDATE workspace_invitations SET revoked_at = '${now}'`));
await assert.rejects(accept('t2'), refused);
assert.equal(count('workspace_members', "workspace_id = 'ws'"), 0, 'no membership from a revoked invitation');

// the rest of the acceptance fails: the invitation is given back, the link still works
await invite('t3', 'drei@example.org');
failOn('INSERT INTO case_participants');
await assert.rejects(accept('t3'), /D1 unavailable/);
failOn(null);
assert.equal(count('invitations', "email = 'drei@example.org' AND accepted_at IS NULL"), 1, 'not used up');
const res = await accept('t3');
assert.equal(res.status, 200);
assert.equal(count('case_participants', "case_id = 'c' AND access = 'guest_contributor'"), 1, 'joined with the access of the invitation as taken');

// a link works once
await assert.rejects(accept('t3'), refused);
console.log('ok – invite test passed');
