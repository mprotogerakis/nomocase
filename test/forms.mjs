// Unit check for forms (public/shared/forms.js, public/formpdf.js): schema check, placeholders, the generated PDF
// (fillable fields, signature fields), and that NomoCase's own upload check and signature reader accept it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fillForm, formProblems } from '../public/shared/forms.js';
import { formPdf } from '../public/formpdf.js';
import { checkContent } from '../src/validate.js';
import { readSignatures } from '../src/pdfsig.js';
import { readFormFields } from '../src/pdfform.js';
import { decodePDFRawStream, PDFArray, PDFCheckBox, PDFDocument, PDFSignature, PDFTextField } from '../public/vendor/pdf-lib.esm.min.js';

const root = new URL('../', import.meta.url);
const bachelor = JSON.parse(readFileSync(new URL('templates/bachelor-thesis.json', root))).definition;
assert.deepEqual(formProblems(bachelor), [], 'the shipped template is valid');

const def = { roles: [{ key: 'boss', label: 'Chefin' }], fields: [{ key: 'nr', label: 'Nummer' }, { key: 'firm', label: 'Firma' }] };
const problems = forms => formProblems({ ...def, forms });
assert.deepEqual(problems([{ key: 'a', title: 'A', items: [{ label: 'Nr', value: '{field.nr} {role.boss.email} {date+14} {case.title}' }] }]), []);
assert.match(problems([{ key: 'a', title: 'A', items: [{ label: 'Nr', value: '{field.typo}' }] }])[0], /\{field\.typo\} gibt es nicht/);
assert.match(problems([{ key: 'a', title: 'A', items: [{ label: 'x', sign: 'y' }] }])[0], /genau eines/);
assert.match(problems([{ key: 'a', title: 'A', items: [{ text: 'x' }] }, { key: 'a', title: 'B', items: [{ text: 'y' }] }])[0], /eindeutiger key/);
for (const where of [{ title: 'Antrag {case.title}' }, { items: [{ text: 'Ich, {field.nr}, bestätige' }] }, { items: [{ sign: 'Unterschrift {role.boss}' }] }]) {
  assert.match(problems([{ key: 'a', title: 'A', items: [{ text: 'x' }], ...where }])[0], /nur in value, name und place/, 'values from the case only in fields');
}

const values = { 'field.nr': '4711', 'field.firm': '', 'role.boss': 'Dr. Łucja Żółć', 'case.title': 'Testfall' };
const filled = fillForm({ key: 'a', title: 'Antrag', items: [
  { heading: 'Angaben', hint: 'bitte vollständig' },
  { label: 'Nummer', value: '{field.nr}', half: true }, { label: 'Leiterin', value: '{role.boss}', half: true },
  { label: 'extern', check: true, value: '{field.firm}' }, { label: 'intern', check: true, value: 'ja' },
  { label: 'Begründung', lines: 4 },
  { text: 'Ich bestätige die Angaben.' },
  { sign: 'Unterschrift Leiterin', name: '{role.boss}', place: 'Düsseldorf' },
  { sign: 'Unterschrift Studienbüro' },
] }, k => values[k]);
assert.deepEqual(filled.items.filter(it => it.check).map(it => it.checked), [false, true], 'a checkbox is ticked when its value is not empty');

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const bytes = await formPdf({ ...filled, logo: PIXEL, accent: '#e60028', case_title: 'Testfall', template: 'Test', created: '14.10.2026' });
const doc = await PDFDocument.load(bytes);
const fields = Object.fromEntries(doc.getForm().getFields().map(f => [f.getName(), f]));
assert.ok(fields.Nummer instanceof PDFTextField && fields.Nummer.getText() === '4711', 'prefilled text field');
assert.equal(fields.Leiterin.getText(), 'Dr. Lucja Zólc', 'letters the standard font lacks become their base letter');
assert.ok(fields.intern instanceof PDFCheckBox && fields.intern.isChecked() && !fields.extern.isChecked());
assert.ok(fields['Begründung'].isMultiline(), 'multi-line field');
assert.equal(fields['Ort, Datum – Unterschrift Leiterin'].getText(), 'Düsseldorf, ');
assert.deepEqual(Object.values(fields).filter(f => f instanceof PDFSignature).map(f => f.getName()), ['Unterschrift Leiterin', 'Unterschrift Studienbüro'], 'real signature fields');
assert.deepEqual([fields['Name – Unterschrift Leiterin'].getText(), fields['Name – Unterschrift Studienbüro'].getText() ?? ''], ['Dr. Lucja Zólc', ''], 'signer names are fields');
assert.equal(doc.getTitle(), 'Antrag');

// Nothing from the case is printed as fixed text (it could not be corrected): standard-font text is drawn as hex strings.
const printed = doc.getPages().map(p => {
  const c = p.node.Contents();
  return (c instanceof PDFArray ? c.asArray().map(r => doc.context.lookup(r)) : [c])
    .map(st => new TextDecoder('latin1').decode(decodePDFRawStream(st).decode())).join('');
}).join('').toLowerCase();
const hex = t => [...t].map(ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');
assert.ok(printed.includes(hex('Ort, Datum')), 'fixed text is found this way');
for (const value of ['Lucja', '4711', 'Testfall']) assert.ok(!printed.includes(hex(value)), `"${value}" only in fields`);

assert.equal(await checkContent('pdf', bytes), null, 'passes the strict upload check');
assert.deepEqual(await readSignatures(bytes, []), [], 'empty signature fields are not signatures');

// Reading a filled-in form back (on upload): as generated, after filling it in a PDF reader (here pdf-lib, which saves
// with compressed object streams), and after an appended update (the way Acrobat saves) with a UTF-16 value.
let read = await readFormFields(bytes);
assert.deepEqual([read.get('Nummer'), read.get('intern'), read.get('extern'), read.get('Name – Unterschrift Leiterin'), read.get('Begründung')],
  ['4711', true, false, 'Dr. Lucja Zólc', ''], 'values as generated');
const edited = await PDFDocument.load(bytes);
edited.getForm().getTextField('Begründung').setText('Weil – „Grund“ (ü)');
edited.getForm().getCheckBox('extern').check();
const saved = await edited.save();
read = await readFormFields(saved);
assert.deepEqual([read.get('Begründung'), read.get('extern'), read.get('Nummer')], ['Weil – „Grund“ (ü)', true, '4711'], 'filled in a PDF reader');
const appended = new Uint8Array([...saved, ...new TextEncoder().encode('\n99 0 obj\n<< /FT /Tx /T (Nummer) /V (\\376\\377\\000M\\000\\374) >>\nendobj\n%%EOF\n')]);
assert.equal((await readFormFields(appended)).get('Nummer'), 'Mü', 'the last definition wins (incremental update)');
assert.equal((await readFormFields(new TextEncoder().encode('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF'))).size, 0, 'no form, no fields');

// A long form flows onto further pages, each with a footer.
const long = await formPdf(fillForm({ key: 'l', title: 'Lang', items: Array.from({ length: 40 }, (_, i) => ({ label: `Feld ${i}` })) }, () => ''));
assert.ok((await PDFDocument.load(long)).getPageCount() >= 3);

console.log('ok – forms test passed');
