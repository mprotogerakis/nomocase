// Template editor: roles, Angaben, document types, phases and steps, PDF forms and rules as a form instead of JSON. It
// works on a copy of the latest version; saving creates the next version (the server checks it like any other).
// Everything the editor does not show (scales, money, labels …) stays in the definition untouched – the JSON view edits those.
import { ACCESS, FILE_KIND_LABELS, NEEDS_FILE, RULE_ACTION_LABELS, RULE_FIELD_LABELS, RULE_MONEY_FIELDS, RULE_OP_LABELS, RULE_TRIGGER_LABELS } from '../shared/vocab.js';
import { change, input, me, on } from '../state.js';
import { ACCESS_LABELS, api, go, html, page, plainEur, toCents, TYPES } from '../lib.js';
import { previewForm } from './admin.js';

let tpl = null, draft = null, wsTemplates = [];
const fresh = new WeakSet(); // items created here: their key still follows their name

const slug = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'neu';
const uniqueKey = (base, taken) => { let k = slug(base); while (taken.includes(k)) k += '-2'; return k; };
const stepKeys = () => draft.phases.flatMap(p => p.tasks.map(t => t.key));
// steps a rule creates share the key space with the template's steps
const ruleTaskKeys = () => draft.rules.flatMap(r => r.actions).filter(a => a.type === 'create_task' && a.key).map(a => a.key);

// "phases.0.tasks.2" → the object or array at that place
const at = path => path.split('.').reduce((o, k) => o[k], draft);
const parentOf = path => { const parts = path.split('.'); return [at(parts.slice(0, -1).join('.')), parts.at(-1)]; };

export async function templateEditorView(id) {
  if (tpl?.id !== id) {
    const all = await api('/templates');
    tpl = all.find(t => t.id === id) ?? null;
    draft = tpl && structuredClone(tpl.definition);
    if (draft) { draft.rules ??= []; draft.forms ??= []; }
    wsTemplates = all.filter(t => t.workspace_id === tpl?.workspace_id && !t.archived_at).map(t => t.name); // sub-case templates
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
        ${draft.forms.length ? html`<label class="row">Formular ${select(`${path}.form`, t.form, [['', '– keins –'], ...draft.forms.map(f => [f.key, f.title || f.key])])}</label>` : ''}
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

    ${formsSection()}

    ${rulesSection()}

    <div class="row editor-save"><button data-on="tplSave">Als Version ${tpl.version + 1} speichern</button>
      <button type="button" class="link" data-on="tplDiscard">Änderungen verwerfen</button></div>
  </main>`;
}

// Typing changes the draft only (no re-render, the cursor stays); a fresh item's key follows its name.
input.tplSet = change.tplSet = el => {
  const [obj, prop] = parentOf(el.dataset.path);
  const value = el.value;
  // emptied texts stay (the server names what is missing); a form item keeps its kind
  if (value === '' && !['title', 'label', 'name', 'text', 'heading', 'sign'].includes(prop)) delete obj[prop]; else obj[prop] = value;
  if (el.tagName === 'SELECT' && (prop === 'type' || prop === 'doc_type')) render(); // file settings show for steps that take files
  if (fresh.has(obj) && prop === 'name' && el.dataset.path.startsWith('rules.')) obj.id = uniqueKey(value, draft.rules.filter(r => r !== obj).map(r => r.id));
  if (fresh.has(obj) && obj.key && prop === 'title' && /^forms\.\d+\.title$/.test(el.dataset.path)) { // a new form: key from its title
    const old = obj.key;
    obj.key = uniqueKey(value, draft.forms.filter(f => f !== obj).map(f => f.key));
    for (const t of draft.phases.flatMap(p => p.tasks)) if (t.form === old) t.form = obj.key;
    return;
  }
  if (fresh.has(obj) && obj.key && (prop === 'title' || prop === 'label')) {
    const isStep = el.dataset.path.startsWith('phases.') || el.dataset.path.startsWith('rules.');
    const list = isStep ? [...stepKeys(), ...ruleTaskKeys()] : (el.dataset.path.startsWith('roles.') ? draft.roles
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
  // steps that waited for a removed step no longer do; steps that offered a removed form no longer do
  for (const key of path === 'phases' ? item.tasks.map(t => t.key) : [item.key]) {
    for (const t of draft.phases.flatMap(p => p.tasks)) if (t.after?.includes(key)) t.after = t.after.filter(k => k !== key);
  }
  if (path === 'forms') for (const t of draft.phases.flatMap(p => p.tasks)) if (t.form === item.key) delete t.form;
  render();
};
on.tplAdd = ({ path }) => {
  const list = at(path);
  const item = path === 'roles' ? { key: uniqueKey('rolle', draft.roles.map(r => r.key)), label: '', access: 'guest_contributor' }
    : path === 'fields' ? { key: uniqueKey('angabe', draft.fields.map(f => f.key)), label: '' }
    : path === 'document_types' ? { key: uniqueKey('dokument', draft.document_types.map(d => d.key)), label: '', visible_to: [] }
    : path === 'phases' ? { title: '', tasks: [] }
    : path === 'forms' ? { key: uniqueKey('formular', draft.forms.map(f => f.key)), title: '', items: [{ heading: 'Angaben' }] }
    : path.endsWith('.items') ? { label: '' }
    : path === 'rules' ? { id: uniqueKey('regel', draft.rules.map(r => r.id)), name: '', trigger: 'task.complete', conditions: [],
      actions: [{ type: 'add_comment', text: '', visible_to: [] }] }
    : path.endsWith('.conditions') ? { field: 'task.key', operator: 'equals', value: '' }
    : path.endsWith('.actions') ? { type: 'add_comment', text: '', visible_to: [] }
    : { key: uniqueKey('schritt', stepKeys()), title: '', type: 'task' };
  fresh.add(item);
  list.push(item);
  render();
};

// --- PDF forms --------------------------------------------------------------------------------------------------
// Items top to bottom: heading, text, field, checkbox, signature. Values come from the case through placeholders
// (chosen from a list), or are a fixed text; they always land in form fields, so they stay correctable.
const KINDS = [['heading', 'Überschrift'], ['text', 'Text'], ['label', 'Feld'], ['check', 'Ankreuzfeld'], ['sign', 'Unterschrift']];
const kindOf = it => (it.heading !== undefined ? 'heading' : it.text !== undefined ? 'text' : it.sign !== undefined ? 'sign' : it.check ? 'check' : 'label');
const customValue = new WeakSet(); // items whose value is a fixed text being typed
const placeholderChoices = () => [['{case.title}', 'Titel des Vorgangs'], ...draft.fields.map(f => [`{field.${f.key}}`, f.label]),
  ...draft.roles.flatMap(r => [[`{role.${r.key}}`, `${r.label} (Name)`], [`{role.${r.key}.email}`, `${r.label} (E-Mail)`]]), ['{date}', 'heutiges Datum']];

function valueInput(it, path, prop = 'value', allowCustom = true, empty = '– leer –') {
  const known = placeholderChoices(), v = it[prop] ?? '';
  const custom = allowCustom && (customValue.has(it) || (v && !known.some(([p]) => p === v)));
  return html`${select(path, custom ? 'custom' : v, [['', empty], ...known.map(([p, l]) => [p, `aus: ${l}`]),
    ...(allowCustom ? [['custom', 'fester Text …']] : [])], prop === 'value' ? 'tplFormValue' : 'tplFormName')}
    ${custom ? text(`${path}.${prop}`, v, html`aria-label="fester Text" placeholder="fester Text"`) : ''}`;
}

function itemFields(it, path) {
  const kind = kindOf(it);
  if (kind === 'heading') return html`${text(`${path}.heading`, it.heading, html`aria-label="Überschrift" class="grow" required`)}
    ${text(`${path}.hint`, it.hint, html`aria-label="Hinweis" placeholder="Hinweis rechts, z. B. „Von der Hochschule auszufüllen“"`)}`;
  if (kind === 'text') return html`<textarea rows="2" class="grow" data-input="tplSet" data-path="${path}.text" aria-label="Text" required>${it.text ?? ''}</textarea>`;
  if (kind === 'sign') return html`${text(`${path}.sign`, it.sign, html`aria-label="Unterschrift" class="grow" placeholder="z. B. Unterschrift Erstprüfer/in" required`)}
    <label class="row">Name ${valueInput(it, path, 'name', false)}</label> <label class="row">Ort ${text(`${path}.place`, it.place, html`aria-label="Ort" style="width:8em"`)}</label>`;
  return html`${text(`${path}.label`, it.label, html`aria-label="Beschriftung" class="grow" placeholder="Beschriftung" required`)}
    <label class="row">${kind === 'check' ? html`vorab angekreuzt ${valueInput(it, path, 'value', false, '– nie –')}` : html`Wert ${valueInput(it, path)}`}</label>
    ${kind === 'label' ? html`<label class="row"><input type="checkbox" data-change="tplFlag" data-path="${path}.half" ${it.half ? 'checked' : ''}> halbe Breite</label>
      <label class="row">Zeilen <input type="number" min="1" max="12" value="${it.lines ?? 1}" data-input="tplNumber" data-path="${path}.lines" style="width:4em"></label>` : ''}`;
}

function formsSection() {
  return html`<h2>Formulare</h2>
    <p class="muted small">NomoCase erzeugt diese Formulare als ausfüllbare PDF, vorausgefüllt aus dem Vorgang. Bei einem Schritt
      unter „Formular“ auswählen, wo es angeboten wird. Logo und Farbe kommen vom Workspace.</p>
    ${draft.forms.map((f, fi) => html`<div class="step form">
      <div class="row">${text(`forms.${fi}.title`, f.title, html`aria-label="Titel des Formulars" class="grow" placeholder="Titel des Formulars" required`)}
        <button type="button" class="link" data-on="tplPreview" data-i="${fi}">Vorschau</button> ${tools('forms', fi, draft.forms.length)}</div>
      ${text(`forms.${fi}.subtitle`, f.subtitle, html`aria-label="Untertitel" placeholder="Untertitel (optional), z. B. wohin das Formular geht"`)}
      ${f.items.map((it, ii) => html`<div class="row small item">${select(`forms.${fi}.items.${ii}`, kindOf(it), KINDS, 'tplItemKind')}
        ${itemFields(it, `forms.${fi}.items.${ii}`)} ${tools(`forms.${fi}.items`, ii, f.items.length)}</div>`)}
      <button type="button" class="link small" data-on="tplAdd" data-path="forms.${fi}.items">+ Eintrag</button>
      <span class="muted small">Schlüssel: <code>${f.key}</code></span>
    </div>`)}
    <button type="button" class="link" data-on="tplAdd" data-path="forms">+ Formular</button>`;
}

change.tplItemKind = el => {
  const [list, i] = parentOf(el.dataset.path);
  const old = list[i], words = old.heading ?? old.text ?? old.sign ?? old.label ?? '';
  list[i] = el.value === 'heading' ? { heading: words } : el.value === 'text' ? { text: words } : el.value === 'sign' ? { sign: words, place: 'Düsseldorf' }
    : el.value === 'check' ? { label: words, check: true } : { label: words };
  render();
};
change.tplFormValue = change.tplFormName = el => {
  const it = at(el.dataset.path), prop = el.dataset.change === 'tplFormName' ? 'name' : 'value';
  customValue.delete(it);
  if (el.value === 'custom') { customValue.add(it); it[prop] = ''; } else if (el.value) it[prop] = el.value; else delete it[prop];
  render();
};
change.tplFlag = el => { const [obj, prop] = parentOf(el.dataset.path); if (el.checked) obj[prop] = true; else delete obj[prop]; };
on.tplPreview = ({ i }) => previewForm(draft, draft.forms[Number(i)], tpl);

// --- Rules ------------------------------------------------------------------------------------------------------
// "Wenn <trigger> und <conditions>: <actions>". Values come from lists where the template knows them (steps, document
// types, roles); amounts are entered in euros and kept in cents. Texts may use {task.title}, {date}, {date+14} …
const roleChoices = () => draft.roles.map(r => [r.key, r.label]);
function valueChoices(field) {
  if (field === 'task.key') return [...stepKeys(), ...ruleTaskKeys()].map(k => [k, draft.phases.flatMap(p => p.tasks).find(t => t.key === k)?.title
    ?? draft.rules.flatMap(r => r.actions).find(a => a.key === k)?.title ?? k]);
  if (field === 'document.type') return draft.document_types.map(t => [t.key, t.label]);
  if (field === 'task.role' || field === 'event.actor_role') return roleChoices();
  if (field === 'task.type') return Object.entries(TYPES);
  if (field === 'task.outcome') return [['approved', 'positiv'], ['rejected', 'negativ']];
  if (field === 'claim.direction') return [['payable', 'zu zahlen'], ['receivable', 'zu erhalten']];
  return null;
}

function conditionValue(c, path) {
  const choices = valueChoices(c.field);
  if (choices && c.operator === 'in') {
    return html`<select multiple size="${Math.min(4, choices.length)}" data-change="tplCondValue" data-path="${path}" aria-label="Werte">${choices.map(([v, l]) =>
      html`<option value="${v}" ${[c.value].flat().includes(v) ? 'selected' : ''}>${l}</option>`)}</select>`;
  }
  if (choices) return select(path, c.value, [['', '– wählen –'], ...choices], 'tplCondValue');
  const money = RULE_MONEY_FIELDS.includes(c.field);
  const shown = money && typeof c.value === 'number' ? plainEur(c.value) : [c.value].flat().join(', ');
  return html`<input value="${shown}" data-input="tplCondValue" data-path="${path}" aria-label="Wert"
    placeholder="${money ? 'Betrag in €' : c.operator === 'in' ? 'Werte, durch Komma getrennt' : 'Wert'}">`;
}

function actionFields(a, path) {
  if (a.type === 'add_comment') {
    const audience = (a.visible_to ?? ['*']).includes('*') ? '*' : a.visible_to?.[0] ?? '';
    return html`<textarea rows="2" data-input="tplSet" data-path="${path}.text" placeholder="Text, z. B. „{task.title} ist erledigt, weiter bis {date+14}.“" required>${a.text ?? ''}</textarea>
      <label class="row small">an ${select(path, audience, [['', 'nur das Team'], ['*', 'alle Beteiligten'], ...roleChoices().map(([k, l]) => [k, `Team + ${l}`])], 'tplAudience')}</label>`;
  }
  if (a.type === 'create_task') {
    return html`<div class="row">${text(`${path}.title`, a.title, html`aria-label="Titel der Aufgabe" class="grow" placeholder="Titel" required`)}
      ${select(`${path}.task_type`, a.task_type ?? 'task', Object.entries(TYPES))}
      ${select(`${path}.assign_to_role`, a.assign_to_role ?? 'owner', [['owner', 'die Verantwortlichen'], ...roleChoices()])}
      <label class="row small">Frist <input type="number" min="0" max="3650" value="${a.due_days ?? ''}" data-input="tplNumber" data-path="${path}.due_days" style="width:5em" aria-label="Frist in Tagen"> Tage</label></div>
      <textarea rows="2" data-input="tplSet" data-path="${path}.description" placeholder="Beschreibung (optional)">${a.description ?? ''}</textarea>
      <span class="muted small">Schlüssel: <code>${a.key ?? '–'}</code></span>`;
  }
  if (a.type === 'complete_tasks') {
    return a.key || (!a.task_type && !a.title) ? html`<label class="row small">Aufgabe ${select(`${path}.key`, a.key, [['', '– wählen –'], ...valueChoices('task.key')])}</label>`
      : html`<span class="muted small">abhaken nach ${a.task_type ? `Typ ${TYPES[a.task_type]}` : `Titel „${a.title}“`} (in der JSON-Ansicht änderbar)</span>`;
  }
  return html`<div class="row">Vorlage ${select(`${path}.template`, a.template, [['', '– wählen –'], ...wsTemplates.map(n => [n, n])])}
    ${text(`${path}.title`, a.title, html`aria-label="Titel des Teilvorgangs" class="grow" placeholder="Titel des Teilvorgangs" required`)}</div>`;
}

function rulesSection() {
  const fields = Object.entries(RULE_FIELD_LABELS);
  return html`<h2>Regeln</h2>
    <p class="muted small">Regeln reagieren auf Ereignisse im Vorgang. In Texten stehen Platzhalter wie <code>{task.title}</code>,
      <code>{document.title}</code>, <code>{date}</code> oder <code>{date+14}</code> (heute plus 14 Tage). Was eine Regel auslöst, löst keine weiteren Regeln aus.</p>
    ${draft.rules.map((r, ri) => html`<div class="step rule">
      <div class="row">${text(`rules.${ri}.name`, r.name, html`aria-label="Name der Regel" class="grow" placeholder="Name der Regel" required`)} ${tools('rules', ri, draft.rules.length)}</div>
      <label class="row small">Wenn ${select(`rules.${ri}.trigger`, r.trigger, Object.entries(RULE_TRIGGER_LABELS))}</label>
      ${r.conditions.map((c, ci) => html`<div class="row small">und
        ${select(`rules.${ri}.conditions.${ci}`, c.field, fields, 'tplCondField')} ${select(`rules.${ri}.conditions.${ci}`, c.operator, Object.entries(RULE_OP_LABELS), 'tplCondOp')}
        ${conditionValue(c, `rules.${ri}.conditions.${ci}`)} ${tools(`rules.${ri}.conditions`, ci, r.conditions.length)}</div>`)}
      <button type="button" class="link small" data-on="tplAdd" data-path="rules.${ri}.conditions">+ Bedingung</button>
      ${r.actions.map((a, ai) => html`<div class="stack action"><div class="row small">dann ${select(`rules.${ri}.actions.${ai}`, a.type, Object.entries(RULE_ACTION_LABELS), 'tplActionType')}
        ${tools(`rules.${ri}.actions`, ai, r.actions.length)}</div>${actionFields(a, `rules.${ri}.actions.${ai}`)}</div>`)}
      <button type="button" class="link small" data-on="tplAdd" data-path="rules.${ri}.actions">+ Aktion</button>
    </div>`)}
    <button type="button" class="link" data-on="tplAdd" data-path="rules">+ Regel</button>`;
}

change.tplCondField = el => { const c = at(el.dataset.path); c.field = el.value; c.value = c.operator === 'in' ? [] : ''; render(); };
change.tplCondOp = el => {
  const c = at(el.dataset.path);
  c.operator = el.value;
  c.value = el.value === 'in' ? [c.value].flat().filter(v => v !== '') : [c.value].flat()[0] ?? '';
  render();
};
input.tplCondValue = change.tplCondValue = el => {
  const c = at(el.dataset.path);
  c.value = el.multiple ? [...el.selectedOptions].map(o => o.value)
    : RULE_MONEY_FIELDS.includes(c.field) ? (Number.isNaN(toCents(el.value)) ? el.value : toCents(el.value))
    : c.operator === 'in' ? el.value.split(',').map(v => v.trim()).filter(Boolean) : el.value;
};
input.tplNumber = el => { const [obj, prop] = parentOf(el.dataset.path); if (el.value === '') delete obj[prop]; else obj[prop] = Math.max(0, Number(el.value) || 0); };
change.tplAudience = el => { at(el.dataset.path).visible_to = el.value === '*' ? ['*'] : el.value ? [el.value] : []; };
change.tplActionType = el => {
  const [list, i] = parentOf(el.dataset.path);
  const title = list[i].title ?? '';
  const next = el.value === 'add_comment' ? { type: el.value, text: '', visible_to: [] }
    : el.value === 'create_task' ? { type: el.value, title, task_type: 'task', assign_to_role: 'owner', key: uniqueKey(title || 'aufgabe', [...stepKeys(), ...ruleTaskKeys()]) }
    : el.value === 'complete_tasks' ? { type: el.value, key: '' }
    : { type: el.value, template: wsTemplates[0] ?? '', title };
  fresh.add(next);
  list[i] = next;
  render();
};

on.tplSave = async () => {
  const definition = structuredClone(draft);
  if (!definition.forms.length) delete definition.forms;
  const { version } = await api(`/templates/${tpl.id}/versions`, { body: { definition } });
  alert(`Gespeichert als Version ${version}. Laufende Vorgänge bleiben unverändert.`);
  tpl = null;
  go('#/templates');
};
on.tplDiscard = () => {
  if (!confirm('Alle Änderungen seit dem Öffnen verwerfen?')) return;
  draft = structuredClone(tpl.definition);
  render();
};
