// Documents: upload checks, versions in R2, upload links, downloads.
import { checkContent } from './validate.js';
import { readSignatures } from './pdfsig.js';
import { signatureEvents, signatureStmts } from './signatures.js';
import { acceptedExtensions, arr, CASE_CLOSED, DECISIONS, fail, FILE_KIND_LABELS, hex, NEEDS_FILE, readBody, roleList, sha256, token, uid } from './core.js';
import { canSee, canWork, caseCtx, taskAudience } from './access.js';
import { originOf } from './auth.js';
import { loadTask, markBlocked } from './tasks.js';
import { moneyStmts } from './finance.js';
import { sendMail } from './notify.js';
import { CONSENT_VERSION } from '../public/shared/consent.js';
import { compareForm, readUploadedForm } from './forms.js';
import { fieldStmts } from './cases.js';

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
// The request as a form, limited while it is read (one file per request plus a few fields).
export async function uploadForm(req) {
  const body = await readBody(req, MAX_UPLOAD + 64 * 1024, 'Datei zu groß (max. 20 MB)');
  return new Response(body, { headers: { 'content-type': req.headers.get('content-type') ?? '' } }).formData()
    .catch(() => fail(400, 'Ungültige Anfrage'));
}

export async function readUpload(file, strict, given) {
  if (!(file instanceof File) || !file.size) fail(400, 'Keine Datei');
  if (file.size > MAX_UPLOAD) fail(413, 'Datei zu groß (max. 20 MB)');
  const ext = file.name.split('.').pop().toLowerCase();
  const [contentType, magic] = FILE_TYPES[ext] ?? fail(415, 'Dateityp nicht erlaubt');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const keep = {}; // the PDF's dictionaries, for reading a form without walking the file again
  const problem = magic.some((b, i) => bytes[i] !== b) ? 'Der Dateiinhalt passt nicht zur Dateiendung.' : await checkContent(ext, bytes, { strict, keep });
  const sha256 = given ? (/^[0-9a-f]{64}$/.test(given) ? given : fail(400, 'Prüfsumme ungültig')) : hex(await crypto.subtle.digest('SHA-256', bytes));
  return { bytes, contentType, problem, filename: file.name.slice(0, 200), size: file.size, sha256, pdf: keep.pdf };
}

// Stores a checked file as the next version of `doc` (a row, or a new document to create) and completes the task
// it belongs to (decisions only get it attached). `actorId` is null and `label` set for uploads through a link or
// mails into the case (`channel: 'mail'`, `extra`: subject and attachment names for the log). `byTeam`: uploaded by the team.
// `rq`: the request context (core.js). `complete: false` keeps the task open (more files of a multi-file step follow). `uploadLink`: the link's token hash
// – the database stores the version only while that link is valid and its case and step are open (trigger, 0040/0041).
export async function storeVersion(rq, { c, actorId, uploadedBy, label = null, channel = null, extra = {}, f, task, doc, stmts = [], byTeam = false, complete = true, uploadLink = null }) {
  const { row, sql, batch, event, env, time } = rq;
  if (doc.isNew) {
    stmts.unshift(sql('INSERT INTO documents (id, case_id, title, doc_type, visible_to, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      doc.id, c.id, doc.title, doc.doc_type, JSON.stringify(doc.visible_to), uploadedBy, time));
  }
  const { n } = await row('SELECT COALESCE(MAX(version), 0) + 1 AS n FROM document_versions WHERE document_id = ?', doc.id);
  const versionId = uid();
  const key = `${c.workspace_id}/${c.id}/${doc.id}/${versionId}`;
  const completes = complete && task && task.status === 'open' && !task.blocked && !DECISIONS.includes(task.type);
  // Digital signatures inside PDFs: stored with the version; a signer who used another key before is logged.
  const sigs = f.contentType === 'application/pdf' ? await readSignatures(f.bytes, [], f.pdf) : [];
  // One of the case's forms, filled in: remembered with the version and compared with the case's fields. Values for
  // fields that are still empty go in directly when the team uploads; from anyone else they wait for the team (a grade
  // must not come from whoever filled in the PDF). Differences are logged and can trigger rules.
  // (callers pass different parts of the case row: definition and current fields are read here)
  const current = f.contentType === 'application/pdf' && await row('SELECT id, definition, fields FROM cases WHERE id = ?', c.id);
  const def = current && JSON.parse(current.definition);
  const form = current ? await readUploadedForm(def, f.pdf ?? f.bytes).catch(e => { console.error('form read', e.message); return null; }) : null;
  const check = form && compareForm(def, JSON.parse(current.fields), form);
  const taken = byTeam && check && Object.keys(check.missing).length ? fieldStmts(rq, current, def, check.missing, actorId, { from: doc.title }) : { changed: [], stmts: [] };
  // the file goes to storage after everything that reads it, and before the DB points at it
  await env.FILES.put(key, f.bytes, { httpMetadata: { contentType: f.contentType }, sha256: f.sha256 }).catch(e => {
    if (/sha-?256|checksum|digest/i.test(e.message)) fail(400, 'Die Datei kam unvollständig an (Prüfsumme stimmt nicht). Bitte erneut hochladen.');
    throw e;
  });
  stmts.push(
    sql('INSERT INTO document_versions (id, document_id, version, filename, content_type, size, r2_key, uploaded_by, created_at, task_id, uploader_label, sha256, form_values, upload_link) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      versionId, doc.id, n, f.filename, f.contentType, f.size, key, uploadedBy, time, task?.id ?? null, label, f.sha256, form ? JSON.stringify(form) : null, uploadLink),
    event(c.id, actorId, 'document.uploaded',
      { document: doc.title, version: n, filename: f.filename, version_id: versionId, sha256: f.sha256, ...(label && { via: label }), ...(channel && { channel }), ...extra,
        ...(task && { task: task.title, task_id: task.id, completed: completes }) },
      arr(doc.visible_to)), // who sees the document (team and uploader always): name, file and checksum are its metadata
    ...signatureStmts(rq, versionId, sigs),
    ...await signatureEvents(rq, c, versionId, doc, sigs, actorId),
    ...taken.stmts,
    ...(check?.differs.length ? [event(c.id, actorId, 'form.mismatch', { document: doc.title, version_id: versionId, form: form.title, fields: check.differs }, [])] : []),
  );
  if (completes) stmts.push(sql("UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ? WHERE id = ?", time, actorId, task.id));
  // no row points at the file if the batch fails (e.g. two uploads took the same version number): it must not stay behind
  await batch(stmts).catch(async e => {
    await env.FILES.delete(key).catch(e2 => console.error('R2 delete failed (the daily sweep retries)', key, e2.message));
    if (/UNIQUE constraint failed: document_versions/.test(e.message)) fail(409, 'Gerade kam eine andere Fassung dieses Dokuments an. Bitte noch einmal hochladen.');
    if (/upload link no longer valid/.test(e.message)) fail(410, 'Dieser Upload-Link gilt nicht mehr: widerrufen, abgelaufen, oder der Schritt bzw. Vorgang ist inzwischen abgeschlossen.');
    throw e;
  });
  return { document_id: doc.id, version: n, ...(form && { form: { title: form.title, differs: check.differs, taken: taken.changed.map(x => x.label) } }) };
}

// A step may take only certain kinds of files (template "files": { "accept": [...] }).
function checkKind(task, filename) {
  const exts = acceptedExtensions(task?.files);
  if (exts && !exts.includes(filename.split('.').pop().toLowerCase())) {
    fail(415, `Für „${task.title}“ bitte nur ${task.files.accept.map(k => FILE_KIND_LABELS[k]).join(' oder ')} hochladen.`);
  }
}

// Target document for an upload through a task: the existing one of the task's type (if the uploader may see it) or a new one.
async function taskDocument(rq, ctx, task, title, filename) {
  const { rows } = rq;
  const existing = task.doc_type && (await rows('SELECT * FROM documents WHERE case_id = ? AND doc_type = ? ORDER BY created_at', ctx.c.id, task.doc_type)).find(d => canSee(ctx, d));
  if (existing) return existing;
  const dt = ctx.def.document_types.find(t => t.key === task.doc_type);
  return { isNew: true, id: uid(), title: String(title || dt?.label || filename).slice(0, 200), doc_type: task.doc_type ?? null, visible_to: dt?.visible_to ?? [] };
}

export async function upload(rq) {
  const { req, user, params, row, event } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  if (ctx.access === 'guest_viewer') fail(403, 'Keine Upload-Berechtigung');
  if (ctx.c.status === 'closed') fail(409, CASE_CLOSED); // before the file is read; the database refuses it anyway
  const form = await uploadForm(req);
  const f = await readUpload(form.get('file'), !ctx.staff, form.get('sha256'));
  if (f.problem) {
    await event(ctx.c.id, user.id, 'upload.rejected', { filename: f.filename, note: f.problem }, []).run();
    fail(422, f.problem);
  }

  let task = null;
  if (form.get('task_id')) {
    ({ t: task } = await loadTask(rq, user, form.get('task_id')));
    if (task.case_id !== ctx.c.id) fail(400, 'Aufgabe gehört zu einem anderen Vorgang');
    if (!canWork(ctx, task) || task.status !== 'open' || task.blocked) fail(409, 'Aufgabe kann gerade nicht bearbeitet werden');
    checkKind(task, f.filename);
  }
  // A step that takes several files: each file is a document of its own; the last one ("more" not set) completes it.
  const several = !!task?.files?.multiple;

  // Target document: explicit new version > existing document of the task's type > new document.
  let doc;
  if (form.get('document_id')) {
    doc = await row('SELECT * FROM documents WHERE id = ? AND case_id = ?', form.get('document_id'), ctx.c.id);
    if (!doc || !canSee(ctx, doc)) fail(404, 'Dokument nicht gefunden');
    const last = await row('SELECT uploaded_by FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1', doc.id);
    if (!ctx.staff && (task || doc.final || last?.uploaded_by !== user.id)) fail(403, 'Neue Fassungen dieses Dokuments bitte über die passende Aufgabe hochladen.');
  } else if (task && several) {
    const dt = ctx.def.document_types.find(t => t.key === task.doc_type);
    doc = { isNew: true, id: uid(), title: f.filename.slice(0, 200), doc_type: task.doc_type ?? null, visible_to: dt?.visible_to ?? [] };
  } else if (task) {
    doc = await taskDocument(rq, ctx, task, form.get('title'), f.filename);
  } else {
    const docType = form.get('doc_type') || null;
    const dt = ctx.def.document_types.find(t => t.key === docType);
    if (docType && !dt) fail(400, 'Unbekannter Dokumenttyp');
    // otherwise a guest could create the document a later team upload of that type lands in, and read it
    if (!ctx.staff && dt && !dt.visible_to.some(v => v === '*' || v === ctx.role)) fail(403, 'Dokumente dieses Typs legt das Team an.');
    doc = { isNew: true, id: uid(), title: String(form.get('title') || dt?.label || f.filename).slice(0, 200), doc_type: docType, visible_to: dt?.visible_to ?? [] };
  }
  const stmts = task ? await moneyStmts(rq, ctx, user, task, form.get('amount_cents')) : [];
  return storeVersion(rq, { c: ctx.c, actorId: user.id, uploadedBy: user.id, f, task, doc, stmts, byTeam: ctx.staff,
    complete: !(several && form.get('more') === '1') });
}

// Spec 4.2 variant B: someone without an account (a practice, a workshop) uploads a file for exactly one task.
// The link grants nothing else: no view of the case, the strict upload rules, single use by default, expires.

export async function createUploadLink(rq) {
  const { user, params, body, url, sql, batch, event, env, time } = rq;
  const { ctx, t } = await loadTask(rq, user, params.id);
  if (!ctx.staff) fail(403, 'Nur das Team erzeugt Upload-Links');
  if (!t.doc_type && !NEEDS_FILE.includes(t.type)) fail(400, 'Diese Aufgabe erwartet keine Datei');
  if (t.status !== 'open') fail(409, 'Die Aufgabe ist nicht offen');
  const label = String(body.label ?? '').trim().slice(0, 80) || fail(400, 'Bitte angeben, wer hochlädt');
  const days = Math.min(Math.max(Math.round(Number(body.days) || 14), 1), 60);
  const email = String(body.email ?? '').trim().toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'E-Mail ungültig');
  const secret = token();
  await batch([
    sql('INSERT INTO upload_links (token_hash, case_id, task_id, label, created_by, created_at, expires_at, single_use) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      await sha256(secret), ctx.c.id, t.id, label, user.id, time, new Date(Date.now() + days * 864e5).toISOString(), body.single_use === false ? 0 : 1),
    event(ctx.c.id, user.id, 'upload_link.created', { task: t.title, task_id: t.id, label, days }, []),
  ]);
  const link = `${originOf(rq, url)}/#/upload/${secret}`;
  const sent = email ? await sendMail(rq, email, `Bitte Datei bereitstellen: ${t.title}`, [
    'Guten Tag,',
    `${user.name} bittet Sie, für „${t.title}“ eine Datei bereitzustellen. Eine Anmeldung ist nicht nötig:\n${link}`,
    `Der Link ist ${days} Tage gültig${body.single_use === false ? '' : ' und funktioniert für eine Datei'}. Erlaubt sind PDF, Bilder (PNG, JPG), Word, Excel, OpenDocument und Text bis 20 MB.`,
  ], { replyTo: user.email, sender: user.id }) : false;
  return sent && !env.DEV_LOGIN ? { sent } : { sent, link };
}

async function loadUploadLink(rq, secret) {
  const { row, time } = rq;
  return (await row(`SELECT l.*, t.title AS task_title, t.doc_type, t.type AS task_type, t.status AS task_status, t.files AS task_files, u.name AS requester, c.definition, c.workspace_id
    FROM upload_links l JOIN tasks t ON t.id = l.task_id JOIN users u ON u.id = l.created_by JOIN cases c ON c.id = l.case_id
    WHERE l.token_hash = ? AND l.revoked_at IS NULL AND l.expires_at > ? AND (l.single_use = 0 OR l.used_at IS NULL)
      AND t.status = 'open' AND c.status = 'open'`, await sha256(String(secret ?? '')), time))
    ?? fail(404, 'Dieser Upload-Link ist ungültig, abgelaufen oder wurde schon benutzt.');
}

// What the person behind the link sees: who asks, for what. Nothing about the case.
// The link's step as it stands: waiting for an earlier step, the link cannot be used yet.
async function linkTask(rq, l) {
  const { rows } = rq;
  const task = markBlocked(await rows('SELECT * FROM tasks WHERE case_id = ?', l.case_id)).find(t => t.id === l.task_id);
  if (task.blocked) fail(409, 'Dieser Schritt wartet noch auf einen vorherigen. Bitte später erneut versuchen.');
  return task;
}

export async function getUploadLink(rq) {
  const { body } = rq;
  const l = await loadUploadLink(rq, body.token);
  await linkTask(rq, l);
  const dt = JSON.parse(l.definition).document_types.find(t => t.key === l.doc_type);
  return { requester: l.requester, label: l.label, task: l.task_title, document: dt?.label ?? null, expires_at: l.expires_at,
    files: l.task_files ? JSON.parse(l.task_files) : null };
}

export async function useUploadLink(rq) {
  const { req, row, sql, event, time } = rq;
  const form = await uploadForm(req);
  const l = await loadUploadLink(rq, form.get('token'));
  if (form.get('consent') !== 'yes') fail(400, 'Bitte stimmen Sie der Verarbeitung zu – oder schicken Sie die Datei auf dem bisherigen Weg per E-Mail.');
  const f = await readUpload(form.get('file'), true, form.get('sha256'));
  if (f.problem) { // logged for the team; the link stays usable for a corrected file
    await event(l.case_id, null, 'upload.rejected', { filename: f.filename, note: f.problem, via: l.label }, []).run();
    fail(422, f.problem);
  }
  const task = await linkTask(rq, l);
  checkKind(task, f.filename); // before the link is used up: a wrong kind of file or a final document leave it usable
  const def = JSON.parse(l.definition);
  const c = { id: l.case_id, workspace_id: l.workspace_id };
  // Acts like the team member who sent the link would see it, but the version is labelled with who really uploaded.
  const ctx = { c, def, user: { id: l.created_by }, role: null, staff: true };
  const doc = await taskDocument(rq, ctx, task, null, f.filename);
  if (doc.final) fail(410, 'Dieses Dokument ist bereits als Endfassung markiert.');
  if (l.single_use && !(await row('UPDATE upload_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL RETURNING token_hash', time, l.token_hash))) {
    fail(404, 'Dieser Upload-Link wurde gerade schon benutzt.');
  }
  try {
    await storeVersion(rq, { c, actorId: null, uploadedBy: l.created_by, label: l.label, f, task, doc, extra: { consent: CONSENT_VERSION }, uploadLink: l.token_hash });
  } catch (e) { // nothing was stored: a single-use link stays usable for another try
    if (l.single_use) await sql('UPDATE upload_links SET used_at = NULL WHERE token_hash = ?', l.token_hash).run();
    throw e;
  }
  return { ok: true };
}

export async function revokeUploadLinks(rq) {
  const { user, params, sql, batch, event, time } = rq;
  const { ctx, t } = await loadTask(rq, user, params.id);
  if (!ctx.staff) fail(403, 'Nur das Team');
  await batch([
    sql('UPDATE upload_links SET revoked_at = ? WHERE task_id = ? AND revoked_at IS NULL', time, t.id),
    event(ctx.c.id, user.id, 'upload_link.revoked', { task: t.title, task_id: t.id }, []),
  ]);
}

// Removes one version, e.g. a wrong file. The team may remove any; externals only their own latest, non-final one.
export async function deleteVersion(rq) {
  const { user, params, row, sql, batch, event, env } = rq;
  const v = (await row(`SELECT v.*, d.case_id, d.title, d.visible_to, d.created_by, d.final FROM document_versions v JOIN documents d ON d.id = v.document_id
    WHERE v.id = ?`, params.id)) ?? fail(404, 'Datei nicht gefunden');
  const ctx = await caseCtx(rq, user, v.case_id);
  if (!canSee(ctx, v)) fail(404, 'Datei nicht gefunden');
  const latest = await row('SELECT id FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1', v.document_id);
  if (!ctx.staff && (v.uploaded_by !== user.id || latest.id !== v.id || v.final)) fail(403, 'Nur eigene, aktuelle Fassungen');
  const { n } = await row('SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ?', v.document_id);
  await batch([
    sql('DELETE FROM document_signatures WHERE version_id = ?', v.id),
    sql('DELETE FROM document_versions WHERE id = ?', v.id),
    ...(n === 1 ? [sql('DELETE FROM documents WHERE id = ?', v.document_id)] : []),
    event(ctx.c.id, user.id, 'document.version_deleted', { document: v.title, version: v.version }, arr(v.visible_to)),
  ]);
  await env.FILES.delete(v.r2_key).catch(e => console.error('R2 delete failed (the daily sweep retries)', v.r2_key, e.message));
}

// Files without a version in the DB: a delete that failed after the rows were gone (case deletion, a version, a failed
// upload), or an upload whose DB write never happened (Worker stopped in between). Daily; only files older than a
// day, younger ones may belong to an upload still in progress.
export async function sweepOrphanFiles(rq) {
  const { rows, env } = rq;
  const before = Date.now() - 864e5;
  let cursor, removed = 0;
  do {
    const page = await env.FILES.list({ cursor, limit: 1000 });
    const old = page.objects.filter(o => o.uploaded.getTime() < before).map(o => o.key);
    const known = new Set((await rows('SELECT r2_key FROM document_versions WHERE r2_key IN (SELECT value FROM json_each(?))', JSON.stringify(old))).map(r => r.r2_key));
    const orphans = old.filter(k => !known.has(k));
    if (orphans.length) await env.FILES.delete(orphans);
    removed += orphans.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (removed) console.log('orphaned files removed', removed);
}

export async function updateDocument(rq) {
  const { user, params, body, row, sql, batch, event } = rq;
  const d = (await row('SELECT * FROM documents WHERE id = ?', params.id)) ?? fail(404, 'Dokument nicht gefunden');
  const ctx = await caseCtx(rq, user, d.case_id);
  if (!ctx.staff) fail(canSee(ctx, d) ? 403 : 404, 'Keine Berechtigung');
  const visible = 'visible_to' in body ? roleList(body.visible_to) : arr(d.visible_to);
  const final = 'final' in body ? (body.final ? 1 : 0) : d.final;
  await batch([
    sql('UPDATE documents SET visible_to = ?, final = ? WHERE id = ?', JSON.stringify(visible), final, d.id),
    event(d.case_id, user.id, 'document.updated', { document: d.title, final: !!final, visible_to: visible }, visible),
  ]);
}

// Files are only ever served through this permission check; the bucket is never public.
export async function download(rq) {
  const { user, params, row, env } = rq;
  const v = (await row(`SELECT v.*, d.case_id, d.visible_to, d.created_by FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = ?`, params.id))
    ?? fail(404, 'Datei nicht gefunden');
  const ctx = await caseCtx(rq, user, v.case_id);
  if (!canSee(ctx, v)) fail(404, 'Datei nicht gefunden');
  const obj = (await env.FILES.get(v.r2_key)) ?? fail(404, 'Datei nicht gefunden');
  return new Response(obj.body, {
    headers: {
      'content-type': v.content_type,
      'content-disposition': `${INLINE.includes(v.content_type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(v.filename)}`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  });
}
