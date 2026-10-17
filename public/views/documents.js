// Documents in a case: versions, sharing, upload, SHA-256 check.
import { change, cur, me, on, submit } from '../state.js';
import { api, date, dateTime, html, reload, sha256, shortHash } from '../lib.js';
import { caseApi, docTypeLabel, guestRoles, holders } from './case.js';
import { openTaskFor, taskTitle } from './tasks.js';
import { amountOf } from './finance.js';
import { mailAttachments } from '../shared/mime.js';

on.copyHash = async ({ hash }, el) => { await navigator.clipboard.writeText(hash); el.textContent = 'SHA-256 kopiert'; };

// Compare a local file with the stored versions by SHA-256 (nothing is uploaded).
change.verifyFile = async el => {
  const file = el.files[0];
  if (!file) return;
  const h = await sha256(file);
  const hit = cur.documents.flatMap(doc => doc.versions.map(v => ({ doc, v }))).find(x => x.v.sha256 === h);
  el.closest('.verify').querySelector('output').textContent = hit
    ? `✓ identisch mit „${hit.doc.title}“ v${hit.v.version} (${hit.v.filename}), hochgeladen ${dateTime(hit.v.created_at)} von ${hit.v.uploader}`
    : `✗ keine gespeicherte Fassung hat diese Prüfsumme (SHA-256 ${shortHash(h)})`;
};

export const verifyFile = () => html`<details class="verify small"><summary class="muted">Datei abgleichen</summary>
  <p class="muted">Prüft per SHA-256, ob eine Datei auf Ihrem Gerät genau einer gespeicherten Fassung entspricht. Die Datei wird nicht hochgeladen.</p>
  <input type="file" data-change="verifyFile"> <output></output></details>`;

// Digital signatures in a version: who signed, and whether it is the key that person used before.
// Recognition, not legal validity: a known key means "same signer as before".
const SIG_ICON = { known: '✓', trusted: '✓', changed: '⚠', unknown: '?', invalid: '✗', unsupported: '·', timestamp: '·' };
function signatureLine(s, d, last) {
  const when = s.signed_at ? ` · ${dateTime(s.signed_at)}` : '';
  const text = {
    known: `digital signiert von ${s.signer}${when} · Schlüssel bekannt seit ${date(s.since)}${s.vouched_by ? `, bestätigt von ${s.vouched_by}` : ''}`,
    trusted: `digital signiert von ${s.signer}${when} · Zertifikat von ${s.trusted_issuer} (vertrauenswürdig)`,
    changed: `andere Signatur als bisher: ${s.candidate} signiert mit einem neuen Schlüssel${when}`,
    unknown: `digital signiert: ${s.subject_name ?? '?'}${s.subject_email ? ` (${s.subject_email})` : ''}${when} · ${s.self_signed ? 'selbst ausgestelltes Zertifikat' : `Zertifikat von ${s.issuer_name}`} · noch niemandem zugeordnet`,
    invalid: `Signatur ungültig: ${s.detail}`,
    unsupported: `Signatur nicht prüfbar (${s.detail})`,
    timestamp: 'Zeitstempel',
  }[s.state];
  const changedAfter = s.status === 'valid' && !s.covers_all && last ? ' · ⚠ danach wurde die Datei verändert' : '';
  const open = ['unknown', 'changed'].includes(s.state);
  const people = d.participants.filter(p => !p.revoked_at);
  return html`<div class="sig ${s.state}">${SIG_ICON[s.state]} ${text}${changedAfter}
    ${open && s.candidate_id === me.user.id && s.subject_email?.toLowerCase() === me.user.email.toLowerCase() ? html`<button class="link" data-on="claimSig" data-version="${s.version_id}" data-position="${s.position}">Das ist meine Signatur</button>` : ''}
    ${open && d.me.owner && people.length ? html`<select data-change="assignSig" data-version="${s.version_id}" data-position="${s.position}" aria-label="Signatur zuordnen">
      <option value="">zuordnen …</option>${people.map(p => html`<option value="${p.user_id}">${p.name}</option>`)}</select>` : ''}</div>`;
}
const signatures = (v, d) => (v.signatures?.length ? html`<div class="sigs">${v.signatures.map((s, i, all) => signatureLine(s, d, i === all.length - 1))}</div>` : '');

on.claimSig = async ({ version, position }) => { await api('/signatures/claim', { body: { version_id: version, position: Number(position) } }); reload(); };
change.assignSig = async el => {
  if (!el.value) return;
  await api('/signatures/assign', { body: { version_id: el.dataset.version, position: Number(el.dataset.position), user_id: el.value } });
  reload();
};

// What an uploaded form says against the case's current fields (team, latest version): differences and values for
// empty fields, each with a button to take the form's value into the Angaben.
const plain = s => String(s ?? '').replace(/\s+/g, ' ').trim();
export function formCheck(v, d) {
  if (!v.form || !d.me.staff) return '';
  const field = k => d.definition.fields.find(f => f.key === k);
  const shown = (k, val) => (field(k)?.type === 'date' && /^\d{4}-\d\d-\d\d$/.test(val) ? date(val) : val);
  const usable = (k, val) => field(k)?.type !== 'date' || /^\d{4}-\d\d-\d\d$/.test(val);
  const take = (k, val, label) => (usable(k, val) ? html` <button class="link" data-on="takeFormValue" data-key="${k}" data-value="${val}">${label}</button>` : '');
  const cur = d.case.fields;
  const entries = Object.entries(v.form.fields);
  // a field changed in the Angaben after this upload (e.g. the new deadline after an extension) was changed on purpose
  const changedSince = k => d.events.some(e => e.type === 'case.fields_updated' && e.created_at > v.created_at && e.payload.fields.includes(field(k)?.label));
  const differs = entries.filter(([k, val]) => plain(cur[k]) && plain(cur[k]) !== plain(val) && !changedSince(k));
  const missing = entries.filter(([k]) => !plain(cur[k]));
  if (!differs.length && !missing.length) return html`<div class="small muted">Formular „${v.form.title}“: passt zu den Angaben.</div>`;
  return html`<div class="small formcheck">Formular „${v.form.title}“:
    ${differs.map(([k, val]) => html`<div class="warn">${field(k)?.label ?? k} weicht ab – im Formular „${shown(k, val)}“, in den Angaben „${shown(k, cur[k])}“${take(k, val, 'Angaben anpassen')}</div>`)}
    ${missing.map(([k, val]) => html`<div>${field(k)?.label ?? k} steht im Formular („${shown(k, val)}“), in den Angaben noch nicht.${take(k, val, 'übernehmen')}</div>`)}
  </div>`;
}
on.takeFormValue = async ({ key, value }) => { await api(caseApi('/fields'), { method: 'PATCH', body: { fields: { [key]: value } } }); reload(); };

// After an upload: what the server noticed in a form (also for the uploader outside the team, names of fields only).
export function formNotice(res) {
  const f = res?.form;
  const lines = [f?.taken.length && `In die Angaben übernommen: ${f.taken.join(', ')}.`,
    f?.differs.length && `Achtung: Im Formular „${f.title}“ weicht von den Angaben des Vorgangs ab: ${f.differs.join(', ')}. Bitte prüfen.`].filter(Boolean);
  if (lines.length) alert(lines.join('\n'));
}

// A stored mail's attachments become documents of the case: read in the browser (no Worker CPU for big mails), each
// one an ordinary upload with all checks (content, signatures, forms); files already in the case are skipped.
on.mailAttachments = async ({ id }) => {
  const parts = mailAttachments(new Uint8Array(await (await fetch(`/api/files/${id}`)).arrayBuffer()));
  if (!parts.length) return alert('Diese E-Mail hat keine Anhänge.');
  const have = new Set(cur.documents.flatMap(d => d.versions.map(v => v.sha256)).filter(Boolean));
  const lines = [];
  for (const p of parts) {
    const file = new File([p.bytes], p.filename, { type: p.contentType });
    if (have.has(await sha256(file))) { lines.push(`• ${p.filename}: schon im Vorgang`); continue; }
    const fd = new FormData();
    fd.append('file', file);
    try {
      await api(caseApi('/documents'), { body: fd, quiet: true });
      lines.push(`• ${p.filename}: übernommen`);
    } catch (e) { lines.push(`• ${p.filename}: nicht übernommen – ${e.message}`); }
  }
  alert(`Anhänge der E-Mail (nur für das Team sichtbar, wie die E-Mail):\n${lines.join('\n')}`);
  reload();
};

export const fileLink = (v, label) => html`<a href="/api/files/${v.id}" target="_blank">${label}</a>`;

export const documents = d => html`${d.documents.length ? '' : html`<p class="muted small">Noch keine Dokumente.</p>`}
  ${d.documents.map(doc => html`<div class="doc">
    <div><b>${doc.title}</b>${doc.final ? html` <span class="tag approved">Endfassung</span>` : ''} <span class="muted small">${docTypeLabel(doc.doc_type)}</span></div>
    <ol class="versions">${doc.versions.map((v, i, all) => html`<li class="${i === all.length - 1 ? 'current' : ''}">
      ${fileLink(v, v.filename)} <span class="muted small">${v.uploader} · ${dateTime(v.created_at)}${taskTitle(v.task_id, d) ? ` · zu „${taskTitle(v.task_id, d)}“` : ''}</span>
      ${v.sha256 ? html`<button class="link small hash" data-on="copyHash" data-hash="${v.sha256}" title="SHA-256: ${v.sha256} – klicken zum Kopieren">SHA-256 ${shortHash(v.sha256)}</button>` : ''}
      ${d.me.staff || (v.mine && i === all.length - 1 && !doc.final) ? html` <button class="link small" data-on="deleteVersion" data-id="${v.id}" data-name="${v.filename}">löschen</button>` : ''}
      ${signatures(v, d)}
      ${i === all.length - 1 ? formCheck(v, d) : ''}
      ${d.me.staff && i === all.length - 1 && v.content_type === 'message/rfc822' ? html`<div class="small"><button class="link" data-on="mailAttachments" data-id="${v.id}">Anhänge als Dokumente übernehmen</button></div>` : ''}
    </li>`)}</ol>
    ${d.me.staff ? html`<div class="row small">
      ${guestRoles(d).length ? html`Freigegeben für:
        ${guestRoles(d).map(r => html`<label><input type="checkbox" data-change="share" data-id="${doc.id}" value="${r.key}" ${doc.visible_to.includes(r.key) || doc.visible_to.includes('*') ? 'checked' : ''}> ${r.label} (${String(holders(d, r.key).length)})</label>`)}
        <span class="muted">· Team sieht alles</span>` : ''}
      <button class="link push" data-on="final" data-id="${doc.id}" data-final="${doc.final ? '' : '1'}">${doc.final ? 'Endfassung aufheben' : 'Als Endfassung markieren'}</button>
    </div>` : ''}
    ${doc.can_version && !openTaskFor(doc, d) ? html`<details class="add"><summary>neue Fassung</summary><form data-submit="upload" class="row small">
      <input type="hidden" name="document_id" value="${doc.id}"><input type="file" name="file" required><button>Hochladen</button>
    </form></details>` : ''}
  </div>`)}
  ${d.me.can_upload ? html`<details class="add"><summary>+ Dokument</summary><form data-submit="upload" class="stack small">
    <input type="file" name="file" required>
    <div class="row">
      <input name="title" placeholder="Titel (optional)">
      <select name="doc_type"><option value="">– Dokumenttyp –</option>${d.definition.document_types.map(t => html`<option value="${t.key}">${t.label}</option>`)}</select>
    </div>
    <button>Hochladen</button>
  </form></details>` : ''}`;

on.deleteVersion = async ({ id, name }) => {
  if (!confirm(`„${name}“ endgültig löschen? Die Datei wird entfernt, im Verlauf bleibt nur ein Hinweis.`)) return;
  await api(`/document-versions/${id}`, { method: 'DELETE' });
  reload();
};

on.final = async ({ id, final }) => { await api(`/documents/${id}`, { method: 'PATCH', body: { final: !!final } }); reload(); };

change.share = async el => {
  const boxes = document.querySelectorAll(`[data-change="share"][data-id="${el.dataset.id}"]`);
  await api(`/documents/${el.dataset.id}`, { method: 'PATCH', body: { visible_to: [...boxes].filter(b => b.checked).map(b => b.value) } });
  reload();
};

// The chosen files one request each (each within the Worker's CPU budget); a multi-file step completes with the last
// one ("more" on the others), and an amount goes with the last one only.
export async function uploadFiles(fd) {
  const files = fd.getAll('file').filter(f => f.size);
  for (const [i, file] of files.entries()) {
    const one = new FormData();
    for (const [k, v] of fd) if (k !== 'file' && (k !== 'amount_cents' || i === files.length - 1)) one.append(k, v);
    one.append('file', file);
    if (i < files.length - 1) one.append('more', '1');
    formNotice(await api(caseApi('/documents'), { body: one }));
  }
}

submit.upload = async fd => {
  if (fd.get('amount')) {
    const cents = amountOf(fd);
    if (cents == null) return;
    fd.set('amount_cents', cents);
  }
  fd.delete('amount');
  await uploadFiles(fd);
  reload();
};
