// Documents in a case: versions, sharing, upload, SHA-256 check.
import { change, cur, on, submit } from '../state.js';
import { api, dateTime, html, reload, sha256, shortHash } from '../lib.js';
import { caseApi, docTypeLabel, guestRoles, holders } from './case.js';
import { openTaskFor, taskTitle } from './tasks.js';
import { amountOf } from './finance.js';

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

export const fileLink = (v, label) => html`<a href="/api/files/${v.id}" target="_blank">${label}</a>`;

export const documents = d => html`${d.documents.length ? '' : html`<p class="muted small">Noch keine Dokumente.</p>`}
  ${d.documents.map(doc => html`<div class="doc">
    <div><b>${doc.title}</b>${doc.final ? html` <span class="tag approved">Endfassung</span>` : ''} <span class="muted small">${docTypeLabel(doc.doc_type)}</span></div>
    <ol class="versions">${doc.versions.map((v, i, all) => html`<li class="${i === all.length - 1 ? 'current' : ''}">
      ${fileLink(v, v.filename)} <span class="muted small">${v.uploader} · ${dateTime(v.created_at)}${taskTitle(v.task_id, d) ? ` · zu „${taskTitle(v.task_id, d)}“` : ''}</span>
      ${v.sha256 ? html`<button class="link small hash" data-on="copyHash" data-hash="${v.sha256}" title="SHA-256: ${v.sha256} – klicken zum Kopieren">SHA-256 ${shortHash(v.sha256)}</button>` : ''}
      ${d.me.staff || (v.mine && i === all.length - 1 && !doc.final) ? html` <button class="link small" data-on="deleteVersion" data-id="${v.id}" data-name="${v.filename}">löschen</button>` : ''}
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

submit.upload = async fd => {
  if (fd.get('amount')) {
    const cents = amountOf(fd);
    if (cents == null) return;
    fd.set('amount_cents', cents);
  }
  fd.delete('amount');
  await api(caseApi('/documents'), { body: fd });
  reload();
};
