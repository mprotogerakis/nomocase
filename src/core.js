// Shared basics: errors and JSON responses, D1 helpers, the event log, small value helpers.
export { ACCESS, acceptedExtensions, DECISIONS, FILE_KIND_LABELS, FILE_KINDS, NEEDS_FILE, STAFF, TASK_TYPES, validFiles } from '../public/shared/vocab.js';

// Bindings are constant per isolate; set once per request/cron run by worker.js.
export let DB, E;
// Came the request through Cloudflare's network? There CF-Connecting-IP is the client's real address – never a
// loopback one, which is what wrangler dev puts there (::1) unless the client sends its own.
export const viaCloudflare = req => { const ip = req?.headers.get('cf-connecting-ip'); return !!ip && !/^(::1$|127\.|::ffff:127\.)/.test(ip); };

// DEV_LOGIN (login by e-mail, links in answers, the list of accounts) only counts for a local origin and a request
// that did not come through Cloudflare's network. So a wrongly deployed variable, even together with a local ORIGIN,
// opens nothing. (The request's host does not tell: wrangler dev rewrites it to the production route.)
export const init = (env, req = null) => {
  DB = env.DB;
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.ORIGIN ?? '') && !viaCloudflare(req);
  E = env.DEV_LOGIN && !local ? { ...env, DEV_LOGIN: undefined } : env;
};
// Passkeys work only for the domain they were made on (WebAuthn RP ID): the one of ORIGIN.
export const rpId = () => (E.ORIGIN ? new URL(E.ORIGIN).hostname : null);
export const appVersion = () => E.CF_VERSION_METADATA?.id ?? 'dev';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const fail = (status, message) => { throw new HttpError(status, message); };

// A request body, read with a byte limit – also without (or with a false) Content-Length. json() and formData() alone
// would take a body of any size first.
export async function readBody(req, max, tooBig) {
  if (Number(req.headers.get('content-length')) > max) fail(413, tooBig);
  const reader = req.body?.getReader(), chunks = [];
  if (reader) {
    for (let n = 0, r = await reader.read(); !r.done; r = await reader.read()) {
      if ((n += r.value.length) > max) { await reader.cancel(); fail(413, tooBig); }
      chunks.push(r.value);
    }
  }
  return new Blob(chunks);
}

// API answers carry personal data: never kept in a cache (headers may be an object or a list of pairs).
export const json = (data, status = 200, headers = {}) => {
  const h = new Headers(headers);
  if (!h.has('cache-control')) h.set('cache-control', 'no-store');
  return Response.json(data, { status, headers: h });
};

// The session token from a Cookie header. Over https only "__Host-sid" counts: a plain "sid" could be planted by a
// sibling subdomain for the whole domain (and even stand first in the header). Locally over http only "sid".
export const sessionFrom = (cookie, secure) => cookie?.match(secure ? /(?:^|;\s*)__Host-sid=([0-9a-f]+)/ : /(?:^|;\s*)sid=([0-9a-f]+)/)?.[1];

export const now = () => new Date().toISOString();

export const uid = () => crypto.randomUUID();

export const arr = v => (Array.isArray(v) ? v : JSON.parse(v ?? '[]'));

export const roleList = v => (Array.isArray(v) ? v.map(String) : fail(400, 'visible_to muss eine Liste sein'));

export const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

export const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));

export const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);

export const q = (sql, ...args) => DB.prepare(sql).bind(...args);

export const row = (sql, ...args) => q(sql, ...args).first();

export const rows = async (sql, ...args) => (await q(sql, ...args).all()).results;

// The workspace's own log (owners): members, roles, invitations, look, issuers, templates, moved cases.
export const wsEv = (workspaceId, actorId, type, payload = {}) =>
  q('INSERT INTO workspace_events (workspace_id, actor_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)', workspaceId, actorId, type, JSON.stringify(payload), now());

export const ev = (caseId, actorId, type, payload, visibleTo = []) =>
  q('INSERT INTO events (case_id, actor_id, type, payload, visible_to, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    caseId, actorId, type, JSON.stringify(payload), JSON.stringify(visibleTo), now());
