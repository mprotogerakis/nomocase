// Forms a template brings along (definition.forms): NomoCase generates them as fillable PDFs, prefilled from the case.
// A form is a list of items, top to bottom:
//   { "heading": "Persönliche Angaben", "hint": "Von der Hochschule auszufüllen" }   numbered section
//   { "text": "Hiermit beantrage ich …" }                                              paragraph
//   { "label": "Matrikelnummer", "value": "{field.matrikel}", "half": true, "lines": 1 } text field
//   { "label": "extern (Firma oder Institut)", "check": true, "value": "{field.company_name}" } checkbox, ticked when value is not empty
//   { "sign": "Unterschrift der/des Studierenden", "name": "{field.student}", "place": "Düsseldorf" } place/date, signature, name
// Besides items: title, subtitle, header (a line on top). Logo and accent colour come from the workspace.
// Placeholders: {case.title} {field.<key>} {role.<key>} (names) {role.<key>.email} {date} {date+N} – only in value, name
// and place: whatever comes from the case lands in a form field, so it can still be corrected in the PDF.
// Shared by the Worker (check, fill with real values) and the UI (PDF, preview with placeholder names).

const PLACEHOLDER = /\{([^{}]*)\}/g;
const FILLED = ['value', 'name', 'place'];
const FIXED = ['heading', 'hint', 'text', 'label', 'sign'];

// Why a placeholder does not work in this template (null if it does).
function placeholderProblem(def, k) {
  if (k === 'case.title' || /^date(\+\d{1,3})?$/.test(k)) return null;
  const [kind, key, extra] = k.split('.');
  if (kind === 'field' && !extra && def.fields.some(f => f.key === key)) return null;
  if (kind === 'role' && (!extra || extra === 'email') && def.roles.some(r => r.key === key)) return null;
  return `Platzhalter {${k}} gibt es nicht (möglich: {case.title}, {field.<key>}, {role.<key>}, {role.<key>.email}, {date}, {date+N})`;
}

// Problems of definition.forms, as messages for checkDef (empty when fine).
export function formProblems(def) {
  const out = [];
  if (def.forms === undefined) return out;
  if (!Array.isArray(def.forms)) return ['forms muss eine Liste sein'];
  const keys = new Set();
  for (const f of def.forms) {
    const name = `Formular "${f?.key ?? '?'}"`;
    if (!f?.key || keys.has(f.key) || !f.title || !Array.isArray(f.items) || !f.items.length) { out.push(`${name}: eindeutiger key, title und items nötig`); continue; }
    keys.add(f.key);
    f.items.forEach((it, i) => {
      const at = `${name}, Eintrag ${i + 1}`;
      const kinds = ['heading', 'text', 'label', 'sign'].filter(k => typeof it?.[k] === 'string' && it[k].trim());
      if (kinds.length !== 1) out.push(`${at}: genau eines von heading, text, label, sign`);
      if (it?.lines !== undefined && !(Number.isInteger(it.lines) && it.lines >= 1 && it.lines <= 12)) out.push(`${at}: lines 1–12`);
      for (const k of FILLED) for (const [, p] of String(it?.[k] ?? '').matchAll(PLACEHOLDER)) { const problem = placeholderProblem(def, p); if (problem) out.push(`${at}: ${problem}`); }
    });
    const fixed = [f.title, f.subtitle, f.header, ...f.items.flatMap(it => FIXED.map(k => it?.[k]))];
    if (fixed.some(s => /\{[^{}]*\}/.test(s ?? ''))) {
      out.push(`${name}: Platzhalter nur in value, name und place – Werte aus dem Vorgang gehören in Formularfelder, damit sie sich korrigieren lassen`);
    }
  }
  return out;
}

// The form with the placeholders in value/name/place replaced by lookup(placeholder); checkboxes get `checked`.
export function fillForm(form, lookup) {
  const fill = s => (typeof s === 'string' ? s.replace(PLACEHOLDER, (_, k) => lookup(k) ?? '') : s);
  return {
    key: form.key, title: form.title, subtitle: form.subtitle, header: form.header,
    items: form.items.map(it => {
      const out = { ...it, ...Object.fromEntries(FILLED.filter(k => k in it).map(k => [k, fill(it[k])])) };
      if (it.check) out.checked = !!out.value?.trim();
      return out;
    }),
  };
}
