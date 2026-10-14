// Unit check for public/shared/assess.js (no server): grades, points, pass/fail, combining assessments.
import assert from 'node:assert/strict';
import { aggregate, formatScore, parseScore, passes, scaleProblem, verdict } from '../public/shared/assess.js';

// German grades as in many exam regulations: 1,0–4,0 in steps of 0,1, otherwise 5,0; mean cut after one decimal.
const note = { label: 'Note', range: [1.0, 4.0], step: 0.1, extra: [5.0], pass: { max: 4.0 } };
const modul = { method: 'mean', round: 'truncate', fail_value: 5.0 };
assert.equal(scaleProblem(note), null);
assert.equal(parseScore(note, '1,7'), 1.7);
assert.equal(parseScore(note, '2.3'), 2.3);
assert.equal(parseScore(note, '5'), 5);
for (const bad of ['4,5', '0,9', '1,75', 'gut', '']) assert.equal(parseScore(note, bad), null, bad);
assert.equal(formatScore(note, 2), '2,0');
assert.equal(verdict(note, 4.0), 'Bestanden');
assert.equal(verdict(note, 5.0), 'Nicht bestanden');
assert.deepEqual(aggregate(modul, note, [1.7, 2.3]), { value: 2.0, raw: 2.0, passed: true });
assert.deepEqual(aggregate(modul, note, [1.0, 1.3]), { value: 1.1, raw: 1.1, passed: true }, 'cut, not rounded');
assert.deepEqual(aggregate(modul, note, [5.0, 3.0]), { value: 4.0, raw: 4.0, passed: true }, 'a single 5,0 can still pass');
assert.deepEqual(aggregate(modul, note, [5.0, 4.0]), { value: 5.0, raw: 4.5, passed: false }, 'above 4,0 counts as 5,0');

// Points 0–100, pass from 50, rounded half up.
const points = { label: 'Punkte', range: [0, 100], step: 1, pass: { min: 50 } };
assert.equal(parseScore(points, '73'), 73);
assert.equal(parseScore(points, '73,5'), null);
assert.equal(passes(points, 49), false);
assert.deepEqual(aggregate({ method: 'mean' }, points, [50, 51]), { value: 51, raw: 51, passed: true });
assert.deepEqual(aggregate({ method: 'min' }, points, [80, 40]), { value: 40, raw: 40, passed: false });

// Pass/fail as options.
const pf = { label: 'Ergebnis', options: [{ value: 1, label: 'Bestanden' }, { value: 0, label: 'Nicht bestanden' }], pass: { min: 1 } };
assert.equal(scaleProblem(pf), null);
assert.equal(parseScore(pf, '0'), 0);
assert.equal(parseScore(pf, '2'), null);
assert.equal(formatScore(pf, 1), 'Bestanden');
assert.deepEqual(aggregate({ method: 'min' }, pf, [1, 0]), { value: 0, raw: 0, passed: false });

assert.match(scaleProblem({ label: 'x', range: [4, 1], step: 0.1, pass: { max: 4 } }), /range/);
assert.match(scaleProblem({ label: 'x', range: [1, 4], step: 0.1 }), /pass/);
console.log('ok – assess test passed');
