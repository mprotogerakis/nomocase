// Unit check for forms (public/shared/forms.js, public/formpdf.js): schema check, placeholders, the generated PDF
// (fillable fields, signature fields), and that NomoCase's own upload check and signature reader accept it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fillForm, formProblems } from '../public/shared/forms.js';
import { formPdf } from '../public/formpdf.js';
import { checkContent } from '../src/validate.js';
import { readSignatures } from '../src/pdfsig.js';
import { PDFCheckBox, PDFDocument, PDFSignature, PDFTextField } from '../public/vendor/pdf-lib.esm.min.js';

const root = new URL('../', import.meta.url);
const bachelor = JSON.parse(readFileSync(new URL('templates/bachelor-thesis.json', root))).definition;
assert.deepEqual(formProblems(bachelor), [], 'the shipped template is valid');

const def = { roles: [{ key: 'boss', label: 'Chefin' }], fields: [{ key: 'nr', label: 'Nummer' }, { key: 'firm', label: 'Firma' }] };
const problems = forms => formProblems({ ...def, forms });
assert.deepEqual(problems([{ key: 'a', title: 'A', items: [{ label: 'Nr', value: '{field.nr} {role.boss.email} {date+14} {case.title}' }] }]), []);
assert.match(problems([{ key: 'a', title: 'A', items: [{ label: 'Nr', value: '{field.typo}' }] }])[0], /\{field\.typo\} gibt es nicht/);
assert.match(problems([{ key: 'a', title: 'A', items: [{ label: 'x', sign: 'y' }] }])[0], /genau eines/);
assert.match(problems([{ key: 'a', title: 'A', items: [{ text: 'x' }] }, { key: 'a', title: 'B', items: [{ text: 'y' }] }])[0], /eindeutiger key/);
assert.match(problems([{ key: 'a', title: 'A', logo: 'https://example.org/logo.png', items: [{ text: 'x' }] }])[0], /logo/, 'no third-party logos');
assert.match(problems([{ key: 'a', title: 'A', accent: 'red', items: [{ text: 'x' }] }])[0], /accent/);

const values = { 'field.nr': '4711', 'field.firm': '', 'role.boss': 'Dr. Łucja Żółć', 'case.title': 'Testfall' };
const filled = fillForm({ key: 'a', title: 'Antrag {case.title}', items: [
  { heading: 'Angaben', hint: 'bitte vollständig' },
  { label: 'Nummer', value: '{field.nr}', half: true }, { label: 'Leiterin', value: '{role.boss}', half: true },
  { label: 'extern', check: true, value: '{field.firm}' }, { label: 'intern', check: true, value: 'ja' },
  { label: 'Begründung', lines: 4 },
  { text: 'Ich bestätige die Angaben.' },
  { sign: 'Unterschrift Leiterin', name: '{role.boss}', place: 'Düsseldorf' },
  { sign: 'Unterschrift Studienbüro' },
] }, k => values[k]);
assert.equal(filled.title, 'Antrag Testfall');
assert.deepEqual(filled.items.filter(it => it.check).map(it => it.checked), [false, true], 'a checkbox is ticked when its value is not empty');

const bytes = await formPdf({ ...filled, logo: '/brand/hsd-ei.png', case_title: 'Testfall', template: 'Test', created: '14.10.2026' },
  { loadImage: async u => readFileSync(new URL(`public${u}`, root)) });
const doc = await PDFDocument.load(bytes);
const fields = Object.fromEntries(doc.getForm().getFields().map(f => [f.getName(), f]));
assert.ok(fields.Nummer instanceof PDFTextField && fields.Nummer.getText() === '4711', 'prefilled text field');
assert.equal(fields.Leiterin.getText(), 'Dr. Lucja Zólc', 'letters the standard font lacks become their base letter');
assert.ok(fields.intern instanceof PDFCheckBox && fields.intern.isChecked() && !fields.extern.isChecked());
assert.ok(fields['Begründung'].isMultiline(), 'multi-line field');
assert.equal(fields['Ort, Datum – Unterschrift Leiterin'].getText(), 'Düsseldorf, ');
assert.deepEqual(Object.values(fields).filter(f => f instanceof PDFSignature).map(f => f.getName()), ['Unterschrift Leiterin', 'Unterschrift Studienbüro'], 'real signature fields');
assert.equal(doc.getTitle(), 'Antrag Testfall');

assert.equal(await checkContent('pdf', bytes), null, 'passes the strict upload check');
assert.deepEqual(await readSignatures(bytes, []), [], 'empty signature fields are not signatures');

// A long form flows onto further pages, each with a footer.
const long = await formPdf(fillForm({ key: 'l', title: 'Lang', items: Array.from({ length: 40 }, (_, i) => ({ label: `Feld ${i}` })) }, () => ''));
assert.ok((await PDFDocument.load(long)).getPageCount() >= 3);

console.log('ok – forms test passed');
