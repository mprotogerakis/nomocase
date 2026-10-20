// Mail via Resend, daily caps, daily digest and bundled progress mails.
import { fail, STAFF, uid } from './core.js';
import { CONSENT_VERSION } from '../public/shared/consent.js';
import { canSee } from './access.js';
import { markBlocked } from './tasks.js';

// Resend (https://resend.com) over plain fetch; RESEND_API_KEY is a Worker secret.
// Locally without a key, mails are only logged so the flows can be tried out.

// Returns true when the mail was handed over; never throws, callers decide on a fallback.
// Digest and progress mails ("bulk") stop at MAIL_DAILY_CAP per day (Resend free tier: 100/day), so invitations,
// login links and deletion notices always have room.
export const bulkCap = rq => Number(rq.env.MAIL_DAILY_CAP ?? 80);

// Returns true when the provider accepted the mail. Every attempt is logged (mail_log: ok, HTTP status, error text).
// Digests and progress mails carry case data: only for people whose consent to the current text stands (withdrawing
// it stops them at once; a new text version pauses them until it is accepted).
const CONSENTED = 'EXISTS (SELECT 1 FROM consents k WHERE k.user_id = u.id AND k.version = ?2 AND k.withdrawn_at IS NULL)';

// `sender`: the user whose action causes the mail. Per day one person can cause at most PER_SENDER mails (workspace
// owners, who run the workspace, PER_OWNER: e.g. inviting a whole semester), so nobody can use up the provider's daily
// quota for everyone else (and with it everyone's invitations and login links).
const PER_SENDER = 30, PER_OWNER = 150;

// Counted per mail the person caused today: plain mails by their attempts, outbox mails once each (however often retried).
export async function checkSenderCap(rq, sender) {
  const { row, time } = rq;
  const { n, owner } = await row(`SELECT (SELECT COUNT(*) FROM mail_log WHERE sender_id = ?1 AND outbox_id IS NULL AND sent_at >= ?2)
      + (SELECT COUNT(*) FROM mail_outbox WHERE sender_id = ?1 AND created_at >= ?2) AS n,
    EXISTS (SELECT 1 FROM workspace_members WHERE user_id = ?1 AND role = 'owner') AS owner`, sender, time.slice(0, 10));
  const cap = owner ? PER_OWNER : PER_SENDER;
  if (n >= cap) fail(429, `Über Ihr Konto gingen heute schon ${cap} E-Mails hinaus. Morgen geht es weiter.`);
}

export async function sendMail(rq, to, subject, paragraphs, { replyTo, kind = null, sender = null } = {}) {
  return (await deliver(rq, to, subject, paragraphs, { replyTo, kind, sender })).ok;
}

// Same, with the provider's answer (for the test mail on the account page). `outboxId`: the outbox mail this attempt
// is for – sent as Idempotency-Key (its sender was counted when it was queued).
export async function deliver(rq, to, subject, paragraphs, { replyTo, kind = null, sender = null, outboxId = null } = {}) {
  const { sql, env, time } = rq;
  if (sender && !outboxId) await checkSenderCap(rq, sender);
  const text = paragraphs.join('\n\n');
  let r;
  if (!env.RESEND_API_KEY) {
    if (!env.DEV_LOGIN) return { ok: false, error: 'kein Mail-Anbieter eingerichtet' };
    console.log(`[mail] to ${to}: ${subject}\n${text}`);
    r = await devProvider(rq, to, outboxId);
  } else {
    rq.spend();
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json', ...(outboxId && { 'idempotency-key': outboxId }) },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, ...(replyTo && { reply_to: replyTo }) }),
        signal: AbortSignal.timeout(10e3), // a hanging provider must not hold the request; the outbox tries again
      });
      const body = await res.text();
      r = { ok: res.ok, status: res.status, ...(res.ok ? { id: JSON.parse(body).id } : { error: body.slice(0, 300) }) };
    } catch (e) {
      r = { ok: false, error: String(e.message).slice(0, 300) };
    }
    if (!r.ok) console.error('sendMail failed', r.status, r.error);
  }
  await sql('INSERT INTO mail_log (bulk, kind, sent_at, ok, status, error, sender_id, outbox_id) VALUES (0, ?, ?, ?, ?, ?, ?, ?)',
    kind, time, r.ok ? 1 : 0, r.status ?? null, r.error ?? null, sender, outboxId).run();
  return r;
}

// Locally there is no provider: mails are only logged. Addresses <mode>.…@outbox.test play its failures for the tests:
// fail-once (an error, then fine), timeout-once, lost (accepted, but the answer never came – the retry carries the
// same Idempotency-Key, so a real provider answers without sending again), fail-always.
async function devProvider(rq, to, outboxId) {
  const { row } = rq;
  const [name, domain] = to.split('@'), mode = name.split('.')[0];
  if (domain !== 'outbox.test') return { ok: true, status: 200 };
  const first = !outboxId || !(await row('SELECT 1 FROM mail_log WHERE outbox_id = ?', outboxId));
  if (mode === 'fail-always' || (mode === 'fail-once' && first)) return { ok: false, status: 500, error: 'provider error (test)' };
  if (mode === 'timeout-once' && first) return { ok: false, error: 'The operation was aborted due to timeout (test)' };
  if (mode === 'lost' && first) return { ok: false, error: 'connection lost after the provider accepted the mail (test)' };
  return { ok: true, status: 200 };
}

// Digest and progress mails of a run, in batch requests to the provider (up to 100 mails each): a run costs the same
// few subrequests however many people get one. Permissive validation, so a bad address fails only its own mail.
// - The daily cap: the room under it is taken first, in one statement (log rows counted as sent), so two runs at once
//   (05:00) cannot both use the same rest.
// - Sent once: each mail's `mark` (digest notes, progress cursor: what records it as sent) and the request itself
//   (bulk_outbox: its mails and its Idempotency-Key) are stored in one transaction before anything goes out. The
//   provider's answer settles it – taken, or refused: then the mail's marks are taken back (`undo`) and the next
//   regular run tries again. No answer (timeout, lost connection, 5xx, 429) or a run that stops on the way: the cron
//   sends the same request with the same key again (processOutbox), and the provider, which keeps keys for 24 hours,
//   sends nothing twice. It keeps trying for nearly a day, as long as the key holds. A request that got no answer at
//   all in that time may or may not have gone out: its marks stay – a mail may then be missing, but never comes twice –
//   and the log says so (the people page shows it). Only a clear refusal takes marks back.
// mails: [{ to, subject, paragraphs, mark: [statements], undo: { kind, … } }] → [true | false | null (no answer yet), …]
const BATCH_MAX = 100;
const BULK_RETRY_MINUTES = [1, 5, 15, 60, 240]; // then every 240 minutes
const BULK_KEY_HOURS = 23; // the last attempt still inside the provider's 24 hours for a key
// The log's note for such a mail: neither sent nor refused for sure (the people page counts these on their own).
export const UNCLEAR = 'keine Antwort des Anbieters, Zustellung ungeklärt';
const later = (time, minutes) => new Date(Date.parse(time) + minutes * 60e3).toISOString();

// How a mail's marks are taken back when it was not sent – only where no later run has moved them on since.
const UNDO = {
  digest: (rq, u) => [rq.sql('DELETE FROM notifications WHERE user_id = ? AND sent_at = ?', u.user, u.at),
    rq.sql('UPDATE users SET last_digest_at = ? WHERE id = ? AND last_digest_at = ?', u.prev, u.user, u.at)],
  progress: (rq, u) => [rq.sql('UPDATE users SET progress_cursor = ?, progress_mail_at = ? WHERE id = ? AND progress_mail_at = ?',
    u.cursor, u.mailAt, u.user, u.at)],
};

export async function sendBulk(rq, mails) {
  const { rows, sql, batch, time } = rq;
  if (!mails.length) return [];
  const taken = (await rows(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
    INSERT INTO mail_log (bulk, sent_at, ok) SELECT 1, ?2, 1 FROM n
    WHERE i <= ?3 - (SELECT COUNT(*) FROM mail_log WHERE ok = 1 AND bulk = 1 AND sent_at >= ?4) RETURNING id`,
  mails.length, time, bulkCap(rq), time.slice(0, 10))).map(r => r.id).sort((a, b) => a - b);
  if (taken.length < mails.length) console.error(`bulk mail: daily cap reached, ${mails.length - taken.length} not sent`);
  if (!taken.length) return mails.map(() => false);
  const going = mails.slice(0, taken.length);
  const requests = [];
  for (let i = 0; i < going.length; i += BATCH_MAX) {
    requests.push({ id: uid(), attempts: 0, created_at: time, mails: going.slice(i, i + BATCH_MAX)
      .map((m, k) => ({ to: m.to, subject: m.subject, text: m.paragraphs.join('\n\n'), log: taken[i + k], undo: m.undo })) });
  }
  await batch([...going.flatMap(m => m.mark ?? []),
    ...requests.map(r => sql('INSERT INTO bulk_outbox (id, mails, next_attempt_at, created_at) VALUES (?, ?, ?, ?)', r.id, JSON.stringify(r.mails), later(time, 1), time))]);
  const results = [];
  for (const r of requests) results.push(...await settleBulk(rq, r));
  return mails.map((m, i) => (i < results.length ? results[i] : false));
}

// One attempt for a stored request: an answer settles it (results logged, refused mails' marks taken back, the request
// gone); no answer leaves it due again, with the same key – while the key holds. Past that (also after a long cron
// outage, checked before sending: an expired key no longer protects) it is settled as unclear, its marks kept.
async function settleBulk(rq, r) {
  const { sql, batch, time } = rq;
  const until = Date.parse(r.created_at) + BULK_KEY_HOURS * 36e5, holds = Date.parse(time) < until;
  const answer = holds ? await bulkRequest(rq, r.id, r.mails) : null, attempts = r.attempts + 1;
  const next = later(time, BULK_RETRY_MINUTES[Math.min(attempts, BULK_RETRY_MINUTES.length) - 1]);
  if (!answer && holds && Date.parse(next) < until) {
    await sql('UPDATE bulk_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?', attempts, next, r.id).run();
    return r.mails.map(() => null);
  }
  const results = answer ?? r.mails.map(() => ({ ok: false, error: UNCLEAR }));
  await batch([
    sql(`UPDATE mail_log SET ok = json_extract(x.value, '$.ok'), status = json_extract(x.value, '$.status'), error = json_extract(x.value, '$.error')
      FROM json_each(?) x WHERE mail_log.id = json_extract(x.value, '$.id')`,
    JSON.stringify(results.map((x, i) => ({ id: r.mails[i].log, ok: x.ok ? 1 : 0, status: x.status ?? null, error: x.error ?? null })))),
    ...r.mails.flatMap((m, i) => (!answer || results[i].ok || !m.undo ? [] : UNDO[m.undo.kind](rq, m.undo))), // only clear refusals
    sql('DELETE FROM bulk_outbox WHERE id = ?', r.id),
  ]);
  return results.map(x => x.ok);
}

// The provider's answer for each mail, or null when there is none to go by (no response, overloaded, rate-limited,
// the same key still in progress): then the same request goes again later.
async function bulkRequest(rq, key, mails) {
  const { env } = rq;
  if (!env.RESEND_API_KEY) {
    if (!env.DEV_LOGIN) return mails.map(() => ({ ok: false, error: 'kein Mail-Anbieter eingerichtet' }));
    for (const m of mails) console.log(`[mail] to ${m.to}: ${m.subject}\n${m.text}`);
    return Promise.all(mails.map(m => devProvider(rq, m.to, null)));
  }
  rq.spend();
  let res, body;
  try {
    res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': key, 'x-batch-validation': 'permissive' },
      body: JSON.stringify(mails.map(m => ({ from: env.MAIL_FROM, to: [m.to], subject: m.subject, text: m.text }))),
      signal: AbortSignal.timeout(20e3),
    });
    body = await res.text();
  } catch (e) {
    console.error('bulk mail: no answer', e.message);
    return null;
  }
  if (res.status >= 500 || res.status === 429 || res.status === 409) {
    console.error('bulk mail: no answer yet', res.status, body.slice(0, 300));
    return null;
  }
  if (!res.ok) {
    console.error('bulk mail refused', res.status, body.slice(0, 300));
    return mails.map(() => ({ ok: false, status: res.status, error: body.slice(0, 300) }));
  }
  // permissive: { data: [the ids of the mails taken], errors: [{ index, message }] for the others }
  const refused = new Map((JSON.parse(body).errors ?? []).map(e => [e.index, String(e.message).slice(0, 300)]));
  if (refused.size) console.error('bulk mail: refused', [...refused.values()].join(' | '));
  return mails.map((m, i) => (refused.has(i) ? { ok: false, status: res.status, error: refused.get(i) } : { ok: true, status: res.status }));
}

// --- Outbox: mails that carry a link (migration 0043) ---------------------------------------------------------------
// outboxStmt goes into the batch that makes the link (and only inserts if the link is there); sendFromOutbox hands it
// over right away, processOutbox (cron) retries what is due. After MAX_ATTEMPTS the mail is given up and its link
// stops working: nobody got it, so nobody should be able to use it.
const LINK_TABLES = { invitation: 'invitations', workspace_invitation: 'workspace_invitations', login_link: 'login_links' };
const RETRY_MINUTES = [1, 5, 15, 60];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;

export const outboxStmt = (rq, { id, kind, ref, to, subject, paragraphs, replyTo = null, sender = null, mailKind = null }) =>
  rq.sql(`INSERT INTO mail_outbox (id, kind, ref, recipient, subject, body, reply_to, sender_id, mail_kind, next_attempt_at, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${LINK_TABLES[kind]} WHERE token_hash = ?)`,
  id, kind, ref, to, subject, paragraphs.join('\n\n'), replyTo, sender, mailKind, rq.time, rq.time, ref);

const giveUp = (rq, m) => ({
  invitation: rq.sql('UPDATE invitations SET expires_at = ? WHERE token_hash = ? AND accepted_at IS NULL', rq.time, m.ref),
  workspace_invitation: rq.sql('UPDATE workspace_invitations SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', rq.time, m.ref),
  login_link: rq.sql('UPDATE login_links SET expires_at = ? WHERE token_hash = ? AND used_at IS NULL', rq.time, m.ref),
}[m.kind]);

// One attempt for a pending outbox mail: { ok } – ok also when it had gone out before (e.g. by the cron meanwhile).
export async function sendFromOutbox(rq, id) {
  const { row, sql, batch, time } = rq;
  const m = await row("SELECT * FROM mail_outbox WHERE id = ? AND status = 'pending'", id);
  if (!m) return { ok: (await row('SELECT status FROM mail_outbox WHERE id = ?', id))?.status === 'sent' };
  const r = await deliver(rq, m.recipient, m.subject, [m.body], { replyTo: m.reply_to, kind: m.mail_kind, sender: m.sender_id, outboxId: m.id });
  const attempts = m.attempts + 1, error = r.ok ? null : r.error ?? `HTTP ${r.status}`;
  if (r.ok) {
    await sql("UPDATE mail_outbox SET status = 'sent', body = NULL, attempts = ?, last_error = NULL, sent_at = ? WHERE id = ?", attempts, time, m.id).run();
  } else if (attempts >= MAX_ATTEMPTS) {
    console.error('outbox: given up', m.kind, m.id, error);
    await batch([sql("UPDATE mail_outbox SET status = 'failed', body = NULL, attempts = ?, last_error = ? WHERE id = ?", attempts, error, m.id), giveUp(rq, m)]);
  } else {
    await sql('UPDATE mail_outbox SET attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?',
      attempts, error, new Date(Date.now() + RETRY_MINUTES[attempts - 1] * 60e3).toISOString(), m.id).run();
  }
  return r;
}

// Cron: retries the pending mails that are due, as many as the run has room for (four subrequests each); the rest
// waits for the next run.
export async function processOutbox(rq) {
  const { rows, room, time } = rq;
  for (const { id } of await rows("SELECT id FROM mail_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 10", time)) {
    if (!room(4)) break;
    await sendFromOutbox(rq, id);
  }
  // batch requests of digest and progress mails still without an answer: the same request with the same key; taken
  // for a few minutes first, so two runs at once (05:00) do not both send it
  const due = await rows(`UPDATE bulk_outbox SET next_attempt_at = ?1 WHERE id IN
    (SELECT id FROM bulk_outbox WHERE next_attempt_at <= ?2 ORDER BY next_attempt_at LIMIT 5) RETURNING *`, later(time, 5), time);
  for (const r of due) {
    if (!room(3)) break; // the rest is due again in a few minutes
    await settleBulk(rq, { ...r, mails: JSON.parse(r.mails) });
  }
}

// What the person who caused the mail is told: handed over, or queued and retried by itself.
export const mailAnswer = r => ({ sent: !!r.ok, queued: !r.ok });

// Account page: a test mail to oneself shows whether sending works and what the provider answered. At most 3 per hour.
export async function testMail(rq) {
  const { user, row } = rq;
  const { n } = await row("SELECT COUNT(*) AS n FROM mail_log WHERE kind = 'test' AND sent_at >= ?", new Date(Date.now() - 36e5).toISOString());
  if (n >= 3) fail(429, 'Höchstens drei Testmails pro Stunde.');
  return deliver(rq, user.email, 'NomoCase: Testmail', [`Guten Tag ${user.name},`, 'diese Testmail zeigt, dass NomoCase Ihnen Mails schicken kann.',
    `Gesendet: ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`], { kind: 'test' });
}

// One mail per person and day at most: actionable tasks that are new to them or reach a deadline stage,
// plus new messages. Each (task, stage) is announced once; reopening a task makes it new again.

const STAGES = [['overdue', 'Überfällig'], ['soon', 'Heute oder morgen fällig'], ['week', 'In den nächsten 7 Tagen fällig'], ['new', 'Neu für Sie']];

export const deDate = d => d.split('-').reverse().join('.');

function stageOf(task, today) {
  if (!task.due_date) return 'new';
  const days = (Date.parse(task.due_date) - Date.parse(today)) / 864e5;
  return days < 0 ? 'overdue' : days <= 1 ? 'soon' : days <= 7 ? 'week' : 'new';
}

export async function sendDigests(rq) {
  const { rows, sql, batch, env, time } = rq;
  if (!env.ORIGIN) return console.error('digest skipped: ORIGIN not set');
  const ts = time, today = ts.slice(0, 10);
  const parts = await rows(`
    SELECT p.user_id, p.case_id, p.role, p.access, u.email, u.name, u.last_digest_at, u.email_progress, c.title AS case_title
    FROM case_participants p JOIN users u ON u.id = p.user_id JOIN cases c ON c.id = p.case_id
    WHERE p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?1) AND c.status = 'open' AND u.email_reminders = 1 AND ${CONSENTED}`, ts, CONSENT_VERSION);
  const caseIds = JSON.stringify([...new Set(parts.map(p => p.case_id))]);
  const userIds = JSON.stringify([...new Set(parts.map(p => p.user_id))]);
  const [tasks, comments, sent] = (await batch([
    sql('SELECT * FROM tasks WHERE case_id IN (SELECT value FROM json_each(?))', caseIds),
    // ponytail: messages older than 8 days are never announced (e.g. after a long cron outage).
    sql("SELECT case_id, actor_id, visible_to, created_at FROM events WHERE type = 'comment' AND case_id IN (SELECT value FROM json_each(?)) AND created_at > ?",
      caseIds, new Date(Date.now() - 8 * 864e5).toISOString()),
    sql('SELECT user_id, task_id, stage FROM notifications WHERE user_id IN (SELECT value FROM json_each(?))', userIds),
  ])).map(r => r.results);
  markBlocked(tasks);
  const done = new Set(sent.map(n => `${n.user_id}|${n.task_id}|${n.stage}`));

  const digests = new Map();
  for (const p of parts) {
    const d = digests.get(p.user_id) ?? { ...p, items: [], messages: [] };
    digests.set(p.user_id, d);
    for (const t of tasks) {
      if (t.case_id !== p.case_id || t.role !== p.role || t.status !== 'open' || t.blocked) continue;
      const stage = stageOf(t, today);
      if (!done.has(`${p.user_id}|${t.id}|${stage}`)) d.items.push({ t, stage, p });
    }
    const since = p.last_digest_at ?? new Date(Date.now() - 864e5).toISOString();
    const ctx = { user: { id: p.user_id }, role: p.role, staff: STAFF.includes(p.access) };
    const n = comments.filter(e => e.case_id === p.case_id && e.created_at > since && e.actor_id !== p.user_id && canSee(ctx, e)).length;
    if (n && !p.email_progress) d.messages.push({ n, p });
  }

  // all mails in one request, all bookkeeping in one batch (a few subrequests, however many people)
  const due = [...digests.values()].filter(d => d.items.length || d.messages.length);
  const link = caseId => `${env.ORIGIN}/#/case/${caseId}`;
  await sendBulk(rq, due.map(d => {
    const sections = STAGES.filter(([s]) => d.items.some(i => i.stage === s)).map(([s, label]) => [label, ...d.items.filter(i => i.stage === s)
      .map(({ t, p }) => `- ${t.title} (${p.case_title})${t.due_date ? `, Frist ${deDate(t.due_date)}` : ''}\n  ${link(p.case_id)}`)].join('\n'));
    if (d.messages.length) sections.push(['Neue Nachrichten', ...d.messages.map(({ n, p }) => `- ${n} in ${p.case_title}\n  ${link(p.case_id)}`)].join('\n'));
    const n = d.items.length;
    const subject = [n && `${n} ${n === 1 ? 'Aufgabe' : 'Aufgaben'}`, d.messages.length && 'neue Nachrichten'].filter(Boolean).join(', ');
    return { to: d.email, subject: `NomoCase: ${subject}`, paragraphs: [
      `Guten Morgen ${d.name},`,
      'hier ist Ihre Übersicht aus NomoCase.',
      ...sections,
      `Diese Erinnerungen können Sie hier abbestellen: ${env.ORIGIN}/#/account`,
    ],
    mark: [...d.items.map(({ t, stage }) => sql('INSERT OR IGNORE INTO notifications (user_id, task_id, stage, sent_at) VALUES (?, ?, ?, ?)', d.user_id, t.id, stage, ts)),
      sql('UPDATE users SET last_digest_at = ? WHERE id = ?', ts, d.user_id)],
    undo: { kind: 'digest', user: d.user_id, at: ts, prev: d.last_digest_at } }; // not sent: tomorrow's digest tries again
  }));
}

// What others did in a person's cases, bundled into one mail at most every 20 minutes (3 per hour).
// The events table is the outbox; per person only a cursor and the time of the last mail are kept.

export const DAILY_CRON = '0 5 * * *';

const PROGRESS_GAP = 20 * 60e3;

const VERDICTS = { review: ['als in Ordnung bestätigt', 'beanstandet'], approval: ['genehmigt', 'abgelehnt'], decision: ['zugestimmt', 'abgelehnt'] };

const clip = s => (String(s ?? '').length > 280 ? `${String(s).slice(0, 277)}…` : String(s ?? ''));

const PROGRESS_TEXT = {
  comment: () => 'hat eine Nachricht geschrieben',
  'task.complete': p => `hat „${p.task}“ erledigt`,
  'task.approve': p => (p.verdict ? `hat „${p.task}“ entschieden: ${p.verdict}` : `hat „${p.task}“ ${(VERDICTS[p.type] ?? VERDICTS.approval)[0]}`),
  'task.reject': p => `hat „${p.task}“ ${p.verdict ? `entschieden: ${p.verdict}` : (VERDICTS[p.type] ?? VERDICTS.approval)[1]}`,
  'task.question': p => `hat eine Rückfrage zu „${p.task}“ gestellt`,
  'document.uploaded': p => `hat „${p.document}“ hochgeladen (v${p.version})${p.completed ? ` und damit „${p.task}“ erledigt` : ''}`,
  'request.created': p => `hat ein Anliegen eingereicht: „${p.task}“`,
  'participant.joined': p => `ist als ${p.role} dazugekommen`,
  'case.closed': () => 'hat den Vorgang abgeschlossen',
  'case.reopened': () => 'hat den Vorgang wieder geöffnet',
};

export async function sendProgress(rq) {
  const { rows, sql, env, time } = rq;
  if (!env.ORIGIN) return console.error('progress skipped: ORIGIN not set');
  const ts = time;
  const fallback = new Date(Date.parse(ts) - PROGRESS_GAP).toISOString();
  const parts = (await rows(`
    SELECT p.user_id, p.case_id, p.role, p.access, u.email, u.name, u.progress_cursor, u.progress_mail_at, c.title AS case_title
    FROM case_participants p JOIN users u ON u.id = p.user_id JOIN cases c ON c.id = p.case_id
    WHERE p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?1) AND u.email_progress = 1 AND ${CONSENTED}`, ts, CONSENT_VERSION))
    .filter(p => !p.progress_mail_at || Date.parse(ts) - Date.parse(p.progress_mail_at) >= PROGRESS_GAP - 60e3); // 1 min slack for cron jitter
  if (!parts.length) return;
  const since = parts.map(p => p.progress_cursor ?? fallback).sort()[0];
  const events = await rows(`SELECT e.*, u.name AS actor FROM events e LEFT JOIN users u ON u.id = e.actor_id
    WHERE e.case_id IN (SELECT value FROM json_each(?)) AND e.type IN (SELECT value FROM json_each(?)) AND e.created_at > ? AND e.created_at <= ?
    ORDER BY e.id`, JSON.stringify([...new Set(parts.map(p => p.case_id))]), JSON.stringify(Object.keys(PROGRESS_TEXT)), since, ts);

  const people = new Map();
  for (const p of parts) {
    const person = people.get(p.user_id) ?? { ...p, cases: [] };
    people.set(p.user_id, person);
    const ctx = { user: { id: p.user_id }, role: p.role, staff: STAFF.includes(p.access) };
    const news = events.filter(e => e.case_id === p.case_id && e.created_at > (p.progress_cursor ?? fallback) && e.actor_id !== p.user_id && canSee(ctx, e));
    if (news.length) person.cases.push({ p, news });
  }
  // all mails in one request, all cursors in one batch (a few subrequests, however many people)
  const quiet = [...people.values()].filter(person => !person.cases.length).map(person => person.user_id);
  const due = [...people.values()].filter(person => person.cases.length);
  await sql('UPDATE users SET progress_cursor = ? WHERE id IN (SELECT value FROM json_each(?))', ts, JSON.stringify(quiet)).run();
  await sendBulk(rq, due.map(person => ({
    to: person.email,
    subject: person.cases.length === 1 ? `Neues in „${person.cases[0].p.case_title}“` : `Neues in ${person.cases.length} Vorgängen`,
    paragraphs: [
      `Guten Tag ${person.name},`,
      ...person.cases.map(({ p, news }) => [p.case_title, ...news.map(e => {
        const payload = JSON.parse(e.payload);
        return `- ${e.actor ?? payload.via ?? 'NomoCase'} ${PROGRESS_TEXT[e.type](payload)}`;
      }),
      `  ${env.ORIGIN}/#/case/${p.case_id}`].join('\n')),
      `Diese Benachrichtigungen (höchstens 3 pro Stunde) können Sie hier abbestellen: ${env.ORIGIN}/#/account`,
    ],
    mark: [sql('UPDATE users SET progress_cursor = ?, progress_mail_at = ? WHERE id = ?', ts, ts, person.user_id)],
    // not sent: the cursor goes back, the news go out with the next run
    undo: { kind: 'progress', user: person.user_id, at: ts, cursor: person.progress_cursor, mailAt: person.progress_mail_at },
  })));
}
