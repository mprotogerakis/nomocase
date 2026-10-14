// Forms a template brings along (definition.forms): NomoCase generates them as fillable PDFs, prefilled from the case.
// A form is a list of items, top to bottom:
//   { "heading": "Persönliche Angaben", "hint": "Von der Hochschule auszufüllen" }   numbered section
//   { "text": "Hiermit beantrage ich …" }                                              paragraph
//   { "label": "Matrikelnummer", "value": "{field.matrikel}", "half": true, "lines": 1 } text field
//   { "label": "extern (Firma oder Institut)", "check": true, "value": "{field.company_name}" } checkbox, ticked when value is not empty
//   { "sign": "Unterschrift der/des Studierenden", "name": "{field.student}", "place": "Düsseldorf" } place/date + signature field
// Besides items: title, subtitle, header (issuer line on top), accent ("#rrggbb"), logo (a PNG/JPEG NomoCase serves itself,
// e.g. "/brand/hsd-ei.jpg" – never a third-party address, so generating a form tells no one else about it).
// Placeholders: {case.title} {field.<key>} {role.<key>} (names) {role.<key>.email} {date} {date+N}.
// Shared by the Worker (check, fill with real values) and the UI (PDF, preview with placeholder names).

const PLACEHOLDER = /\{([^{}]*)\}/g;
const TEXTS = ['title', 'subtitle', 'header'];
const ITEM_TEXTS = ['heading', 'hint', 'text', 'label', 'value', 'sign', 'name', 'place'];

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
    if (f.accent !== undefined && !/^#[0-9a-f]{6}$/i.test(f.accent)) out.push(`${name}: accent als Farbe "#rrggbb"`);
    if (f.logo !== undefined && !/^\/[\w/.-]+\.(png|jpe?g)$/i.test(f.logo)) out.push(`${name}: logo als Pfad zu einer PNG/JPEG-Datei von NomoCase, z. B. "/brand/logo.png"`);
    f.items.forEach((it, i) => {
      const kinds = ['heading', 'text', 'label', 'sign'].filter(k => typeof it?.[k] === 'string' && it[k].trim());
      if (kinds.length !== 1) out.push(`${name}, Eintrag ${i + 1}: genau eines von heading, text, label, sign`);
      if (it?.lines !== undefined && !(Number.isInteger(it.lines) && it.lines >= 1 && it.lines <= 12)) out.push(`${name}, Eintrag ${i + 1}: lines 1–12`);
    });
    const texts = [...TEXTS.map(k => f[k]), ...f.items.flatMap(it => ITEM_TEXTS.map(k => it?.[k]))].filter(s => typeof s === 'string');
    for (const s of texts) for (const [, k] of s.matchAll(PLACEHOLDER)) { const p = placeholderProblem(def, k); if (p) out.push(`${name}: ${p}`); }
  }
  return out;
}

// The form with every placeholder replaced by lookup(placeholder); checkboxes get `checked`.
export function fillForm(form, lookup) {
  const fill = s => (typeof s === 'string' ? s.replace(PLACEHOLDER, (_, k) => lookup(k) ?? '') : s);
  return {
    ...Object.fromEntries(TEXTS.map(k => [k, fill(form[k])])), key: form.key, accent: form.accent, logo: form.logo,
    items: form.items.map(it => {
      const out = { ...it, ...Object.fromEntries(ITEM_TEXTS.filter(k => k in it).map(k => [k, fill(it[k])])) };
      if (it.check) out.checked = !!out.value?.trim();
      return out;
    }),
  };
}
