// Passkey flow in headless Chrome with a virtual authenticator. Needs a running `npm run dev` and Chrome.
// Login link → register passkey → log out → log in with passkey; plus: invites can't open passkey-protected accounts.
// Against production: BASE=https://… EMAIL=<owner> node test/passkey.mjs (cleans up its passkey afterwards).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { openBrowser } from './browser.mjs';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const EMAIL = process.env.EMAIL ?? 'prof@example.org';
const REMOTE = BASE.startsWith('https:');
const api = (path, { cookie = '', body, method } = {}) => fetch(`${BASE}/api${path}`, {
  method: method ?? (body ? 'POST' : 'GET'),
  headers: { cookie, origin: BASE, ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body && JSON.stringify(body),
});

const link = execFileSync('node', ['scripts/login-link.mjs', EMAIL, '--base', BASE, ...(REMOTE ? ['--remote'] : [])], { encoding: 'utf8' }).trim();
const linkToken = link.split('/#/login/')[1];

const browser = await openBrowser();
const { cdp, evaluate, waitFor, click, dialogs } = browser;
let cleanup = async () => {}; // removes the test passkey even if an assertion fails midway
try {
  const me = () => evaluate("fetch('/api/me').then(r => r.json())");

  await cdp('WebAuthn.enable');
  await cdp('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });

  // 1. The login link signs in once.
  await cdp('Page.navigate', { url: link });
  await waitFor(`!!document.querySelector('[data-on="useLoginLink"]')`, 'Anmeldeseite');
  assert.equal((await me()).user, null, 'opening the link alone does not log in (mail scanners open links)');
  await click('[data-on="useLoginLink"]');
  await waitFor(`fetch('/api/me').then(r => r.json()).then(m => m.user?.email === '${EMAIL}')`, 'Anmeldung per Link');
  await cdp('Page.navigate', { url: `${BASE}/#/account` });
  await waitFor(`document.querySelector('main h1')?.textContent === 'Konto'`, 'Kontoseite');
  assert.equal((await api('/login-link', { body: { token: linkToken } })).status, 404, 'login link is single use');

  // 2. Register a passkey.
  const passkeyIds = () => evaluate("fetch('/api/passkeys').then(r => r.json()).then(list => list.map(p => p.id))");
  const before = await passkeyIds();
  await click('main [data-on="passkeyAdd"]');
  await waitFor(`fetch('/api/me').then(r => r.json()).then(m => m.passkeys === ${before.length + 1})`, 'Passkey registriert');
  const testPasskey = (await passkeyIds()).find(id => !before.includes(id));
  cleanup = () => evaluate(`fetch('/api/passkeys/${encodeURIComponent(testPasskey)}', { method: 'DELETE' }).then(r => r.status)`);

  // 3. Log out, log back in with the passkey.
  await click('[data-on="logout"]');
  await waitFor(`!!document.querySelector('[data-on="passkeyLogin"]')`, 'Login-Seite');
  assert.equal((await me()).user, null);
  await click('[data-on="passkeyLogin"]');
  await waitFor(`fetch('/api/me').then(r => r.json()).then(m => m.user?.email === '${EMAIL}')`, 'Login per Passkey');
  assert.deepEqual(dialogs, []);

  // 4. Production has no dev login. Locally: an invite to an email whose account has a passkey must not log anyone in.
  const login = await api('/dev-login', { body: { email: EMAIL } });
  if (REMOTE) assert.equal(login.status, 404, 'dev login must be off in production');
  else await inviteCannotTakeOver(login);

  // The virtual authenticator dies with this browser, so its passkey goes too; then end the session.
  assert.equal(await cleanup(), 200);
  cleanup = async () => {};
  await evaluate("fetch('/api/logout', { method: 'POST' }).then(r => r.status)");
  console.log(`ok – passkey test passed (${BASE})`);
} finally {
  await cleanup().catch(() => {});
  await browser.close();
}

async function inviteCannotTakeOver(login) {
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const [tpl] = await (await api('/templates', { cookie })).json();
  const { id: caseId } = await (await api('/cases', { cookie, body: { template_id: tpl.id, title: 'Passkey-Test' } })).json();
  try {
    const { link: invite } = await (await api(`/cases/${caseId}/invitations`, { cookie, body: { email: EMAIL, role: tpl.definition.roles.at(-1).key } })).json();
    const token = invite.split('/invite/')[1];
    assert.equal((await (await api(`/invitations/${token}`)).json()).needs_login, true);
    const hijack = await api('/invitations/accept', { body: { token, name: 'Mallory' } });
    assert.equal(hijack.status, 401);
    assert.equal(hijack.headers.get('set-cookie'), null);
    assert.equal((await api('/invitations/accept', { cookie, body: { token } })).status, 200, 'the account owner can still accept');
  } finally {
    // also drops the invitation, so the daily invite cap per address never trips on reruns
    await api(`/cases/${caseId}`, { cookie, method: 'DELETE' });
  }
}
