// Mail into a case: every case has an unguessable address v-<inbox>@INBOX_DOMAIN (Cloudflare Email Routing → this
// Worker's email handler). Each mail is kept as an .eml document (team only by default), once per Message-ID.
// Attachments are only listed here (unpacking a large mail would cost the Worker too much CPU); the team takes them
// into the case as checked documents from the browser (public/shared/mime.js, documents view).
import { hex, uid } from './core.js';
import { MAX_UPLOAD, storeVersion } from './documents.js';
import { decodeHeader } from '../public/shared/mime.js';

export { decodeHeader };

const MAILS_PER_CASE_AND_DAY = 100;
const latin1 = b => new TextDecoder('latin1').decode(b);

export const inboxAddress = (rq, c) => (rq.env.INBOX_DOMAIN && c.inbox ? `v-${c.inbox}@${rq.env.INBOX_DOMAIN}` : null);
export const newInbox = () => hex(crypto.getRandomValues(new Uint8Array(5)));

// File names of attachments, from the part headers (filename="…", RFC 2231 filename*=utf-8''…, or name="…").
export function attachmentNames(raw) {
  const names = new Set();
  for (const m of latin1(raw).matchAll(/(?:file)?name\*?=(?:"([^"]*)"|([^;\r\n]+))/gi)) {
    let n = (m[1] ?? m[2]).trim();
    const ext = n.match(/^([\w-]+)''(.*)$/); // RFC 2231
    try { n = ext ? decodeURIComponent(ext[2]) : decodeHeader(n); } catch { /* keep as is */ }
    if (n) names.add(n);
  }
  return [...names].slice(0, 50);
}

const safeName = s => s.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'E-Mail';

// Called by worker.js for every mail Email Routing hands over. Rejecting makes the sender's server bounce it.
export async function receiveMail(rq, message) {
  const { row, sql, time } = rq;
  const local = message.to.split('@')[0].toLowerCase();
  const c = local.startsWith('v-') && await row('SELECT * FROM cases WHERE inbox = ?', local.slice(2));
  if (!c) return message.setReject('Unbekannte Adresse');
  if (c.status === 'closed') return message.setReject('Der Vorgang ist abgeschlossen und nimmt keine Mails mehr an.');
  if (message.rawSize > MAX_UPLOAD) return message.setReject('Die Mail ist zu groß (höchstens 20 MB).');
  const today = time.slice(0, 10);
  if ((await row('SELECT COUNT(*) AS n FROM inbound_mail WHERE case_id = ? AND received_at >= ?', c.id, today)).n >= MAILS_PER_CASE_AND_DAY) {
    return message.setReject('Für diesen Vorgang kamen heute schon zu viele Mails.');
  }
  const messageId = message.headers.get('message-id') ?? `${message.from}|${message.headers.get('date')}|${message.headers.get('subject')}`;
  if (await row('SELECT 1 FROM inbound_mail WHERE case_id = ? AND message_id = ?', c.id, messageId)) return; // already kept
  const bytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const subject = decodeHeader(message.headers.get('subject')) || '(ohne Betreff)';
  const from = decodeHeader(message.headers.get('from')) || message.from;
  const owner = await row("SELECT user_id FROM case_participants WHERE case_id = ? AND access = 'case_owner' ORDER BY created_at LIMIT 1", c.id);
  if (!owner) return message.setReject('Der Vorgang hat keine Verantwortlichen.');
  const doc = { isNew: true, id: uid(), title: `E-Mail: ${subject}`.slice(0, 200), doc_type: null, visible_to: [] };
  const f = { bytes, contentType: 'message/rfc822', size: bytes.length, filename: `${today} ${safeName(subject)}.eml`,
    sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) };
  await storeVersion(rq, { c, actorId: null, uploadedBy: owner.user_id, label: from, channel: 'mail', f, task: null, doc,
    extra: { subject, attachments: attachmentNames(bytes) },
    stmts: [sql('INSERT INTO inbound_mail (case_id, message_id, document_id, sender, received_at) VALUES (?, ?, ?, ?, ?)', c.id, messageId, doc.id, message.from, time)] });
}
