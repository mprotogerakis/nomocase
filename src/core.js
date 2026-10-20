// Shared basics: the request context (D1 helpers, event statements, env, time), errors and JSON responses, small value
// helpers. No module state: everything that depends on the deployment or the request travels in the context.
export { ACCESS, acceptedExtensions, DECISIONS, FILE_KIND_LABELS, FILE_KINDS, NEEDS_FILE, STAFF, TASK_TYPES, validFiles } from '../public/shared/vocab.js';

// Came the request through Cloudflare's network? There CF-Connecting-IP is the client's real address – never a
// loopback one, which is what wrangler dev puts there (::1) unless the client sends its own.
export const viaCloudflare = req => { const ip = req?.headers.get('cf-connecting-ip'); return !!ip && !/^(::1$|127\.|::ffff:127\.)/.test(ip); };

// DEV_LOGIN (login by e-mail, links in answers, the list of accounts) only counts for a local origin and a request
// that did not come through Cloudflare's network. So a wrongly deployed variable, even together with a local ORIGIN,
// opens nothing. (The request's host does not tell: wrangler dev rewrites it to the production route.)
const isLocal = (env, req) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.ORIGIN ?? '') && !viaCloudflare(req);
const appEnv = (env, req) => (env.DEV_LOGIN && !isLocal(env, req) ? { ...env, DEV_LOGIN: undefined } : env);

// Subrequests: the free plan allows 50 per invocation (a request, a cron run, an incoming mail), and every D1 statement
// or batch, R2 call and fetch counts. The context counts them. Loops that grow with the data ask `room(cost)` before
// each item and leave the rest to the next cron run; a cron run keeps CRON_RESERVE for its later steps (digest,
// progress mails, housekeeping: a fixed handful each). Locally going over fails, as it would in production, so the
// tests notice. A batch counts once however many statements it has: measured on this account on 2026-10-20, a batch of
// 2000 statements plus 999 single queries made exactly the 1000 calls Cloudflare actually enforces per invocation; we
// keep to the documented 50.
export const SUBREQUESTS = 50;
const CRON_RESERVE = 12;

// The request context: what a handler and the helpers it calls work with, handed on explicitly instead of module state.
// worker.js makes one per request (handlers get it together with req, url, user, body, params) and one per cron run or
// incoming mail. Helpers outside a handler take it as their first parameter (`rq`). The names are long enough for the
// free-variable check (scripts/freevars.mjs) to notice one that a function uses without taking it from the context.
//   sql, row, rows, batch     – D1 (sql: one statement, e.g. for a batch); no other way in, so every query is counted
//   event, wsEvent            – a case event / a workspace log entry (the owners' log: members, roles, invitations,
//                               look, issuers, templates, moved cases), as a statement for a batch
//   env                       – bindings and vars (DEV_LOGIN only for a local request, see above)
//   time                      – when the request started (ISO), the time its rows are stamped with
//   rpId                      – the passkeys' domain (WebAuthn RP ID): the one of ORIGIN
//   room, spend               – subrequests (see above): is there room for `cost` more; count one (a fetch)
export function context(env, req = null) {
  const db = env.DB, time = new Date().toISOString(), local = isLocal(env, req), reserve = req ? 0 : CRON_RESERVE;
  let spent = 0;
  const spend = () => {
    if (++spent > SUBREQUESTS && local) throw new Error(`Too many subrequests (more than ${SUBREQUESTS}, local check)`);
  };
  // R2 counts too: the bucket as seen through the context counts each call
  const files = env.FILES && new Proxy(env.FILES, { get: (bucket, k) => (typeof bucket[k] === 'function' ? (...args) => { spend(); return bucket[k](...args); } : bucket[k]) });
  const envHere = { ...appEnv(env, req), ...(files && { FILES: files }) };
  // a statement counts when it runs on its own; in a batch the batch counts once
  const sql = (text, ...args) => {
    const st = db.prepare(text).bind(...args);
    for (const m of ['first', 'all', 'run', 'raw']) { const run = st[m].bind(st); st[m] = (...a) => { spend(); return run(...a); }; }
    return st;
  };
  return {
    sql, env: envHere, time, rpId: envHere.ORIGIN ? new URL(envHere.ORIGIN).hostname : null,
    room: cost => SUBREQUESTS - spent - reserve >= cost, spend,
    row: (text, ...args) => sql(text, ...args).first(),
    rows: async (text, ...args) => (await sql(text, ...args).all()).results,
    batch: stmts => { spend(); return db.batch(stmts); },
    event: (caseId, actorId, type, payload, visibleTo = []) => sql('INSERT INTO events (case_id, actor_id, type, payload, visible_to, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      caseId, actorId, type, JSON.stringify(payload), JSON.stringify(visibleTo), time),
    wsEvent: (workspaceId, actorId, type, payload = {}) => sql('INSERT INTO workspace_events (workspace_id, actor_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
      workspaceId, actorId, type, JSON.stringify(payload), time),
  };
}
// The id of the deployed version (open pages reload when it changes).
export const appVersion = env => env.CF_VERSION_METADATA?.id ?? 'dev';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const fail = (status, message) => { throw new HttpError(status, message); };

// A closed case is read-only (database triggers, migration 0042); this is what users read when they run into it.
export const CASE_CLOSED = 'Der Vorgang ist abgeschlossen und kann nicht mehr geändert werden. Zum Ändern bitte erst wieder öffnen.';

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

export const uid = () => crypto.randomUUID();

export const arr = v => (Array.isArray(v) ? v : JSON.parse(v ?? '[]'));

export const roleList = v => (Array.isArray(v) ? v.map(String) : fail(400, 'visible_to muss eine Liste sein'));

export const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

export const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));

export const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
