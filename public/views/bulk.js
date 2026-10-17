// Many cases from one template at once (e.g. all theses at the start of term): paste a table, check the preview,
// create. Each case and each invitation is an ordinary request, so the usual checks and limits apply; the result is
// listed per line and stays visible after the overview reloads.
import { change, input, on, submit, templates } from '../state.js';
import { api, esc, html, reload } from '../lib.js';
import { parseTable } from '../shared/bulk.js';

let results = null; // after a run: [{ line, title, id?, invited?, error? }]

const guestRoles = t => t.definition.roles.filter(r => r.access.startsWith('guest_'));
const chosen = () => templates.find(t => t.id === document.querySelector('#bulk [name=template_id]')?.value);

export const bulkForm = tpls => (tpls.length ? html`<details class="add" ${results ? 'open' : ''}><summary>+ Mehrere aus Tabelle</summary>
  <form data-submit="bulkCreate" id="bulk" class="stack card">
    ${results ? resultList() : ''}
    <select name="template_id" data-change="bulkTemplate" required aria-label="Vorlage">
      <option value="">Vorlage wählen…</option>
      ${Object.entries(Object.groupBy(tpls, t => t.workspace)).map(([ws, ts]) => html`<optgroup label="${ws}">${ts.map(t => html`<option value="${t.id}">${t.name}</option>`)}</optgroup>`)}
    </select>
    <div id="bulk-help" class="small"></div>
    <textarea name="table" rows="6" data-input="bulkPreview" aria-label="Tabelle"
      placeholder="Aus Excel oder einer Liste kopieren: erste Zeile die Spaltennamen, dann eine Zeile je Vorgang"></textarea>
    <div id="bulk-preview" class="small"></div>
    <button>Vorgänge anlegen</button>
  </form>
</details>` : '');

function resultList() {
  const ok = results.filter(r => r.id).length;
  return html`<div class="small"><b>${ok} von ${results.length} Vorgängen angelegt.</b>
    <button type="button" class="link" data-on="bulkDismiss">ausblenden</button>
    <ul class="list">${results.map(r => html`<li>${r.id ? html`✓ <a href="#/case/${r.id}">${r.title}</a>` : html`<span class="warn">✗ Zeile ${r.line}: ${r.error}</span>`}
      ${r.invited ? html` <span class="muted">· eingeladen: ${r.invited}</span>` : ''}${r.inviteError ? html` <span class="warn">· Einladung: ${r.inviteError}</span>` : ''}</li>`)}</ul></div>`;
}

on.bulkDismiss = () => { results = null; reload(); };

change.bulkTemplate = () => {
  const t = chosen();
  const roles = t ? guestRoles(t) : [];
  document.getElementById('bulk-help').innerHTML = esc(t ? html`Spalten: <code>Titel</code> (sonst „${t.name} – Name“), <code>E-Mail</code>${t.definition.fields.map(f => html`, <code>${f.label}</code>`)}.
    Daten als 31.12.2026.
    ${roles.length ? html`<label class="row">Mit E-Mail einladen als <select name="role">${roles.map((r, i) => html`<option value="${r.key}" ${i ? '' : 'selected'}>${r.label}</option>`)}
      <option value="">– nicht einladen –</option></select></label>` : ''}` : html``);
  input.bulkPreview(document.querySelector('#bulk [name=table]'));
};

input.bulkPreview = el => {
  const t = chosen();
  const box = document.getElementById('bulk-preview');
  if (!t || !el.value.trim()) { box.innerHTML = ''; return; }
  const { unknown, rows } = parseTable(el.value, t.definition, t.name);
  const bad = rows.filter(r => r.problems.length);
  box.innerHTML = esc(html`<p>${rows.length} ${rows.length === 1 ? 'Vorgang' : 'Vorgänge'}${rows.some(r => r.email) ? `, ${rows.filter(r => r.email).length} mit E-Mail` : ''}
    ${unknown.length ? html` · <span class="warn">unbekannte Spalten (werden ignoriert): ${unknown.join(', ')}</span>` : ''}</p>
    <table class="preview"><tr><th>Zeile</th><th>Titel</th><th>E-Mail</th><th>Angaben</th><th></th></tr>
    ${rows.slice(0, 50).map(r => html`<tr class="${r.problems.length ? 'warn' : ''}"><td>${r.line}</td><td>${r.title}</td><td>${r.email}</td>
      <td>${Object.entries(r.fields).map(([k, v]) => `${t.definition.fields.find(f => f.key === k).label}: ${v}`).join(' · ')}</td><td>${r.problems.join(', ')}</td></tr>`)}</table>
    ${rows.length > 50 ? html`<p class="muted">… und ${rows.length - 50} weitere</p>` : ''}
    ${bad.length ? html`<p class="warn">Bitte erst ${bad.length === 1 ? 'die markierte Zeile' : `die ${bad.length} markierten Zeilen`} korrigieren.</p>` : ''}`);
};

submit.bulkCreate = async fd => {
  const t = chosen();
  const { rows } = parseTable(fd.get('table'), t.definition, t.name);
  if (!rows.length) return alert('Bitte eine Tabelle mit Spaltennamen und mindestens einer Zeile einfügen.');
  if (rows.some(r => r.problems.length)) return alert('Bitte erst die markierten Zeilen korrigieren.');
  if (!confirm(`${rows.length} Vorgänge aus „${t.name}“ anlegen${fd.get('role') && rows.some(r => r.email) ? ' und die Personen einladen' : ''}?`)) return;
  results = [];
  for (const r of rows) {
    const out = { line: r.line, title: r.title };
    try {
      out.id = (await api('/cases', { body: { template_id: t.id, title: r.title, fields: r.fields }, quiet: true })).id;
      if (r.email && fd.get('role')) {
        try {
          await api(`/cases/${out.id}/invitations`, { body: { email: r.email, role: fd.get('role') }, quiet: true });
          out.invited = r.email;
        } catch (e) { out.inviteError = e.message; }
      }
    } catch (e) { out.error = e.message; }
    results.push(out);
  }
  reload();
};
