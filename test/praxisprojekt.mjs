// Walks the real example template "Praxisprojekt (B.Eng.)" (process plan of the EI faculty) from topic to booking,
// with all four parties, and checks visibility, rules and the grading logic on the way.
import assert from 'node:assert/strict';
import { run, PDF, client, expect, file, freshMailQuota, tokenOf } from './lib.mjs';
import { formPdf } from '../public/formpdf.js';
import { PDFDocument } from '../public/vendor/pdf-lib.esm.min.js';

freshMailQuota();
const prof = client(), student = client(), company = client(), office = client();
await expect(prof('/dev-login', { body: { email: 'prof@example.org' } }));
const tpl = (await expect(prof('/templates'))).find(t => t.name === 'Praxisprojekt (B.Eng.)');
const fields = { student: 'Erika Beispiel', matrikel: '1000001', company_name: 'Beispiel GmbH', second_examiner: 'Dr. Muster',
  project_title: 'Modulare Prüfstandssteuerung', po: 'PO 2022', start: '2027-03-01', end: '2027-06-30' };
const { id } = await expect(prof('/cases', { body: { template_id: tpl.id, title: 'Praxisprojekt Beispiel', fields } }));
const join = async (who, email, role, name) => {
  const { link } = await expect(prof(`/cases/${id}/invitations`, { body: { email, role } }));
  await expect(who('/invitations/accept', { body: { consent: true, token: tokenOf(link), name } }));
};
await join(student, `erika.${run}@example.org`, 'student', 'Erika Beispiel');
await join(company, `muster.${run}@example.org`, 'company', 'Dr. Muster');
await join(office, `sb.${run}@example.org`, 'office', 'Studienbüro');

const view = (who, caseId = id) => expect(who(`/cases/${caseId}`));
const taskId = async (who, title, caseId = id) => (await view(who, caseId)).tasks.find(t => t.title === title)?.id ?? assert.fail(`not visible: ${title}`);
const act = async (who, title, body = { action: 'complete' }, caseId = id) => expect(who(`/tasks/${await taskId(who, title, caseId)}/action`, { body }));
const upload = async (who, title, name) => expect(who(`/cases/${id}/documents`, { form: file(name, PDF, { task_id: await taskId(who, title) }) }));
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10).split('-').reverse().join('.');
const ruleSaid = (c, name) => c.events.find(e => e.payload.rule === name);

// The template: deadline from the planned submission (exposé), own labels on the gradings.
let c = await view(prof);
assert.equal(c.tasks.find(t => t.title === 'Ausarbeitung bei den Prüfer:innen einreichen').due_date, '2027-06-30');
assert.deepEqual(c.tasks.find(t => t.title === 'Bewerten (Zweitprüfer:in)').labels, ['Bestanden', 'Nicht bestanden']);
assert.ok(c.tasks.find(t => t.title === 'Exposé hochladen').description.includes('https://dl.proto-hess.com/PeHd2W2k'), 'exposé template linked');

// Angaben stay editable: the team may change them, open deadlines taken from a date field move along.
const editFields = (who, f, status) => expect(who(`/cases/${id}/fields`, { method: 'PATCH', body: { fields: f } }), status);
await editFields(student, { matrikel: '999' }, 403);
await editFields(prof, { nope: 'x' }, 400);
await editFields(prof, { end: '30.07.2027' }, 400);
assert.deepEqual(await editFields(prof, { matrikel: '1000002', end: '2027-07-31', start: '2027-03-01' }), { changed: 2 });
c = await view(prof);
assert.equal(c.case.fields.matrikel, '1000002');
assert.equal(c.tasks.find(t => t.title === 'Ausarbeitung bei den Prüfer:innen einreichen').due_date, '2027-07-31');
const edited = c.events.find(e => e.type === 'case.fields_updated');
assert.deepEqual(edited.payload.fields, ['Matrikelnummer', 'Angestrebte Abgabe']);
assert.ok(!JSON.stringify(edited.payload).includes('1000002'), 'the log names fields, not values');
assert.ok(!(await view(student)).events.some(e => e.type === 'case.fields_updated'), 'team-only log entry');

// 1. Topic and exposé, with one round of questions.
await act(student, 'Thema, Unternehmen und Zweitprüfer:in klären');
await upload(student, 'Exposé hochladen', 'Expose-v1.pdf');
await act(prof, 'Exposé prüfen', { action: 'question', note: 'Bitte die Forschungsfragen schärfen.' });
await upload(student, 'Exposé hochladen', 'Expose-v2.pdf');
await act(prof, 'Exposé prüfen', { action: 'approve' });

// 2. Laufzettel: student, second examiner, first examiner. The last signature starts the project.
await upload(student, 'Laufzettel ausfüllen und unterschreiben', 'Laufzettel.pdf');
await expect(student(`/tasks/${await taskId(student, 'Laufzettel unterschreiben (Zweitprüfer:in)')}/action`, { body: { action: 'complete' } }), 403); // visible, not theirs
await upload(company, 'Laufzettel unterschreiben (Zweitprüfer:in)', 'Laufzettel-Zweitpruefer.pdf');
// Rules refer to steps by key: renaming the step must not switch the rule off.
await expect(prof(`/tasks/${await taskId(prof, 'Laufzettel unterschreiben (Erstprüfer:in)')}`, { method: 'PATCH', body: { title: 'Laufzettel gegenzeichnen' } }));
await upload(prof, 'Laufzettel gegenzeichnen', 'Laufzettel-unterschrieben.pdf');
let s = await view(student);
assert.ok(ruleSaid(s, 'Projektstart mitteilen')?.payload.body.includes(inDays(56)), 'student learns the earliest submission date');
assert.ok(ruleSaid(await view(company), 'Projektstart mitteilen'), 'second examiner is told too');
assert.equal(s.documents.find(d => d.doc_type === 'laufzettel').versions.length, 3, 'one document, three signed versions');
assert.deepEqual((await view(office)).documents.map(d => d.doc_type), ['laufzettel'], 'Studienbüro sees the Laufzettel only');

// 3. Work and submission; OSSC registration tells everyone the earliest presentation date.
await act(student, 'Kopie des Laufzettels an praxisprojekt.ei@hs-duesseldorf.de senden');
await act(student, 'Praxisprojekt durchführen (mindestens 8 Wochen)');
await upload(student, 'Ausarbeitung bei den Prüfer:innen einreichen', 'Ausarbeitung.pdf');
await upload(student, 'Im OSSC zur Prüfung anmelden', 'OSSC.pdf');
assert.ok(ruleSaid(await view(student), 'Frühesten Präsentationstermin mitteilen')?.payload.body.includes(inDays(14)));
assert.ok(!(await view(company)).documents.some(d => d.doc_type === 'ossc'), 'OSSC proof stays with student and first examiner');

// 4. Presentation, two gradings, graded Laufzettel to the Studienbüro.
await act(prof, 'Präsentationstermin vereinbaren');
await upload(student, 'Präsentation halten', 'Folien.pdf');
assert.ok(!(await view(student)).tasks.some(t => t.title.startsWith('Bewerten')), 'gradings stay between the examiners');
await act(company, 'Bewerten (Zweitprüfer:in)', { action: 'approve' });
await act(prof, 'Bewerten (Erstprüfer:in)', { action: 'approve' });
c = await view(prof);
assert.ok(c.events.some(e => e.type === 'task.approve' && e.payload.verdict === 'Bestanden'));
await expect(prof(`/cases/${id}/documents`, { form: file('Laufzettel-Bewertung.pdf', PDF, { task_id: c.tasks.find(t => t.title === 'Laufzettel mit Bewertung ans Studienbüro senden').id }) }));
assert.ok((await view(office)).documents.some(d => d.doc_type === 'result'), 'Studienbüro gets the graded Laufzettel');
assert.ok(!(await view(student)).documents.some(d => d.doc_type === 'result'));

// 5. Booking closes it; the student gets the congratulation from the rule.
await act(prof, 'Verbuchung durch das Studienbüro');
s = await view(student);
assert.ok(ruleSaid(s, 'Abschluss mitteilen'));
assert.equal(s.case.phase, null, 'all steps done');

// "Nicht bestanden" records a result, does not block the report, and creates a follow-up talk (rule).
const { id: failed } = await expect(prof('/cases', { body: { template_id: tpl.id, title: 'Praxisprojekt Nicht bestanden', fields } }));
for (const t of (await view(prof, failed)).tasks.filter(t => !['Bewerten (Erstprüfer:in)', 'Bewerten (Zweitprüfer:in)', 'Laufzettel mit Bewertung ans Studienbüro senden', 'Verbuchung durch das Studienbüro'].includes(t.title))) {
  await expect(prof(`/tasks/${t.id}/action`, { body: { action: 'skip' } }));
}
await act(prof, 'Bewerten (Erstprüfer:in)', { action: 'reject', note: 'Präsentation nicht ausreichend.' }, failed);
await act(prof, 'Bewerten (Zweitprüfer:in)', { action: 'approve' }, failed);
c = await view(prof, failed);
assert.equal(c.tasks.find(t => t.title === 'Laufzettel mit Bewertung ans Studienbüro senden').blocked, false, 'a failed grade still gets reported');
assert.ok(c.tasks.some(t => t.title === 'Gespräch zum Ergebnis führen' && t.visible_to.includes('student')));
assert.ok(c.events.some(e => e.type === 'task.reject' && e.payload.verdict === 'Nicht bestanden'));

// The finished case can become a template again: field deadline and labels survive.
const again = await expect(prof(`/cases/${id}/template`, { body: { name: `Praxisprojekt aus Vorgang ${run}` } }));
const def = (await expect(prof('/templates'))).find(t => t.id === again.template_id).definition;
const steps = def.phases.flatMap(ph => ph.tasks);
assert.equal(steps.find(t => t.title === 'Ausarbeitung bei den Prüfer:innen einreichen').due_field, 'end');
assert.deepEqual(steps.find(t => t.title === 'Bewerten (Erstprüfer:in)').labels, ['Bestanden', 'Nicht bestanden']);
assert.equal(def.rules.length, 4);
assert.equal(steps.length, 16);

// Masterprojekt (M.Sc.): same flow, but each examiner records a grade; single grades stay with the examiners.
const mtpl = (await expect(prof('/templates'))).find(t => t.name === 'Masterprojekt (M.Sc.)');
const m = (await expect(prof('/cases', { body: { template_id: mtpl.id, title: 'Masterprojekt Beispiel', fields: { ...fields, track: 'Automatisierung' } } }))).id;
const mstudent = client(), second = client();
for (const [who, email, role, name] of [[mstudent, `m.erika.${run}@example.org`, 'student', 'Erika Beispiel'], [second, `m.muster.${run}@example.org`, 'second', 'Dr. Muster']]) {
  const { link } = await expect(prof(`/cases/${m}/invitations`, { body: { email, role } }));
  await expect(who('/invitations/accept', { body: { consent: true, token: tokenOf(link), name } }));
}
let mc = await view(prof, m);
assert.equal(mc.tasks.length, 18);
const grading = mc.phases.find(ph => ph.title === 'Bewertung').id;
for (const t of mc.tasks.filter(t => t.phase_id !== grading && mc.phases.findIndex(ph => ph.id === t.phase_id) < mc.phases.findIndex(ph => ph.id === grading))) {
  await expect(prof(`/tasks/${t.id}/action`, { body: { action: 'skip' } }));
}
assert.ok(!(await view(mstudent, m)).tasks.some(t => t.title.startsWith('Bewerten')), 'grading steps are not shown to the student');
const grade = async (who, title, g, status) => expect(who(`/tasks/${await taskId(who, title, m)}/action`, { body: { action: 'assess', score: g } }), status);
await grade(second, 'Bewerten (Zweitprüfer:in)', '4,5', 400);
await grade(second, 'Bewerten (Zweitprüfer:in)', '1.75', 400);
for (const action of ['approve', 'complete']) { // only a value decides an assessed step
  await expect(second(`/tasks/${await taskId(second, 'Bewerten (Zweitprüfer:in)', m)}/action`, { body: { action } }), 400);
}
await grade(second, 'Bewerten (Zweitprüfer:in)', '5,0');
await grade(prof, 'Bewerten (Erstprüfer:in)', '3.0');
mc = await view(prof, m);
const graded = mc.events.filter(e => e.payload.score_label).map(e => [e.type, e.payload.score_label, e.payload.verdict]);
assert.deepEqual(graded, [['task.reject', '5,0', 'Nicht bestanden'], ['task.approve', '3,0', 'Bestanden']]);
assert.equal(mc.tasks.find(t => t.title.startsWith('Bewertungsbogen ausfüllen')).blocked, false, 'a 5,0 does not block the grading sheet');
assert.ok(mc.tasks.some(t => t.title === 'Ergebnis klären und besprechen'), 'rule: a 5,0 needs a look at the mean');
assert.deepEqual(mc.tasks.filter(t => t.assess).map(t => t.score), [5, 3], 'values are stored on the steps');
assert.equal((await view(second, m)).events.filter(e => e.payload.score_label).length, 2, 'both examiners see both grades');
const ms = await view(mstudent, m);
assert.ok(!ms.events.some(e => e.payload.score_label) && !ms.tasks.some(t => t.title === 'Ergebnis klären und besprechen' || t.assess), 'no single grades for the student');
const mcopy = await expect(prof(`/cases/${m}/template`, { body: { name: `Masterprojekt aus Vorgang ${run}` } }));
const mdef = (await expect(prof('/templates'))).find(t => t.id === mcopy.template_id).definition;
assert.equal(mdef.phases.flatMap(ph => ph.tasks).filter(t => t.assess === 'note').length, 2, 'assessments survive case → template');
assert.deepEqual([mdef.scales.note.pass, mdef.aggregates[0].from], [{ max: 4 }, ['grade_1', 'grade_2']]);

// Bachelor-Thesis (B.Eng.): admission with signatures, issue of the topic, the submission date entered afterwards
// becomes the deadline of the submission steps, optional presentation, two grades, result form, booking.
{
  const ttpl = (await expect(prof('/templates'))).find(t => t.name === 'Bachelor-Thesis (B.Eng.)');
  const b = (await expect(prof('/cases', { body: { template_id: ttpl.id, title: 'Bachelor-Thesis Beispiel', fields: { student: 'Erika Beispiel', thesis_title: 'Regelung eines Prüfstands' } } }))).id;
  const bstudent = client(), bsecond = client();
  for (const [who, email, role, name] of [[bstudent, `b.erika.${run}@example.org`, 'student', 'Erika Beispiel'], [bsecond, `b.muster.${run}@example.org`, 'second', 'Dr. Muster']]) {
    const { link } = await expect(prof(`/cases/${b}/invitations`, { body: { email, role } }));
    await expect(who('/invitations/accept', { body: { consent: true, token: tokenOf(link), name } }));
  }
  const step = async (who, key) => (await view(who, b)).tasks.find(t => t.key === key) ?? assert.fail(`not visible: ${key}`);
  const done = async (who, key, body = { action: 'complete' }) => expect(who(`/tasks/${(await step(who, key)).id}/action`, { body }));
  const put = async (who, key, name) => expect(who(`/cases/${b}/documents`, { form: file(name, PDF, { task_id: (await step(who, key)).id }) }));
  await done(bstudent, 'topic');
  await put(bstudent, 'expose', 'Expose.pdf');
  await done(prof, 'expose_review', { action: 'approve' });
  // The admission form comes prefilled from the case – only what the template puts into it, only for who sees the step.
  const formOf = async (who, key, status) => expect(who(`/tasks/${(await step(prof, key)).id}/form`), status);
  const valueIn = (f, label) => f.items.find(it => it.label?.startsWith(label))?.value;
  const zul = await formOf(bstudent, 'form');
  assert.equal(zul.title, 'Antrag auf Zulassung zur Bachelor-Thesis');
  assert.equal(valueIn(zul, 'Name, Vorname'), 'Erika Beispiel');
  assert.equal(valueIn(zul, 'E-Mail-Adresse'), `b.erika.${run}@example.org`);
  assert.equal(valueIn(zul, 'Erstprüfer/in'), (await expect(prof('/me'))).user.name);
  assert.equal(zul.items.find(it => it.sign === 'Unterschrift der/des Studierenden').name, 'Erika Beispiel');
  assert.equal(zul.items.find(it => it.check).checked, false, 'not external: no company given');
  assert.ok((await view(bstudent, b)).definition.forms.every(f => f.title && !f.items), 'participants see form titles, not definitions');
  await formOf(bstudent, 'result_form', 404); // a step the student does not see
  await formOf(prof, 'topic', 404);           // a step without a form
  // The filled-in form is read back on upload: the student added the matrikel and changed the title.
  const filledIn = async (f, values) => {
    const doc = await PDFDocument.load(await formPdf(f));
    for (const [name, v] of Object.entries(values)) doc.getForm().getTextField(name).setText(v);
    return doc.save();
  };
  const sent = await expect(bstudent(`/cases/${b}/documents`, { form: file('Antrag.pdf', await filledIn(zul, {
    Matrikelnummer: '1234567', 'Thema – wird in dieser Fassung ins Zeugnis übernommen': 'Modellprädiktive Regelung eines Prüfstands' }), { task_id: (await step(bstudent, 'form')).id }) }));
  assert.deepEqual(sent.form, { title: 'Antrag auf Zulassung zur Bachelor-Thesis', differs: ['Thema (steht so im Zeugnis)'], taken: [] },
    'the uploader learns which field differs; nothing from outside the team goes into the Angaben by itself');
  let team = await view(prof, b);
  const application = team.documents.find(d => d.doc_type === 'application').versions.at(-1);
  assert.deepEqual([application.form.fields.matrikel, team.case.fields.matrikel], ['1234567', ''], 'the value waits for the team');
  assert.ok(team.events.some(e => e.type === 'form.mismatch' && e.payload.fields.includes('Thema (steht so im Zeugnis)')), 'difference logged');
  const theirs = await view(bstudent, b);
  assert.ok(!theirs.documents.flatMap(d => d.versions).some(x => x.form), 'outside the team: no form values (field names only, as told on upload)');
  await put(prof, 'sign_supervisor', 'Antrag-EP.pdf');
  await put(bsecond, 'sign_second', 'Antrag-ZP.pdf');
  await done(bstudent, 'submit_application');
  assert.equal((await step(bstudent, 'thesis')).due_date, null, 'no deadline before the topic is issued');
  await done(prof, 'issued');
  assert.ok(ruleSaid(await view(bstudent, b), 'Fristen nach der Ausgabe mitteilen')?.payload.body.includes(inDays(84)), 'student learns the 12-week date');
  // the exam office's submission date, entered afterwards, becomes the deadline (and moves with an extension)
  await expect(prof(`/cases/${b}/fields`, { method: 'PATCH', body: { fields: { issued: '2027-03-01', deadline: '2027-05-24' } } }));
  for (const k of ['work', 'thesis', 'thesis_office']) assert.equal((await step(prof, k)).due_date, '2027-05-24', `${k}: deadline from the field`);
  await expect(prof(`/cases/${b}/fields`, { method: 'PATCH', body: { fields: { deadline: '2027-06-21' } } })); // extension by 4 weeks
  assert.equal((await step(bstudent, 'thesis')).due_date, '2027-06-21');
  await done(bstudent, 'work');
  await put(bstudent, 'thesis', 'Thesis.pdf');
  assert.ok(ruleSaid(await view(bsecond, b), 'Bewertungsfrist mitteilen'), 'second examiner learns the 6-week limit');
  await done(bstudent, 'thesis_office');
  await expect(prof(`/tasks/${(await step(prof, 'talk')).id}/action`, { body: { action: 'skip' } })); // the presentation is optional
  await expect(bsecond(`/tasks/${(await step(bsecond, 'grade_2')).id}/action`, { body: { action: 'assess', score: '1,7' } }));
  await expect(prof(`/tasks/${(await step(prof, 'grade_1')).id}/action`, { body: { action: 'assess', score: '2,3' } }));
  assert.ok(!(await view(bstudent, b)).tasks.some(t => t.assess), 'single grades stay with the examiners');
  const result = await formOf(prof, 'result_form');
  assert.deepEqual([valueIn(result, 'Note der Bachelor-Thesis'), valueIn(result, 'Ausgegeben am')], ['', '01.03.2027'], 'dates in German format');
  // The examiner types the grade into the form; uploaded by the team, it goes into the still empty field.
  const graded = await expect(prof(`/cases/${b}/documents`, { form: file('Abschlussnote.pdf', await filledIn(result, { 'Note der Bachelor-Thesis': '2,0' }),
    { task_id: (await step(prof, 'result_form')).id }) }));
  assert.deepEqual(graded.form, { title: 'Mitteilung der Note der Bachelor-Thesis', differs: [], taken: ['Note der Bachelor-Thesis'] });
  team = await view(prof, b);
  assert.equal(team.case.fields.grade, '2,0', 'grade taken over from the form');
  assert.ok(team.events.some(e => e.type === 'case.fields_updated' && e.payload.from), 'the log says where it came from');
  await put(bsecond, 'result_sign', 'Abschlussnote-ZP.pdf');
  await done(prof, 'result_office');
  await done(prof, 'booked');
  const final = await view(bstudent, b);
  assert.ok(ruleSaid(final, 'Abschluss mitteilen'), 'student is told it is booked');
  assert.equal((await view(prof, b)).tasks.filter(t => t.status === 'open').length, 0, 'nothing left open');
}

// Master-Thesis (M.Sc.): the same RahmenPO with 18 instead of 12 weeks; the Master forms carry the specialisation.
{
  const mt = (await expect(prof('/templates'))).find(t => t.name === 'Master-Thesis (M.Sc.)');
  const m = (await expect(prof('/cases', { body: { template_id: mt.id, title: 'Master-Thesis Beispiel',
    fields: { student: 'Erika Beispiel', specialisation: 'Mechatronik', thesis_title: 'Regelung eines Prüfstands' } } }))).id;
  const mstep = async key => (await view(prof, m)).tasks.find(t => t.key === key);
  for (const k of ['topic', 'expose', 'expose_review', 'form', 'sign_supervisor', 'sign_second', 'submit_application']) {
    await expect(prof(`/tasks/${(await mstep(k)).id}/action`, { body: { action: 'skip' } }));
  }
  await expect(prof(`/tasks/${(await mstep('issued')).id}/action`, { body: { action: 'complete' } }));
  assert.ok(ruleSaid(await view(prof, m), 'Fristen nach der Ausgabe mitteilen')?.payload.body.includes(inDays(126)), 'the student learns the 18-week date');
  const ext = await expect(prof(`/tasks/${(await mstep('work')).id}/form`));
  assert.deepEqual([ext.title, ext.items.find(it => it.label === 'Vertiefungsrichtung')?.value], ['Antrag auf Verlängerung der Bearbeitungszeit', 'Mechatronik']);
  assert.match(ext.subtitle, /höchstens 22 Wochen/);
  assert.equal((await mstep('work')).title, 'Master-Thesis anfertigen (18 Wochen)');
  await expect(prof(`/cases/${m}`, { method: 'DELETE' }));
}

console.log('ok – praxisprojekt test passed');
