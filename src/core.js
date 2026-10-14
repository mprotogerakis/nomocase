// Shared basics: errors and JSON responses, D1 helpers, the event log, small value helpers.
export { ACCESS, DECISIONS, NEEDS_FILE, STAFF, TASK_TYPES } from '../public/shared/vocab.js';

// Bindings are constant per isolate; set once per request/cron run by worker.js.
export let DB, E;
export const init = env => { DB = env.DB; E = env; };

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const fail = (status, message) => { throw new HttpError(status, message); };

export const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });

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

export const ev = (caseId, actorId, type, payload, visibleTo = []) =>
  q('INSERT INTO events (case_id, actor_id, type, payload, visible_to, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    caseId, actorId, type, JSON.stringify(payload), JSON.stringify(visibleTo), now());
