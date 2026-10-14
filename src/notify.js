// Mail via Resend, daily caps, daily digest and bundled progress mails.
import { DB, E, now, q, row, rows, STAFF } from './core.js';
import { canSee } from './access.js';
import { markBlocked } from './tasks.js';

// Resend (https://resend.com) over plain fetch; RESEND_API_KEY is a Worker secret.
// Locally without a key, mails are only logged so the flows can be tried out.

// Returns true when the mail was handed over; never throws, callers decide on a fallback.
// Digest and progress mails ("bulk") stop at MAIL_DAILY_CAP per day (Resend free tier: 100/day), so invitations,
// login links and deletion notices always have room.
export const bulkCap = () => Number(E.MAIL_DAILY_CAP ?? 80);

const mailsToday = async bulk => (await row('SELECT COUNT(*) AS n FROM mail_log WHERE sent_at >= ? AND (? = 0 OR bulk = 1)', now().slice(0, 10), bulk ? 1 : 0)).n;

export async function sendMail(to, subject, paragraphs, { replyTo, bulk = false, kind = null } = {}) {
  if (bulk && (await mailsToday(true)) >= bulkCap()) {
    console.error('sendMail skipped: daily cap for digest/progress mails reached');
    return false;
  }
  const text = paragraphs.join('\n\n');
  let ok = false;
  if (!E.RESEND_API_KEY) {
    if (!E.DEV_LOGIN) return false;
    console.log(`[mail] to ${to}: ${subject}\n${text}`);
    ok = true;
  } else {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${E.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: E.MAIL_FROM, to: [to], subject, text, ...(replyTo && { reply_to: replyTo }) }),
      });
      ok = res.ok;
      if (!ok) console.error('sendMail failed', res.status, await res.text());
    } catch (e) {
      console.error('sendMail failed', e.message);
    }
  }
  if (ok) await q('INSERT INTO mail_log (bulk, kind, sent_at) VALUES (?, ?, ?)', bulk ? 1 : 0, kind, now()).run();
  return ok;
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

export async function sendDigests() {
  if (!E.ORIGIN) return console.error('digest skipped: ORIGIN not set');
  const ts = now(), today = ts.slice(0, 10);
  const parts = await rows(`
    SELECT p.user_id, p.case_id, p.role, p.access, u.email, u.name, u.last_digest_at, u.email_progress, c.title AS case_title
    FROM case_participants p JOIN users u ON u.id = p.user_id JOIN cases c ON c.id = p.case_id
    WHERE p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?) AND c.status = 'open' AND u.email_reminders = 1`, ts);
  const caseIds = JSON.stringify([...new Set(parts.map(p => p.case_id))]);
  const userIds = JSON.stringify([...new Set(parts.map(p => p.user_id))]);
  const [tasks, comments, sent] = (await DB.batch([
    q('SELECT * FROM tasks WHERE case_id IN (SELECT value FROM json_each(?))', caseIds),
    // ponytail: messages older than 8 days are never announced (e.g. after a long cron outage).
    q("SELECT case_id, actor_id, visible_to, created_at FROM events WHERE type = 'comment' AND case_id IN (SELECT value FROM json_each(?)) AND created_at > ?",
      caseIds, new Date(Date.now() - 8 * 864e5).toISOString()),
    q('SELECT user_id, task_id, stage FROM notifications WHERE user_id IN (SELECT value FROM json_each(?))', userIds),
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

  // ponytail: one request per mail; the free Workers plan allows 50 outbound requests per run,
  // so past ~40 recipients a day switch to Resend's batch endpoint (100 mails per request).
  for (const d of digests.values()) {
    if (!d.items.length && !d.messages.length) continue;
    const link = caseId => `${E.ORIGIN}/#/case/${caseId}`;
    const sections = STAGES.filter(([s]) => d.items.some(i => i.stage === s)).map(([s, label]) => [label, ...d.items.filter(i => i.stage === s)
      .map(({ t, p }) => `- ${t.title} (${p.case_title})${t.due_date ? `, Frist ${deDate(t.due_date)}` : ''}\n  ${link(p.case_id)}`)].join('\n'));
    if (d.messages.length) sections.push(['Neue Nachrichten', ...d.messages.map(({ n, p }) => `- ${n} in ${p.case_title}\n  ${link(p.case_id)}`)].join('\n'));
    const n = d.items.length;
    const subject = [n && `${n} ${n === 1 ? 'Aufgabe' : 'Aufgaben'}`, d.messages.length && 'neue Nachrichten'].filter(Boolean).join(', ');
    const ok = await sendMail(d.email, `NomoCase: ${subject}`, [
      `Guten Morgen ${d.name},`,
      'hier ist Ihre Übersicht aus NomoCase.',
      ...sections,
      `Diese Erinnerungen können Sie hier abbestellen: ${E.ORIGIN}/#/account`,
    ], { bulk: true });
    if (!ok) continue; // try again tomorrow
    await DB.batch([
      ...d.items.map(({ t, stage }) => q('INSERT OR IGNORE INTO notifications (user_id, task_id, stage, sent_at) VALUES (?, ?, ?, ?)', d.user_id, t.id, stage, ts)),
      q('UPDATE users SET last_digest_at = ? WHERE id = ?', ts, d.user_id),
    ]);
  }
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

export async function sendProgress() {
  if (!E.ORIGIN) return console.error('progress skipped: ORIGIN not set');
  const ts = now();
  const fallback = new Date(Date.parse(ts) - PROGRESS_GAP).toISOString();
  const parts = (await rows(`
    SELECT p.user_id, p.case_id, p.role, p.access, u.email, u.name, u.progress_cursor, u.progress_mail_at, c.title AS case_title
    FROM case_participants p JOIN users u ON u.id = p.user_id JOIN cases c ON c.id = p.case_id
    WHERE p.revoked_at IS NULL AND (p.expires_at IS NULL OR p.expires_at > ?) AND u.email_progress = 1`, ts))
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
  for (const person of people.values()) {
    if (!person.cases.length) {
      await q('UPDATE users SET progress_cursor = ? WHERE id = ?', ts, person.user_id).run();
      continue;
    }
    const ok = await sendMail(person.email,
      person.cases.length === 1 ? `Neues in „${person.cases[0].p.case_title}“` : `Neues in ${person.cases.length} Vorgängen`, [
        `Guten Tag ${person.name},`,
        ...person.cases.map(({ p, news }) => [p.case_title, ...news.map(e => {
          const payload = JSON.parse(e.payload);
          return `- ${e.actor ?? payload.via ?? 'NomoCase'} ${PROGRESS_TEXT[e.type](payload)}`;
        }),
          `  ${E.ORIGIN}/#/case/${p.case_id}`].join('\n')),
        `Diese Benachrichtigungen (höchstens 3 pro Stunde) können Sie hier abbestellen: ${E.ORIGIN}/#/account`,
      ], { bulk: true });
    if (ok) await q('UPDATE users SET progress_cursor = ?, progress_mail_at = ? WHERE id = ?', ts, ts, person.user_id).run();
    // not ok (cap reached or mail failed): cursor stays, the news go out with the next run
  }
}
