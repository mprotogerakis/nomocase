// Unit check for public/shared/bulk.js: reading a pasted table into cases to create (no server needed).
import assert from 'node:assert/strict';
import { parseTable } from '../public/shared/bulk.js';

const def = { fields: [{ key: 'student', label: 'Name der/des Studierenden' }, { key: 'matrikel', label: 'Matrikelnummer' },
  { key: 'issued', label: 'Ausgabe des Themas', type: 'date' }] };

// Pasted from a spreadsheet: tabs, labels or keys as headers, German dates.
let t = parseTable('Titel\tE-Mail\tmatrikel\tAusgabe des Themas\nBA Muster\tErika@Example.org\t4711\t1.3.2027\n', def);
assert.deepEqual(t.columns.map(c => c.kind), ['title', 'email', 'field', 'field']);
assert.deepEqual(t.rows[0], { line: 2, title: 'BA Muster', email: 'erika@example.org', fields: { matrikel: '4711', issued: '2027-03-01' }, problems: [] });

// Semicolons; without a title column the title is "template – first value"; problems per line; unknown columns named.
t = parseTable('Name der/des Studierenden;E-Mail;Ausgabe des Themas;Bemerkung\nErika Muster;erika@example.org;2027-03-01;x\n;kaputt;31.02.;\n\n', def, 'Bachelor-Thesis');
assert.deepEqual(t.unknown, ['Bemerkung']);
assert.equal(t.rows.length, 2, 'empty lines are skipped');
assert.equal(t.rows[0].title, 'Bachelor-Thesis – Erika Muster');
assert.deepEqual(t.rows[1].problems, ['Ausgabe des Themas: Datum ungültig', 'E-Mail ungültig']);
assert.equal(t.rows[1].title, 'Bachelor-Thesis', 'the template name alone still makes a title');

// Commas; more cells than columns is flagged; nothing pasted gives nothing.
t = parseTable('Titel,E-Mail\nA,a@example.org,zu viel\n', def);
assert.deepEqual(t.rows[0].problems, ['mehr Zellen als Spalten']);
assert.deepEqual(parseTable('  \n', def).rows, []);

console.log('ok – bulk test passed');
