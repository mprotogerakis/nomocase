// Documents: upload checks, versions in R2, upload links, downloads.
import { checkContent } from './validate.js';
import { readSignatures } from './pdfsig.js';
import { signatureEvents, signatureStmts } from './signatures.js';
import { arr, DB, DECISIONS, E, ev, fail, hex, NEEDS_FILE, now, q, roleList, row, rows, sha256, token, uid } from './core.js';
import { canSee, canWork, caseCtx, taskAudience } from './access.js';
import { originOf } from './auth.js';
import { loadTask, markBlocked } from './tasks.js';
import { moneyStmts } from './finance.js';
import { sendMail } from './notify.js';

export const MAX_UPLOAD = 20 * 1024 * 1024;

const ZIP = [0x50, 0x4b, 0x03, 0x04];

// extension → [content type, magic bytes]; deeper content checks live in validate.js.
const FILE_TYPES = {
  pdf: ['application/pdf', [0x25, 0x50, 0x44, 0x46]],
  png: ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  jpg: ['image/jpeg', [0xff, 0xd8, 0xff]],
  jpeg: ['image/jpeg', [0xff, 0xd8, 0xff]],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP],
  odt: ['application/vnd.oasis.opendocument.text', ZIP],
  txt: ['text/plain; charset=utf-8', []],
};

const INLINE = ['application/pdf', 'image/png', 'image/jpeg'];

// Checks a file before anything is stored: type, size, magic bytes and content (strict outside the team).
// `given`: SHA-256 as the browser read the file (app.js sends it). R2 checks it on put, so the stored bytes provably
// match what left the uploader's disk. Without one the Worker computes it (ponytail: Worker CPU, ~1 ms per MB).
export async function readUpload(file, strict, given) {
  if (!(file instanceof File) || !file.size) fail(400, 'Keine Datei');
  if (file.size > MAX_UPLOAD) fail(413, 'Datei zu groß (max. 20 MB)');
  const ext = file.name.split('.').pop().toLowerCase();
  const [contentType, magic] = FILE_TYPES[ext] ?? fail(415, 'Dateityp nicht erlaubt');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const problem = magic.some((b, i) => bytes[i] !== b) ? 'Der Dateiinhalt passt nicht zur Dateiendung.' : await checkContent(ext, bytes, { strict });
  const sha256 = given ? (/^[0-9a-f]{64}$/.test(given) ? given : fail(400, 'Prüfsumme ungültig')) : hex(await crypto.subtle.digest('SHA-256', bytes));
  return { bytes, contentType, problem, filename: file.name.slice(0, 200), size: file.size, sha256 };
}

// Stores a checked file as the next version of `doc` (a row, or a new document to create) and completes the task
// it belongs to (decisions only get it attached). `actorId` is null and `label` set for uploads through a link or
// mails into the case (`channel: 'mail'`, `extra`: subject and attachment names for the log).
export async function storeVersion({ c, actorId, uploadedBy, label = null, channel = null, extra = {}, f, task, doc, stmts = [] }) {
  if (doc.isNew) {
    stmts.unshift(q('INSERT INTO documents (id, case_id, title, doc_type, visible_to, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      doc.id, c.id, doc.title, doc.doc_type, JSON.stringify(doc.visible_to), uploadedBy, now()));
  }
  const { n } = await row('SELECT COALESCE(MAX(version), 0) + 1 AS n FROM document_versions WHERE document_id = ?', doc.id);
  const versionId = uid();
  const key = `${c.workspace_id}/${c.id}/${doc.id}/${versionId}`;
  // file first, so the DB never points at a missing object
  await E.FILES.put(key, f.bytes, { httpMetadata: { contentType: f.contentType }, sha256: f.sha256 }).catch(e => {
    if (/sha-?256|checksum|digest/i.test(e.message)) fail(400, 'Die Datei kam unvollständig an (Prüfsumme stimmt nicht). Bitte erneut hochladen.');
    throw e;
  });
  const completes = task && task.status === 'open' && !task.blocked && !DECISIONS.includes(task.type);
  // Digital signatures inside PDFs: stored with the version; a signer who used another key before is logged.
  const sigs = f.contentType === 'application/pdf' ? await readSignatures(f.bytes) : [];
  stmts.push(
    q('INSERT INTO document_versions (id, document_id, version, filename, content_type, size, r2_key, uploaded_by, created_at, task_id, uploader_label, sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      versionId, doc.id, n, f.filename, f.contentType, f.size, key, uploadedBy, now(), task?.id ?? null, label, f.sha256),
    ev(c.id, actorId, 'document.uploaded',
      { document: doc.title, version: n, filename: f.filename, version_id: versionId, sha256: f.sha256, ...(label && { via: label }), ...(channel && { channel }), ...extra,
        ...(task && { task: task.title, task_id: task.id, completed: completes }) },
      [...new Set([...arr(doc.visible_to), ...(task ? taskAudience(task) : [])])]),
    ...signatureStmts(versionId, sigs),
    ...await signatureEvents(c, versionId, doc, sigs, actorId),
  );
  if (completes) stmts.push(q("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ? WHERE id = ?", now(), actorId, task.id));
  await DB.batch(stmts);
  return { document_id: doc.id, version: n };
}

// Target document for an upload through a task: the existing one of the task's type (if the uploader may see it) or a new one.
async function taskDocument(ctx, task, title, filename) {
  const existing = task.doc_type && (await rows('SELECT * FROM documents WHERE case_id = ? AND doc_type = ? ORDER BY created_at', ctx.c.id, task.doc_type)).find(d => canSee(ctx, d));
  if (existing) return existing;
  const dt = ctx.def.document_types.find(t => t.key === task.doc_type);
  return { isNew: true, id: uid(), title: String(title || dt?.label || filename).slice(0, 200), doc_type: task.doc_type ?? null, visible_to: dt?.visible_to ?? [] };
}

export async function upload({ req, user, params }) {
  const ctx = await caseCtx(user, params.id);
  if (ctx.access === 'guest_viewer') fail(403, 'Keine Upload-Berechtigung');
  const form = await req.formData();
  const f = await readUpload(form.get('file'), !ctx.staff, form.get('sha256'));
  if (f.problem) {
    await ev(ctx.c.id, user.id, 'upload.rejected', { filename: f.filename, note: f.problem }, []).run();
    fail(422, f.problem);
  }

  let task = null;
  if (form.get('task_id')) {
    ({ t: task } = await loadTask(user, form.get('task_id')));
    if (task.case_id !== ctx.c.id) fail(400, 'Aufgabe gehört zu einem anderen Vorgang');
    if (!canWork(ctx, task) || task.status !== 'open' || task.blocked) fail(409, 'Aufgabe kann gerade nicht bearbeitet werden');
  }

  // Target document: explicit new version > existing document of the task's type > new document.
  let doc;
  if (form.get('document_id')) {
    doc = await row('SELECT * FROM documents WHERE id = ? AND case_id = ?', form.get('document_id'), ctx.c.id);
    if (!doc || !canSee(ctx, doc)) fail(404, 'Dokument nicht gefunden');
    const last = await row('SELECT uploaded_by FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1', doc.id);
    if (!ctx.staff && (task || doc.final || last?.uploaded_by !== user.id)) fail(403, 'Neue Fassungen dieses Dokuments bitte über die passende Aufgabe hochladen.');
  } else if (task) {
    doc = await taskDocument(ctx, task, form.get('title'), f.filename);
  } else {
    const docType = form.get('doc_type') || null;
    const dt = ctx.def.document_types.find(t => t.key === docType);
    if (docType && !dt) fail(400, 'Unbekannter Dokumenttyp');
    // otherwise a guest could create the document a later team upload of that type lands in, and read it
    if (!ctx.staff && dt && !dt.visible_to.some(v => v === '*' || v === ctx.role)) fail(403, 'Dokumente dieses Typs legt das Team an.');
    doc = { isNew: true, id: uid(), title: String(form.get('title') || dt?.label || f.filename).slice(0, 200), doc_type: docType, visible_to: dt?.visible_to ?? [] };
  }
  const stmts = task ? await moneyStmts(ctx, user, task, form.get('amount_cents')) : [];
  return storeVersion({ c: ctx.c, actorId: user.id, uploadedBy: user.id, f, task, doc, stmts });
}

// Spec 4.2 variant B: someone without an account (a practice, a workshop) uploads a file for exactly one task.
// The link grants nothing else: no view of the case, the strict upload rules, single use by default, expires.

export async function createUploadLink({ user, params, body, url }) {
  const { ctx, t } = await loadTask(user, params.id);
  if (!ctx.staff) fail(403, 'Nur das Team erzeugt Upload-Links');
  if (!t.doc_type && !NEEDS_FILE.includes(t.type)) fail(400, 'Diese Aufgabe erwartet keine Datei');
  if (t.status !== 'open') fail(409, 'Die Aufgabe ist nicht offen');
  const label = String(body.label ?? '').trim().slice(0, 80) || fail(400, 'Bitte angeben, wer hochlädt');
  const days = Math.min(Math.max(Math.round(Number(body.days) || 14), 1), 60);
  const email = String(body.email ?? '').trim().toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'E-Mail ungültig');
  const secret = token();
  await DB.batch([
    q('INSERT INTO upload_links (token_hash, case_id, task_id, label, created_by, created_at, expires_at, single_use) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      await sha256(secret), ctx.c.id, t.id, label, user.id, now(), new Date(Date.now() + days * 864e5).toISOString(), body.single_use === false ? 0 : 1),
    ev(ctx.c.id, user.id, 'upload_link.created', { task: t.title, task_id: t.id, label, days }, []),
  ]);
  const link = `${originOf(url)}/#/upload/${secret}`;
  const sent = email ? await sendMail(email, `Bitte Datei bereitstellen: ${t.title}`, [
    'Guten Tag,',
    `${user.name} bittet Sie, für „${t.title}“ eine Datei bereitzustellen. Eine Anmeldung ist nicht nötig:\n${link}`,
    `Der Link ist ${days} Tage gültig${body.single_use === false ? '' : ' und funktioniert für eine Datei'}. Erlaubt sind PDF, Bilder (PNG, JPG), Word, Excel, OpenDocument und Text bis 20 MB.`,
  ], { replyTo: user.email }) : false;
  return sent && !E.DEV_LOGIN ? { sent } : { sent, link };
}

async function loadUploadLink(secret) {
  return (await row(`SELECT l.*, t.title AS task_title, t.doc_type, t.type AS task_type, t.status AS task_status, u.name AS requester, c.definition, c.workspace_id
    FROM upload_links l JOIN tasks t ON t.id = l.task_id JOIN users u ON u.id = l.created_by JOIN cases c ON c.id = l.case_id
    WHERE l.token_hash = ? AND l.revoked_at IS NULL AND l.expires_at > ? AND (l.single_use = 0 OR l.used_at IS NULL)
      AND t.status = 'open' AND c.status = 'open'`, await sha256(String(secret ?? '')), now()))
    ?? fail(404, 'Dieser Upload-Link ist ungültig, abgelaufen oder wurde schon benutzt.');
}

// What the person behind the link sees: who asks, for what. Nothing about the case.
export async function getUploadLink({ params }) {
  const l = await loadUploadLink(params.token);
  const dt = JSON.parse(l.definition).document_types.find(t => t.key === l.doc_type);
  return { requester: l.requester, label: l.label, task: l.task_title, document: dt?.label ?? null, expires_at: l.expires_at };
}

export async function useUploadLink({ req, params }) {
  const l = await loadUploadLink(params.token);
  const form = await req.formData();
  const f = await readUpload(form.get('file'), true, form.get('sha256'));
  if (f.problem) { // logged for the team; the link stays usable for a corrected file
    await ev(l.case_id, null, 'upload.rejected', { filename: f.filename, note: f.problem, via: l.label }, []).run();
    fail(422, f.problem);
  }
  if (l.single_use && !(await row('UPDATE upload_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING token_hash', now(), l.token_hash))) {
    fail(404, 'Dieser Upload-Link wurde gerade schon benutzt.');
  }
  const def = JSON.parse(l.definition);
  const c = { id: l.case_id, workspace_id: l.workspace_id };
  const tasks = markBlocked(await rows('SELECT * FROM tasks WHERE case_id = ?', l.case_id));
  const task = tasks.find(t => t.id === l.task_id);
  // Acts like the team member who sent the link would see it, but the version is labelled with who really uploaded.
  const ctx = { c, def, user: { id: l.created_by }, role: null, staff: true };
  const doc = await taskDocument(ctx, task, null, f.filename);
  if (doc.final) fail(410, 'Dieses Dokument ist bereits als Endfassung markiert.');
  await storeVersion({ c, actorId: null, uploadedBy: l.created_by, label: l.label, f, task, doc });
  return { ok: true };
}

export async function revokeUploadLinks({ user, params }) {
  const { ctx, t } = await loadTask(user, params.id);
  if (!ctx.staff) fail(403, 'Nur das Team');
  await DB.batch([
    q('UPDATE upload_links SET revoked_at = ? WHERE task_id = ? AND revoked_at IS NULL', now(), t.id),
    ev(ctx.c.id, user.id, 'upload_link.revoked', { task: t.title, task_id: t.id }, []),
  ]);
}

// Removes one version, e.g. a wrong file. The team may remove any; externals only their own latest, non-final one.
export async function deleteVersion({ user, params }) {
  const v = (await row(`SELECT v.*, d.case_id, d.title, d.visible_to, d.created_by, d.final FROM document_versions v JOIN documents d ON d.id = v.document_id
    WHERE v.id = ?`, params.id)) ?? fail(404, 'Datei nicht gefunden');
  const ctx = await caseCtx(user, v.case_id);
  if (!canSee(ctx, v)) fail(404, 'Datei nicht gefunden');
  const latest = await row('SELECT id FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1', v.document_id);
  if (!ctx.staff && (v.uploaded_by !== user.id || latest.id !== v.id || v.final)) fail(403, 'Nur eigene, aktuelle Fassungen');
  const { n } = await row('SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ?', v.document_id);
  await DB.batch([
    q('DELETE FROM document_signatures WHERE version_id = ?', v.id),
    q('DELETE FROM document_versions WHERE id = ?', v.id),
    ...(n === 1 ? [q('DELETE FROM documents WHERE id = ?', v.document_id)] : []),
    ev(ctx.c.id, user.id, 'document.version_deleted', { document: v.title, version: v.version }, arr(v.visible_to)),
  ]);
  await E.FILES.delete(v.r2_key);
}

export async function updateDocument({ user, params, body }) {
  const d = (await row('SELECT * FROM documents WHERE id = ?', params.id)) ?? fail(404, 'Dokument nicht gefunden');
  const ctx = await caseCtx(user, d.case_id);
  if (!ctx.staff) fail(canSee(ctx, d) ? 403 : 404, 'Keine Berechtigung');
  const visible = 'visible_to' in body ? roleList(body.visible_to) : arr(d.visible_to);
  const final = 'final' in body ? (body.final ? 1 : 0) : d.final;
  await DB.batch([
    q('UPDATE documents SET visible_to = ?, final = ? WHERE id = ?', JSON.stringify(visible), final, d.id),
    ev(d.case_id, user.id, 'document.updated', { document: d.title, final: !!final, visible_to: visible }, visible),
  ]);
}

// Files are only ever served through this permission check; the bucket is never public.
export async function download({ user, params }) {
  const v = (await row(`SELECT v.*, d.case_id, d.visible_to, d.created_by FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = ?`, params.id))
    ?? fail(404, 'Datei nicht gefunden');
  const ctx = await caseCtx(user, v.case_id);
  if (!canSee(ctx, v)) fail(404, 'Datei nicht gefunden');
  const obj = (await E.FILES.get(v.r2_key)) ?? fail(404, 'Datei nicht gefunden');
  return new Response(obj.body, {
    headers: {
      'content-type': v.content_type,
      'content-disposition': `${INLINE.includes(v.content_type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(v.filename)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}
