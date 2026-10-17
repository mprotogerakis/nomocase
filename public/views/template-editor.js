// Template editor: roles, Angaben, document types, phases and steps as a form instead of JSON. It works on a copy of
// the latest version; saving creates the next version (the server checks it like any other). Everything the editor
// does not show (rules, forms, scales, money, labels …) stays in the definition untouched – the JSON view edits those.
import { ACCESS, FILE_KIND_LABELS, NEEDS_FILE } from '../shared/vocab.js';
import { change, input, me, on } from '../state.js';
import { ACCESS_LABELS, api, go, html, page, TYPES } from '../lib.js';

let tpl = null, draft = null;
const fresh = new WeakSet(); // items created here: their key still follows their name

const slug = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'neu';
const uniqueKey = (base, taken) => { let k = slug(base); while (taken.includes(k)) k += '-2'; return k; };
const stepKeys = () => draft.phases.flatMap(p => p.tasks.map(t => t.key));

// "phases.0.tasks.2" → the object or array at that place
const at = path => path.split('.').reduce((o, k) => o[k], draft);
const parentOf = path => { const parts = path.split('.'); return [at(parts.slice(0, -1).join('.')), parts.at(-1)]; };

export async function templateEditorView(id) {
  if (tpl?.id !== id) {
    tpl = (await api('/templates')).find(t => t.id === id) ?? null;
    draft = tpl && structuredClone(tpl.definition);
  }
  if (!tpl) return page(html`<main class="narrow"><p>Vorlage nicht gefunden.</p><a href="#/templates">Zu den Vorlagen</a></main>`);
  if (!me.workspaces.some(w => w.id === tpl.workspace_id && w.role === 'owner')) {
    return page(html`<main class="narrow"><p>Ändern können die Owner des Workspaces.</p><a href="#/templates">Zu den Vorlagen</a></main>`);
  }
  render();
}

// Re-render keeps the scroll position (structure changes: add, remove, move, deadline kind).
const render = () => { const y = scrollY; page(editor()); scrollTo(0, y); };

const text = (path, value, attrs = html``) => html`<input value="${value ?? ''}" data-input="tplSet" data-path="${path}" ${attrs}>`;
const select = (path, value, options, handler = 'tplSet') => html`<select data-change="${handler}" data-path="${path}">${options.map(([v, label]) =>
  html`<option value="${v}" ${String(value ?? '') === v ? 'selected' : ''}>${label}</option>`)}</select>`;
const tools = (path, i, n) => html`<span class="row tools">
  <button type="button" class="link" data-on="tplMove" data-path="${path}" data-i="${i}" data-dir="-1" ${i ? '' : 'disabled'} title="nach oben">↑</button>
  <button type="button" class="link" data-on="tplMove" data-path="${path}" data-i="${i}" data-dir="1" ${i < n - 1 ? '' : 'disabled'} title="nach unten">↓</button>
  <button type="button" class="link danger" data-on="tplRemove" data-path="${path}" data-i="${i}" title="entfernen">✕</button></span>`;

function editor() {
  const roles = draft.roles, dates = draft.fields.filter(f => f.type === 'date');
  const roleOptions = [['', '– zuständig –'], ...roles.map(r => [r.key, r.label])];
  const docOptions = [['', '– kein Dokument –'], ...draft.document_types.map(t => [t.key, t.label])];
  const titleOf = key => draft.phases.flatMap(p => p.tasks).find(t => t.key === key)?.title ?? key;
  const step = (t, pi, ti, n) => {
    const path = `phases.${pi}.tasks.${ti}`;
    const deadline = t.due_field ? `field:${t.due_field}` : t.due_days != null ? 'days' : '';
    const before = stepKeys().filter(k => k !== t.key);
    return html`<div class="step">
      <div class="row">${text(`${path}.title`, t.title, html`aria-label="Titel" class="grow" required`)}
        ${select(`${path}.type`, t.type, Object.entries(TYPES))} ${select(`${path}.role`, t.role, roleOptions)} ${tools(`phases.${pi}.tasks`, ti, n)}</div>
      <div class="row small">
        <label class="row">Frist ${select(`${path}`, deadline, [['', 'keine'], ['days', 'Tage ab Start'], ...dates.map(f => [`field:${f.key}`, `aus „${f.label}“`])], 'tplDeadline')}</label>
        ${deadline === 'days' ? html`<input type="number" min="0" max="3650" value="${t.due_days}" data-input="tplDays" data-path="${path}" aria-label="Tage" style="width:5em"> Tage` : ''}
        <label class="row">Dokument ${select(`${path}.doc_type`, t.doc_type, docOptions)}</label>
        ${before.length ? html`<label class="row">startet nach <select multiple size="${Math.min(3, before.length)}" data-change="tplAfter" data-path="${path}" aria-label="startet nach">
          ${before.map(k => html`<option value="${k}" ${(t.after ?? []).includes(k) ? 'selected' : ''}>${titleOf(k)}</option>`)}</select></label>` : ''}
      </div>
      ${NEEDS_FILE.includes(t.type) || t.doc_type ? html`<div class="row small">Dateien ${select(path, t.files?.multiple ? 'many' : '', [['', 'eine'], ['many', 'mehrere']], 'tplMultiple')}
        · erlaubt: ${Object.entries(FILE_KIND_LABELS).map(([k, label]) => html`<label><input type="checkbox" data-change="tplAccept" data-path="${path}" value="${k}"
          ${(t.files?.accept ?? []).includes(k) ? 'checked' : ''}> ${label}</label>`)} <span class="muted">(nichts angehakt: alle)</span></div>` : ''}
      <textarea rows="2" placeholder="Beschreibung für die Beteiligten (optional)" data-input="tplSet" data-path="${path}.description">${t.description ?? ''}</textarea>
      <div class="muted small">Schlüssel: <code>${t.key}</code>${t.assess || t.labels || t.money || t.form || t.visible_to ? ' · weitere Einstellungen in der JSON-Ansicht' : ''}</div>
    </div>`;
  };
  return html`<main class="template-editor">
    <p class="small"><a href="#/templates">← Vorlagen</a></p>
    <h1>${tpl.name} <span class="muted small">· ${tpl.workspace} · Version ${tpl.version}</span></h1>
    <p class="muted small">Speichern legt Version ${tpl.version + 1} an; laufende Vorgänge behalten ihre Version. Regeln, Formulare, Bewertung und
      Geldschritte bearbeiten Sie weiterhin in der JSON-Ansicht – sie bleiben hier unverändert erhalten.</p>

    <h2>Rollen</h2>
    ${roles.map((r, i) => html`<div class="row">${text(`roles.${i}.label`, r.label, html`aria-label="Rolle" required`)}
      ${select(`roles.${i}.access`, r.access, ACCESS.map(a => [a, ACCESS_LABELS[a]]))} <code class="muted small">${r.key}</code> ${tools('roles', i, roles.length)}</div>`)}
    <button type="button" class="link" data-on="tplAdd" data-path="roles">+ Rolle</button>

    <h2>Angaben</h2>
    ${draft.fields.map((f, i) => html`<div class="row">${text(`fields.${i}.label`, f.label, html`aria-label="Angabe" required`)}
      ${select(`fields.${i}.type`, f.type, [['', 'Text'], ['date', 'Datum']])} <code class="muted small">${f.key}</code> ${tools('fields', i, draft.fields.length)}</div>`)}
    <button type="button" class="link" data-on="tplAdd" data-path="fields">+ Angabe</button>

    <h2>Dokumenttypen</h2>
    ${draft.document_types.map((d, i) => html`<div class="row">${text(`document_types.${i}.label`, d.label, html`aria-label="Dokumenttyp" required`)}
      <span class="small muted">sichtbar für:</span> ${roles.filter(r => r.access !== 'case_owner' && r.access !== 'case_editor').map(r => html`<label class="small">
        <input type="checkbox" data-change="tplShare" data-path="document_types.${i}" value="${r.key}" ${(d.visible_to ?? []).includes(r.key) ? 'checked' : ''}> ${r.label}</label>`)}
      ${tools('document_types', i, draft.document_types.length)}</div>`)}
    <button type="button" class="link" data-on="tplAdd" data-path="document_types">+ Dokumenttyp</button>

    <h2>Ablauf</h2>
    ${draft.phases.map((p, pi) => html`<fieldset class="phase">
      <legend class="row">${text(`phases.${pi}.title`, p.title, html`aria-label="Phase" required`)} ${tools('phases', pi, draft.phases.length)}</legend>
      ${p.tasks.map((t, ti) => step(t, pi, ti, p.tasks.length))}
      <button type="button" class="link" data-on="tplAdd" data-path="phases.${pi}.tasks">+ Schritt</button>
    </fieldset>`)}
    <button type="button" class="link" data-on="tplAdd" data-path="phases">+ Phase</button>

    <div class="row editor-save"><button data-on="tplSave">Als Version ${tpl.version + 1} speichern</button>
      <button type="button" class="link" data-on="tplDiscard">Änderungen verwerfen</button></div>
  </main>`;
}

// Typing changes the draft only (no re-render, the cursor stays); a fresh item's key follows its name.
input.tplSet = change.tplSet = el => {
  const [obj, prop] = parentOf(el.dataset.path);
  const value = el.value;
  if (value === '' && prop !== 'title' && prop !== 'label') delete obj[prop]; else obj[prop] = value;
  if (el.tagName === 'SELECT' && (prop === 'type' || prop === 'doc_type')) render(); // file settings show for steps that take files
  if (fresh.has(obj) && obj.key && (prop === 'title' || prop === 'label')) {
    const isStep = el.dataset.path.startsWith('phases.');
    const list = isStep ? stepKeys() : (el.dataset.path.startsWith('roles.') ? draft.roles
      : el.dataset.path.startsWith('fields.') ? draft.fields : draft.document_types).map(x => x.key);
    const old = obj.key;
    obj.key = uniqueKey(value, list.filter(k => k !== old));
    if (isStep) for (const t of draft.phases.flatMap(ph => ph.tasks)) if (t.after?.includes(old)) t.after = t.after.map(k => (k === old ? obj.key : k));
  }
};
input.tplDays = el => { at(el.dataset.path).due_days = Math.max(0, Number(el.value) || 0); };
change.tplDeadline = el => {
  const t = at(el.dataset.path);
  delete t.due_days; delete t.due_field;
  if (el.value === 'days') t.due_days = 14;
  if (el.value.startsWith('field:')) t.due_field = el.value.slice(6);
  render();
};
change.tplAfter = el => {
  const t = at(el.dataset.path);
  const after = [...el.selectedOptions].map(o => o.value);
  if (after.length) t.after = after; else delete t.after;
};
// "files" of a step: several files or one, and the kinds it takes (none ticked: every kind); empty settings vanish.
const setFiles = (t, files) => { if (files.multiple || files.accept?.length) t.files = files; else delete t.files; };
change.tplMultiple = el => {
  const t = at(el.dataset.path);
  const { multiple, ...rest } = t.files ?? {};
  setFiles(t, el.value === 'many' ? { ...rest, multiple: true } : rest);
};
change.tplAccept = el => {
  const t = at(el.dataset.path);
  const accept = new Set(t.files?.accept ?? []);
  if (el.checked) accept.add(el.value); else accept.delete(el.value);
  const { accept: _, ...rest } = t.files ?? {};
  setFiles(t, accept.size ? { ...rest, accept: [...accept] } : rest);
};
change.tplShare = el => {
  const d = at(el.dataset.path);
  d.visible_to = el.checked ? [...new Set([...(d.visible_to ?? []), el.value])] : (d.visible_to ?? []).filter(v => v !== el.value);
};

on.tplMove = ({ path, i, dir }) => {
  const list = at(path), a = Number(i), b = a + Number(dir);
  [list[a], list[b]] = [list[b], list[a]];
  render();
};
on.tplRemove = ({ path, i }) => {
  const [item] = at(path).splice(Number(i), 1);
  // steps that waited for a removed step no longer do
  for (const key of path === 'phases' ? item.tasks.map(t => t.key) : [item.key]) {
    for (const t of draft.phases.flatMap(p => p.tasks)) if (t.after?.includes(key)) t.after = t.after.filter(k => k !== key);
  }
  render();
};
on.tplAdd = ({ path }) => {
  const list = at(path);
  const item = path === 'roles' ? { key: uniqueKey('rolle', draft.roles.map(r => r.key)), label: '', access: 'guest_contributor' }
    : path === 'fields' ? { key: uniqueKey('angabe', draft.fields.map(f => f.key)), label: '' }
    : path === 'document_types' ? { key: uniqueKey('dokument', draft.document_types.map(d => d.key)), label: '', visible_to: [] }
    : path === 'phases' ? { title: '', tasks: [] }
    : { key: uniqueKey('schritt', stepKeys()), title: '', type: 'task' };
  fresh.add(item);
  list.push(item);
  render();
};

on.tplSave = async () => {
  const { version } = await api(`/templates/${tpl.id}/versions`, { body: { definition: draft } });
  alert(`Gespeichert als Version ${version}. Laufende Vorgänge bleiben unverändert.`);
  tpl = null;
  go('#/templates');
};
on.tplDiscard = () => {
  if (!confirm('Alle Änderungen seit dem Öffnen verwerfen?')) return;
  draft = structuredClone(tpl.definition);
  render();
};
