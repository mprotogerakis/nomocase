// Unit check for accepting and declining invitations (src/people.js) against D1 on node:sqlite (test/d1.mjs: a batch is
// one transaction): an invitation withdrawn, revoked or accepted between being read and being acted on gives no access
// and no decline – the races the end-to-end tests cannot time –; a failed acceptance changes nothing, so the link is not
// used up; a link works once.
import assert from 'node:assert/strict';
import { context, sha256 } from '../src/core.js';
import { acceptInvitation, declineInvitation } from '../src/people.js';
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
const request = token => ({ ...context({ DB, ORIGIN: 'https://example.org' }), user: null,
  body: { token, consent: true, name: 'Neu' }, url: new URL('https://example.org/api/invitations/accept') });
const accept = token => acceptInvitation(request(token));
const decline = token => declineInvitation(request(token));
const count = (table, where) => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get().n;
const refused = e => e.status === 404;

// withdrawn by the owner right after it was read: no access, and no account made for it
await invite('t1', 'eins@example.org');
afterRead(/FROM invitations i JOIN cases/, () => sqlite.exec("DELETE FROM invitations WHERE email = 'eins@example.org'"));
await assert.rejects(accept('t1'), refused);
assert.equal(count('case_participants', "case_id = 'c'"), 0, 'no access from a withdrawn invitation');
assert.equal(count('users', "email = 'eins@example.org'"), 0, 'nor an account');

// accepted by someone else meanwhile (the same link twice at once): the second gets nothing, cleanly
await invite('t1b', 'einsb@example.org');
afterRead(/FROM invitations i JOIN cases/, () => sqlite.exec(`UPDATE invitations SET accepted_at = '${now}' WHERE email = 'einsb@example.org'`));
await assert.rejects(accept('t1b'), refused);
assert.equal(count('users', "email = 'einsb@example.org'"), 0);

// a workspace invitation revoked right after it was read: the same
await inviteToWorkspace('t2', 'zwei@example.org');
afterRead(/FROM workspace_invitations i/, () => sqlite.exec(`UPDATE workspace_invitations SET revoked_at = '${now}'`));
await assert.rejects(accept('t2'), refused);
assert.equal(count('workspace_members', "workspace_id = 'ws'"), 0, 'no membership from a revoked invitation');
assert.equal(count('users', "email = 'zwei@example.org'"), 0);

// the rest of the acceptance fails: nothing of it stays – the invitation still open, no account – and the link works
await invite('t3', 'drei@example.org');
failOn('INSERT INTO case_participants');
await assert.rejects(accept('t3'), /D1 unavailable/);
failOn(null);
assert.equal(count('invitations', "email = 'drei@example.org' AND accepted_at IS NULL"), 1, 'not used up');
assert.equal(count('users', "email = 'drei@example.org'"), 0, 'no account left behind');
assert.equal((await accept('t3')).status, 200);
assert.equal(count('case_participants', "case_id = 'c' AND access = 'guest_contributor'"), 1, 'joined, with the access of the invitation');
assert.equal(count('invitations', "email = 'drei@example.org' AND accepted_at IS NOT NULL"), 1);

// a link works once
await assert.rejects(accept('t3'), refused);

// declining at the same time as accepting: once accepted, a decline neither removes the invitation nor logs a decline
await invite('t4', 'vier@example.org');
afterRead(/^SELECT \* FROM invitations WHERE token_hash/, () => sqlite.exec(`UPDATE invitations SET accepted_at = '${now}' WHERE email = 'vier@example.org'`));
await assert.rejects(decline('t4'), refused);
assert.equal(count('invitations', "email = 'vier@example.org'"), 1, 'the accepted invitation stays');
assert.equal(count('events', "type = 'participant.declined'"), 0, 'no decline logged for someone who joined');
await invite('t5', 'fuenf@example.org');
await decline('t5');
assert.deepEqual([count('invitations', "email = 'fuenf@example.org'"), count('events', "type = 'participant.declined'")], [0, 1], 'an open one is declined');

// a workspace invitation accepted meanwhile cannot be declined any more
await inviteToWorkspace('t6', 'sechs@example.org');
afterRead(/FROM workspace_invitations i/, () => sqlite.exec(`UPDATE workspace_invitations SET accepted_at = '${now}' WHERE email = 'sechs@example.org'`));
await assert.rejects(decline('t6'), refused);
assert.equal(count('workspace_invitations', "email = 'sechs@example.org' AND revoked_at IS NULL"), 1);
console.log('ok – invite test passed');
