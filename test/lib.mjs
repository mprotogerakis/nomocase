// Shared helpers for the end-to-end tests. test/run.mjs gives each suite its own server (BASE) and local state
// (NOMOCASE_STATE); run directly, a suite uses `npm run dev` and .wrangler/state.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

export const BASE = process.env.BASE ?? 'http://localhost:8787';
export const STATE = process.env.NOMOCASE_STATE ?? '.wrangler/state';
export const LOCAL = ['--local', '--persist-to', STATE]; // for wrangler's d1 and r2 commands
export const run = Date.now().toString(36); // unique emails, also when a suite runs twice on the same state
export const PDF = '%PDF-1.4\n% demo\n';

// While sql() blocks the event loop (wrangler CLI), workerd drops idle keep-alive connections; such a request never
// reached the server, so it is safe to send it once more.
// Each request gets an answer within a minute, or the test fails (instead of hanging the whole run).
export const fetchOnce = async (url, options = {}) => {
  const send = () => fetch(url, { signal: AbortSignal.timeout(60e3), ...options });
  try { return await send(); } catch (e) { if (!['ECONNRESET', 'UND_ERR_SOCKET'].includes(e.cause?.code)) throw e; return send(); }
};

// One logged-in browser: keeps its session cookie.
export function client() {
  let cookie = '';
  return async (path, { method, body, form } = {}) => {
    const res = await fetchOnce(`${BASE}/api${path}`, {
      method: method ?? (body || form ? 'POST' : 'GET'),
      headers: { cookie, origin: BASE, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: form ?? (body && JSON.stringify(body)),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, data: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
  };
}

export const expect = async (call, status = 200) => {
  const { status: got, data } = await call;
  assert.equal(got, status, JSON.stringify(data));
  return data;
};

export const file = (name, content, extra = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([content]), name);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
};

export const tokenOf = link => link.split('/invite/')[1];

// Direct look into the local D1 (only for checks the API deliberately doesn't expose).
export const sql = query => JSON.parse(execFileSync('npx', ['wrangler', 'd1', 'execute', 'nomocase', ...LOCAL, '--json', '--command', query], { encoding: 'utf8' }))[0].results;
