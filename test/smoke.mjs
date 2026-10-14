// End-to-end check against a running `npm run dev` (BASE=http://localhost:8787).
// Walks a Praxisprojekt-like flow (own test template, see fixtures/) and asserts the permission boundaries.
// Leaves demo data behind.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { BASE, run, PDF, fetchOnce, client, expect, file, tokenOf, sql } from './lib.mjs';
import { checkDef } from '../src/templates.js';

// Client handlers live in plain objects: a second `submit.x = …` silently replaces the first (broke template saving once).
const ui = new URL('../public/', import.meta.url);
const handlers = readdirSync(ui, { recursive: true }).filter(f => f.endsWith('.js'))
  .flatMap(f => readFileSync(new URL(f, ui), 'utf8').match(/^(on|submit|change|input)\.\w+ =/gm) ?? []);
assert.deepEqual(handlers.filter((h, i) => handlers.indexOf(h) !== i), [], 'duplicate client handlers');

// Daily mail caps (bulk 80, self-service login links 20) would trip on reruns: locally each run starts with an empty mail log.
if (new URL(BASE).hostname === 'localhost') sql('DELETE FROM mail_log');

const prof = client(), student = client(), office = client();
await expect(prof('/dev-login', { body: { email: 'prof@example.org' } }));

const tpls = await expect(prof('/templates'));
// The test uses its own copy of an earlier Praxisprojekt template, so the real example can evolve freely.
const FIXTURE = 'Praxisprojekt (Testvorlage)';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/praxisprojekt-test.json', import.meta.url)));
const stored = tpls.find(t => t.name === FIXTURE);
if (!stored) await expect(prof('/templates', { body: { workspace_id: 'ws_hs', name: FIXTURE, definition: fixture } }));
else if (JSON.stringify(stored.definition) !== JSON.stringify(checkDef(structuredClone(fixture)))) {
  await expect(prof(`/templates/${stored.id}/versions`, { body: { definition: fixture } })); // the fixture file changed
}
tpls.splice(0, tpls.length, ...await expect(prof('/templates')));
const pp = tpls.find(t => t.name === FIXTURE);
const med = tpls.find(t => t.name === 'Arztrechnung');

const { id: caseId } = await expect(prof('/cases', { body: { template_id: pp.id, title: 'Praxisprojekt Müller', fields: { student: 'Max Müller', matrikel: '123456', start: '2026-10-01' } } }));
const { id: privateId } = await expect(prof('/cases', { body: { template_id: med.id, title: 'Arztrechnung Dr. Weber', fields: { doctor: 'Dr. Weber', start: '2026-10-05', amount: '450 €' } } }));
let pc = await expect(prof(`/cases/${caseId}`));
assert.equal(pc.tasks.find(t => t.title === 'Abschlussbericht abgeben').due_date, '2026-12-24'); // start + 84 days

await expect(prof(`/cases/${caseId}/comments`, { body: { body: 'Bewertung noch mit Kollegen abstimmen.', visible_to: [] } }));
await expect(prof(`/cases/${caseId}/comments`, { body: { body: 'Willkommen! Bitte zuerst die Projektbeschreibung hochladen.', visible_to: ['*'] } }));

// Invitation: single use, gives access to exactly this case.
const { link } = await expect(prof(`/cases/${caseId}/invitations`, { body: { email: `max.${run}@example.org`, role: 'student', access_until: '2027-03-31' } }));
await expect(student('/invitations/accept', { body: { token: tokenOf(link), name: 'Max Müller' } }));
await expect(client()('/invitations/accept', { body: { token: tokenOf(link), name: 'Mallory' } }), 404);

const dash = await expect(student('/dashboard'));
assert.deepEqual(dash.cases.map(c => c.id), [caseId]);
await expect(student(`/cases/${privateId}`), 404);
await expect(student('/cases', { body: { template_id: pp.id, title: 'x' } }), 403);
await expect(student('/templates')).then(t => assert.equal(t.length, 0));

// Admin overview: only for workspace owners; shows seats with role labels and open invitations.
await expect(student('/people'), 403);
await expect(prof(`/cases/${caseId}/invitations`, { body: { email: `later.${run}@example.org`, role: 'office' } }));
const admin = await expect(prof('/people'));
const max = admin.people.find(u => u.email === `max.${run}@example.org`);
assert.deepEqual(max.cases.map(c => [c.case_id, c.role, c.access, c.active]), [[caseId, 'Studierende:r', 'guest_contributor', true]]);
assert.equal(max.passkeys, 0);
assert.ok(max.last_seen, 'joining counts as activity');
assert.ok(admin.invitations.some(i => i.email === `later.${run}@example.org` && i.case_id === caseId));
assert.ok(admin.people.some(u => u.email === 'prof@example.org' && u.workspaces));

// Live updates: the change stamp in the payload matches the cheap poll and moves when someone else acts.
const stampNow = (who, c) => expect(who(`/changes${c ? `?case=${c}` : ''}`)).then(r => r.stamp);
const before = await expect(student(`/cases/${caseId}`));
assert.equal(await stampNow(student, caseId), before.stamp);
assert.equal(await stampNow(student), (await expect(student('/dashboard'))).stamp);
const dashBefore = await stampNow(student);
await expect(prof(`/cases/${caseId}/comments`, { body: { body: 'Kurze Info an alle.', visible_to: ['*'] } }));
assert.notEqual(await stampNow(student, caseId), before.stamp);
assert.notEqual(await stampNow(student), dashBefore);
await expect(student(`/changes?case=${privateId}`), 404);

let sc = await expect(student(`/cases/${caseId}`));
const task = title => sc.tasks.find(t => t.title === title);
assert.equal(sc.me.staff, false);
// Students see their own steps plus the ones shared with them (per-step visibility), never internal ones.
assert.ok(sc.tasks.some(t => t.title === 'Antrag prüfen' && t.role === 'supervisor'), 'shared step is visible');
assert.ok(!sc.tasks.some(t => t.title === 'Bewerten'), 'internal step is hidden');
assert.ok(sc.tasks.every(t => t.role === 'student' || t.visible_to.includes('student')));
const comments = sc.events.filter(e => e.type === 'comment').map(e => e.payload.body);
assert.ok(comments.some(b => b.startsWith('Willkommen')), 'shared comment visible');
assert.ok(!comments.some(b => b.startsWith('Bewertung')), 'internal comment hidden');
assert.deepEqual(sc.case.fields, {}, 'externals get no field values (Matrikel-Nr. …)');
assert.equal(sc.definition.rules, undefined, 'nor the rules');

// Uploads: content must match extension, dependencies must be done.
await expect(student(`/cases/${caseId}/documents`, { form: file('evil.exe', 'MZ') }), 415);
await expect(student(`/cases/${caseId}/documents`, { form: file('evil.pdf', '<script>alert(1)</script>') }), 422);
const scripted = await expect(student(`/cases/${caseId}/documents`, { form: file('Antrag.pdf', `${PDF}1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n`) }), 422);
assert.match(scripted.error, /aktive Inhalte \(JavaScript\)/);
assert.ok((await expect(prof(`/cases/${caseId}`))).events.some(e => e.type === 'upload.rejected' && e.payload.filename === 'Antrag.pdf'), 'rejected upload is logged for staff');
await expect(student(`/cases/${caseId}/documents`, { form: file('Antrag.pdf', PDF, { task_id: task('Antrag hochladen').id }) }), 409);
await expect(student(`/cases/${caseId}/documents`, { form: file('Projektbeschreibung.pdf', PDF, { task_id: task('Projektbeschreibung hochladen').id }) }));
await expect(student(`/cases/${caseId}/documents`, { form: file('Bogen.pdf', PDF, { doc_type: 'grading' }) }), 403); // type not shared with them
const descDoc = (await expect(student(`/cases/${caseId}`))).documents.find(d => d.doc_type === 'description');
// SHA-256 per version: computed by the server if the client sends none, otherwise checked by the storage on put.
const hashOf = text => createHash('sha256').update(text).digest('hex');
assert.equal(descDoc.versions[0].sha256, hashOf(PDF));
const appendix = `${PDF}% Anhang\n`;
await expect(student(`/cases/${caseId}/documents`, { form: file('Anhang.pdf', appendix, { document_id: descDoc.id, sha256: hashOf(PDF) }) }), 400);
await expect(student(`/cases/${caseId}/documents`, { form: file('Anhang.pdf', appendix, { document_id: descDoc.id, sha256: 'x'.repeat(64) }) }), 400);
await expect(student(`/cases/${caseId}/documents`, { form: file('Anhang.pdf', appendix, { document_id: descDoc.id, sha256: hashOf(appendix) }) }));
const hashed = await expect(student(`/cases/${caseId}`));
assert.equal(hashed.documents.find(d => d.id === descDoc.id).versions.at(-1).sha256, hashOf(appendix));
assert.equal(hashed.events.findLast(e => e.type === 'document.uploaded').payload.sha256, hashOf(appendix));
await expect(student(`/cases/${caseId}/documents`, { form: file('x.pdf', PDF, { task_id: task('Antrag hochladen').id, document_id: descDoc.id }) }), 403);
await expect(student(`/cases/${caseId}/documents`, { form: file('Antrag-Entwurf.pdf', PDF, { task_id: task('Antrag hochladen').id }) }));

// "Rückfrage" on the review reopens the upload; the re-upload becomes version 2.
pc = await expect(prof(`/cases/${caseId}`));
const review = pc.tasks.find(t => t.title === 'Antrag prüfen');
const sign = pc.tasks.find(t => t.title === 'Antrag unterschreiben');
await expect(student(`/tasks/${review.id}/action`, { body: { action: 'approve' } }), 403); // visible, but not theirs
const grade = pc.tasks.find(t => t.title === 'Bewerten');
await expect(student(`/tasks/${grade.id}`, { method: 'PATCH', body: { visible_to: ['student'] } }), 404);
await expect(prof(`/tasks/${grade.id}`, { method: 'PATCH', body: { visible_to: ['student'] } }));
assert.ok((await expect(student(`/cases/${caseId}`))).tasks.some(t => t.id === grade.id), 'staff can share a step');
await expect(prof(`/tasks/${grade.id}`, { method: 'PATCH', body: { visible_to: [] } }));
assert.ok(!(await expect(student(`/cases/${caseId}`))).tasks.some(t => t.id === grade.id));
await expect(prof(`/tasks/${review.id}/action`, { body: { action: 'question', note: 'Bitte die Methoden ergänzen.' } }));
sc = await expect(student(`/cases/${caseId}`));
assert.equal(task('Antrag hochladen').status, 'open');
assert.ok(sc.events.some(e => e.payload.note === 'Bitte die Methoden ergänzen.'), 'student sees the question');
await expect(student(`/cases/${caseId}/documents`, { form: file('Antrag-korrigiert.pdf', PDF, { task_id: task('Antrag hochladen').id }) }));
await expect(prof(`/tasks/${review.id}/action`, { body: { action: 'approve' } }));
sc = await expect(student(`/cases/${caseId}`));
assert.ok(sc.events.some(e => e.type === 'task.approve' && e.payload.task === 'Antrag prüfen'), 'student learns the review outcome');
assert.deepEqual(sc.case.waiting_on, ['Betreuer:in'], 'student sees whom the case waits for');
// A signature needs the signed file; "done" without it is refused.
await expect(prof(`/tasks/${sign.id}/action`, { body: { action: 'complete' } }), 400);
await expect(prof(`/cases/${caseId}/documents`, { form: file('Antrag-unterschrieben.pdf', PDF, { task_id: sign.id }) }));
sc = await expect(student(`/cases/${caseId}`));
const application = sc.documents.find(d => d.doc_type === 'application');
assert.deepEqual(application.versions.map(v => v.filename), ['Antrag-Entwurf.pdf', 'Antrag-korrigiert.pdf', 'Antrag-unterschrieben.pdf']);
// Each version remembers the task it was uploaded through; the Rückfrage names the task it reopened.
assert.deepEqual(application.versions.map(v => v.task_id), [task('Antrag hochladen').id, task('Antrag hochladen').id, sign.id]);
assert.ok(sc.events.some(e => e.type === 'task.question' && e.payload.reopened.includes(task('Antrag hochladen').id)));
assert.ok(sc.events.some(e => e.type === 'document.uploaded' && e.payload.completed && e.payload.task === 'Projektbeschreibung hochladen'));
assert.ok(!sc.events.some(e => e.type === 'task.complete'), 'upload and completion are one event');
// Guests can't replace the signed version outside a task, but may revise their own latest upload.
assert.equal(application.can_version, false);
await expect(student(`/cases/${caseId}/documents`, { form: file('Antrag-v4.pdf', PDF, { document_id: application.id }) }), 403);
const description = sc.documents.find(d => d.doc_type === 'description');
assert.equal(description.can_version, true);
await expect(student(`/cases/${caseId}/documents`, { form: file('Projektbeschreibung-2.pdf', PDF, { document_id: description.id }) }));
const wrongUpload = (await expect(student(`/cases/${caseId}`))).documents.find(d => d.doc_type === 'description').versions.at(-1);
await expect(student(`/document-versions/${application.versions.at(-1).id}`, { method: 'DELETE' }), 403); // not theirs
await expect(student(`/document-versions/${wrongUpload.id}`, { method: 'DELETE' }));
await expect(student(`/files/${wrongUpload.id}`), 404);

// Prüfungsamt (guest_viewer) sees only the application, can't upload, loses access on revoke.
const inv2 = await expect(prof(`/cases/${caseId}/invitations`, { body: { email: `pa.${run}@example.org`, role: 'office' } }));
await expect(office('/invitations/accept', { body: { token: tokenOf(inv2.link), name: 'Prüfungsamt' } }));
const oc = await expect(office(`/cases/${caseId}`));
assert.deepEqual(oc.documents.map(d => d.doc_type), ['application']);
assert.deepEqual(oc.tasks.map(t => t.title), ['Antrag beim Prüfungsamt einreichen', 'Genehmigung erhalten', 'Note an Prüfungsamt melden']);
const descVersion = sc.documents.find(d => d.doc_type === 'description').versions[0].id;
await expect(student(`/files/${descVersion}`));
await expect(office(`/files/${descVersion}`), 404);
await expect(office(`/cases/${caseId}/documents`, { form: file('x.pdf', PDF) }), 403);
await expect(office(`/cases/${caseId}/comments`, { body: { body: 'http://[a' } }), 403); // read-only
await expect(prof(`/cases/${caseId}/comments`, { body: { body: 'x'.repeat(10001), visible_to: [] } }), 413);

// Guests can't edit the process, but can file a request that becomes an owner decision.
await expect(student(`/cases/${caseId}/tasks`, { body: { title: 'Verlängerung um 4 Wochen', description: 'Projektstart im Unternehmen hat sich verschoben.', type: 'task', role: 'student' } }));
pc = await expect(prof(`/cases/${caseId}`));
const request = pc.tasks.find(t => t.title === 'Verlängerung um 4 Wochen');
assert.equal(request.type, 'decision');
assert.equal(request.role, 'supervisor');
await expect(prof(`/tasks/${request.id}/action`, { body: { action: 'approve', note: 'Einverstanden.' } }));
sc = await expect(student(`/cases/${caseId}`));
assert.ok(sc.events.some(e => e.type === 'task.approve' && e.payload.task === 'Verlängerung um 4 Wochen'), 'student sees the decision');

// Login links by mail: the owner can send one to a participant (throttled), anyone can request one for their address.
const studentUser = pc.participants.find(p => p.email === `max.${run}@example.org`);
assert.ok((await expect(prof(`/cases/${caseId}/participants/${studentUser.user_id}/login-link`, { body: {} }))).link);
await expect(prof(`/cases/${caseId}/participants/${studentUser.user_id}/login-link`, { body: {} }), 429);
assert.deepEqual(await expect(client()('/login-link/request', { body: { email: `nobody.${run}@example.org` } })), { ok: true });
const selfService = await expect(client()('/login-link/request', { body: { email: `pa.${run}@example.org` } }));
const viaLink = client();
await expect(viaLink('/login-link', { body: { token: selfService.link.split('/#/login/')[1] } }));
assert.equal((await expect(viaLink('/me'))).user.email, `pa.${run}@example.org`);

const officeUser = pc.participants.find(p => p.email === `pa.${run}@example.org`);
const backdoor = await expect(prof(`/cases/${caseId}/invitations`, { body: { email: `pa.${run}@example.org`, role: 'office' } }));
await expect(prof(`/cases/${caseId}/participants/${officeUser.user_id}`, { method: 'DELETE' }));
await expect(office('/invitations/accept', { body: { token: tokenOf(backdoor.link) } }), 404, 'revoke removed the open invitation');
const typo = await expect(prof(`/cases/${caseId}/invitations`, { body: { email: `tippfehler.${run}@example.org`, role: 'student' } }));
await expect(prof(`/cases/${caseId}/invitations/${encodeURIComponent(`tippfehler.${run}@example.org`)}`, { method: 'DELETE' }));
await expect(client()('/invitations/accept', { body: { token: tokenOf(typo.link), name: 'x' } }), 404);
for (let i = 0; i < 4; i++) await expect(prof(`/cases/${caseId}/invitations`, { body: { email: `viel.${run}@example.org`, role: 'student' } }));
await expect(prof(`/cases/${caseId}/invitations`, { body: { email: `viel.${run}@example.org`, role: 'student' } }));
await expect(prof(`/cases/${caseId}/invitations`, { body: { email: `viel.${run}@example.org`, role: 'student' } }), 429); // 5 per address and day
await expect(office(`/cases/${caseId}`), 404);

// Finance (spec example): invoice 450 € paid; PKV recognizes 225 €; Beihilfe recognizes 190 € of 225 € and pays.
const claimIn = async (id, body) => (await expect(prof(`/cases/${id}/claims`, { body }))).id;
const claim = body => claimIn(privateId, body);
const invoice = await claim({ title: 'Rechnung', counterparty: 'Dr. Weber', direction: 'payable', amount_cents: 45000 });
const pkv = await claim({ title: 'PKV', counterparty: 'PKV', direction: 'receivable', amount_cents: 22500 });
const aid = await claim({ title: 'Beihilfe', counterparty: 'Beihilfestelle', direction: 'receivable', amount_cents: 22500 });
await expect(prof(`/cases/${privateId}/claims`, { body: { title: 'x', direction: 'receivable', amount_cents: 12.5 } }), 400);
await expect(prof(`/claims/${invoice}/transactions`, { body: { amount_cents: 45000, booked_on: '2026-10-06' } }));
await expect(prof(`/claims/${pkv}/decisions`, { body: { approved_cents: 22500, decided_on: '2026-10-10' } }));
await expect(prof(`/claims/${aid}/decisions`, { body: { approved_cents: 19000, decided_on: '2026-10-11', note: 'Bescheid Nr. 4711' } }));
await expect(prof(`/claims/${aid}/transactions`, { body: { amount_cents: 19000 } }));
// A wrong booking is corrected by a reversal, never edited; reversals can't be reversed or repeated.
await expect(prof(`/claims/${aid}/transactions`, { body: { amount_cents: 1900 } }));
let mc = await expect(prof(`/cases/${privateId}`));
const wrong = mc.finance.claims.find(c => c.id === aid).transactions.at(-1);
await expect(prof(`/transactions/${wrong.id}/reverse`, { body: { note: 'Tippfehler' } }));
await expect(prof(`/transactions/${wrong.id}/reverse`, { body: {} }), 409);
mc = await expect(prof(`/cases/${privateId}`));
const reversal = mc.finance.claims.find(c => c.id === aid).transactions.at(-1);
assert.equal(reversal.amount_cents, -1900);
await expect(prof(`/transactions/${reversal.id}/reverse`, { body: {} }), 400);
assert.deepEqual(mc.finance.totals, {
  paid_cents: 45000, open_payable_cents: 0,
  requested_cents: 45000, received_cents: 19000, cut_cents: 3500, open_receivable_cents: 22500,
  own_share_cents: 26000,
});
assert.ok(mc.tasks.some(t => t.title === 'Kürzung prüfen: Beihilfe' && t.role === 'me'), 'cut creates a review task');
await expect(prof(`/tasks/${mc.tasks.find(t => t.title === 'Kürzung prüfen: Beihilfe').id}/action`, { body: { action: 'question', note: 'x' } }), 400);
// On a decision task an upload is only attached; the decision completes it.
const { id: check } = await expect(prof(`/cases/${privateId}/tasks`, { body: { title: 'Bescheid prüfen', type: 'approval', role: 'me', doc_type: 'aid_decision' } }));
await expect(prof(`/cases/${privateId}/documents`, { form: file('Bescheid.pdf', PDF, { task_id: check }) }));
assert.equal((await expect(prof(`/cases/${privateId}`))).tasks.find(t => t.id === check).status, 'open');
await expect(prof(`/tasks/${check}/action`, { body: { action: 'approve' } }));
// A new role can be created while inviting.
const advisor = await expect(prof(`/cases/${privateId}/invitations`, { body: { email: `stb.${run}@example.org`, new_role: { label: 'Steuerberater', access: 'guest_viewer' } } }));
assert.ok((await expect(prof(`/cases/${privateId}`))).definition.roles.some(r => r.key === advisor.role && r.label === 'Steuerberater'));
assert.equal(mc.tasks.find(t => t.title === 'Rechnung bezahlen').status, 'done', 'paying everything in the panel completes the payment task (rule)');
// Rules are per case and can be switched off there.
await expect(prof(`/cases/${privateId}/rules/kuerzung`, { method: 'PATCH', body: { enabled: false } }));
const extra = await claim({ title: 'Zusatzversicherung', direction: 'receivable', amount_cents: 5000 });
await expect(prof(`/claims/${extra}/decisions`, { body: { approved_cents: 1000 } }));
assert.ok(!(await expect(prof(`/cases/${privateId}`))).tasks.some(t => t.title === 'Kürzung prüfen: Zusatzversicherung'), 'switched-off rule does nothing');
await expect(prof(`/cases/${privateId}/rules/kuerzung`, { method: 'PATCH', body: { enabled: true } }));
await expect(student(`/cases/${caseId}/rules/genehmigt`, { method: 'PATCH', body: { enabled: false } }), 403);
await expect(prof(`/templates/${pp.id}/versions`, { body: { definition: { ...pp.definition, rules: [{ id: 'x', name: 'x', trigger: 'nope', actions: [] }] } } }), 400);

// Money steps on template tasks: the whole case runs through its tasks, the finance overview follows.
const { id: viaTasks } = await expect(prof('/cases', { body: { template_id: med.id, title: 'Arztrechnung Dr. Kurz', fields: { doctor: 'Dr. Kurz', start: '2026-10-08' } } }));
let kc = await expect(prof(`/cases/${viaTasks}`));
const kt = title => kc.tasks.find(t => t.title === title).id;
const doTask = (title, amount_cents) => expect(prof(`/tasks/${kt(title)}/action`, { body: { action: 'complete', amount_cents } }));
await expect(prof(`/cases/${viaTasks}/documents`, { form: file('Rechnung-Kurz.pdf', PDF, { task_id: kt('Rechnung erfassen') }) }), 400); // no amount, no claim
await expect(prof(`/cases/${viaTasks}/documents`, { form: file('Rechnung-Kurz.pdf', PDF, { task_id: kt('Rechnung erfassen'), amount_cents: '30000' }) }));
await doTask('Bei PKV einreichen', 15000);
await doTask('Bei Beihilfe einreichen', 15000);
await doTask('PKV-Bescheid erfassen', 15000);
await expect(prof(`/cases/${viaTasks}/documents`, { form: file('Beihilfebescheid.pdf', PDF, { task_id: kt('Beihilfebescheid erfassen'), amount_cents: '12000' }) }));
await doTask('Rechnung bezahlen', 30000);
await doTask('PKV-Erstattung eingegangen', 15000);
kc = await expect(prof(`/cases/${viaTasks}`));
assert.equal(kc.finance.claims.find(c => c.title === 'Rechnung').counterparty, 'Dr. Kurz');
assert.deepEqual(kc.finance.totals, {
  paid_cents: 30000, open_payable_cents: 0,
  requested_cents: 30000, received_cents: 15000, cut_cents: 3000, open_receivable_cents: 12000,
  own_share_cents: 15000,
});
assert.ok(kc.tasks.some(t => t.title === 'Kürzung prüfen: Beihilfe'), 'a cut recorded through a task triggers the review too');
assert.equal(kc.tasks.find(t => t.title === 'Beihilfe-Erstattung eingegangen').status, 'open');
// A money step can be booked later, straight from its task.
await expect(prof(`/tasks/${kt('Beihilfe-Erstattung eingegangen')}/money`, { body: { amount_cents: 12000 } }));
assert.equal((await expect(prof(`/cases/${viaTasks}`))).finance.totals.open_receivable_cents, 0);
await expect(student(`/tasks/${kt('Beihilfe-Erstattung eingegangen')}/money`, { body: { amount_cents: 1 } }), 404);

// Upload links: someone without an account hands in one file for one task, and gets nothing else.
const { id: linked } = await expect(prof('/cases', { body: { template_id: med.id, title: 'Arztrechnung Upload-Link', fields: { doctor: 'Dr. Link' } } }));
let lc = await expect(prof(`/cases/${linked}`));
const invoiceTask = lc.tasks.find(t => t.title === 'Rechnung erfassen').id;
await expect(student(`/tasks/${invoiceTask}/upload-links`, { body: { label: 'x' } }), 404);
const upToken = (await expect(prof(`/tasks/${invoiceTask}/upload-links`, { body: { label: 'Praxis Dr. Link', days: 7 } }))).link.split('/#/upload/')[1];
const anon = client();
assert.deepEqual(Object.keys(await expect(anon(`/upload-links/${upToken}`))).sort(), ['document', 'expires_at', 'label', 'requester', 'task'], 'nothing about the case');
await expect(anon(`/upload-links/${upToken}`, { form: file('evil.pdf', '<html>') }), 422); // rejected, link stays usable
await expect(anon(`/upload-links/${upToken}`, { form: file('Rechnung-Link.pdf', PDF) }));
await expect(anon(`/upload-links/${upToken}`, { form: file('nochmal.pdf', PDF) }), 404); // single use
await expect(anon(`/cases/${linked}`), 401);
lc = await expect(prof(`/cases/${linked}`));
assert.equal(lc.documents.find(d => d.doc_type === 'invoice').versions[0].uploader, 'Praxis Dr. Link');
assert.equal(lc.tasks.find(t => t.id === invoiceTask).status, 'done');
assert.ok(lc.events.some(e => e.type === 'document.uploaded' && e.payload.via === 'Praxis Dr. Link' && e.actor_id === null));
assert.ok(lc.events.some(e => e.type === 'upload.rejected' && e.payload.via === 'Praxis Dr. Link'), 'rejected file is logged');
const bescheid = lc.tasks.find(t => t.title === 'PKV-Bescheid erfassen').id;
const revokedToken = (await expect(prof(`/tasks/${bescheid}/upload-links`, { body: { label: 'PKV' } }))).link.split('/#/upload/')[1];
assert.equal((await expect(prof(`/cases/${linked}`))).upload_links.length, 1);
await expect(prof(`/tasks/${bescheid}/upload-links`, { method: 'DELETE' }));
await expect(anon(`/upload-links/${revokedToken}`), 404);
const multiUse = (await expect(prof(`/tasks/${bescheid}/upload-links`, { body: { label: 'PKV', single_use: false } }))).link.split('/#/upload/')[1];
await expect(anon(`/upload-links/${multiUse}`));
await expect(prof(`/tasks/${bescheid}/action`, { body: { action: 'skip' } }));
await expect(anon(`/upload-links/${multiUse}`), 404, 'task no longer open');
// Writes only from our own pages (CSRF from sibling subdomains).
assert.equal((await fetchOnce(`${BASE}/api/logout`, { method: 'POST', headers: { origin: 'https://evil.example.net' } })).status, 403);

// Subcases: "Beanstanden" on the cut review creates the objection as a subcase (rule), closing it reports to the parent.
await expect(prof(`/tasks/${kt('Kürzung prüfen: Beihilfe')}/action`, { body: { action: 'reject', note: 'Widerspruch einlegen' } }));
kc = await expect(prof(`/cases/${viaTasks}`));
assert.deepEqual(kc.subcases.map(c => c.title), ['Widerspruch – Kürzung prüfen: Beihilfe']);
const objection = await expect(prof(`/cases/${kc.subcases[0].id}`));
assert.equal(objection.parent.id, viaTasks);
assert.ok(objection.tasks.some(t => t.title === 'Widerspruch schreiben'));
await expect(prof(`/cases/${objection.case.id}`, { method: 'PATCH', body: { status: 'closed' } }));
assert.ok((await expect(prof(`/cases/${viaTasks}`))).events.some(e => e.type === 'subcase.closed' && e.payload.case_id === objection.case.id));
const closedCard = (await expect(prof('/dashboard'))).cases.find(c => c.id === objection.case.id);
assert.equal(closedCard.next_due, null, 'a closed case has no deadlines');
assert.ok(!(await expect(prof('/dashboard'))).my_tasks.some(t => t.case_id === objection.case.id), 'nor tasks for anyone');

// Manual subcases: same workspace only; listed only for people who may open them; guests of the subcase don't learn the parent.
const free = tpls.find(t => t.name === 'Freier Vorgang' && t.workspace_id === 'ws_hs');
await expect(prof(`/cases/${caseId}/subcases`, { body: { template_id: med.id, title: 'x' } }), 400);
await expect(student(`/cases/${caseId}/subcases`, { body: { template_id: free.id, title: 'x' } }), 403);
const { id: extension } = await expect(prof(`/cases/${caseId}/subcases`, { body: { template_id: free.id, title: 'Verlängerungsantrag' } }));
assert.ok((await expect(prof(`/cases/${caseId}`))).subcases.some(c => c.id === extension));
assert.ok(!(await expect(student(`/cases/${caseId}`))).subcases.length, 'student is not part of the subcase');
const subGuest = client();
const subInvite = await expect(prof(`/cases/${extension}/invitations`, { body: { email: `sub.${run}@example.org`, role: 'guest' } }));
await expect(subGuest('/invitations/accept', { body: { token: tokenOf(subInvite.link), name: 'Nur Teilvorgang' } }));
assert.equal((await expect(subGuest(`/cases/${extension}`))).parent, null, 'parent title not revealed');
assert.equal((await expect(subGuest('/dashboard'))).cases[0].parent_title, null);
const { id: parentToGo } = await expect(prof('/cases', { body: { template_id: free.id, title: 'Elternvorgang' } }));
const { id: childToGo } = await expect(prof(`/cases/${parentToGo}/subcases`, { body: { template_id: free.id, title: 'Kindvorgang' } }));
await expect(prof(`/cases/${parentToGo}`, { method: 'DELETE' }));
await expect(prof(`/cases/${childToGo}`), 404, 'subcases go with their parent');

const profDash = await expect(prof('/dashboard'));
assert.equal(profDash.cases.find(c => c.id === privateId).open_receivable_cents, 22500 + 1000); // PKV + Zusatzversicherung (rule test)
assert.ok(profDash.open_receivable_cents >= 23500);
// Guests never see money, not even in their own case.
assert.equal(sc.finance, null);
await expect(student(`/cases/${caseId}/claims`, { body: { title: 'x', direction: 'payable', amount_cents: 1 } }), 404);
await expect(student(`/claims/${aid}/transactions`, { body: { amount_cents: 1 } }), 404);

// Daily digest (needs `wrangler dev --test-scheduled`, checked in the local D1): new tasks and messages are
// mailed once, a second run stays quiet, a reopened task is announced again.
if (new URL(BASE).hostname === 'localhost') {
  const digestOf = email => sql(`SELECT u.last_digest_at, (SELECT COUNT(*) FROM notifications n WHERE n.user_id = u.id) AS n FROM users u WHERE u.email = '${email}'`)[0];
  const runDigest = async () => assert.equal((await fetchOnce(`${BASE}/__scheduled?cron=0+5+*+*+*`)).status, 200);
  await runDigest();
  const profFirst = digestOf('prof@example.org');
  assert.ok(profFirst.n > 0 && profFirst.last_digest_at, 'owner gets a digest with tasks');
  assert.equal(digestOf(`max.${run}@example.org`).last_digest_at, null, 'messages go out as progress mails, not in the digest');
  await runDigest();
  assert.deepEqual(digestOf('prof@example.org'), profFirst, 'nothing new → no second mail');
  const cut = mc.tasks.find(t => t.title === 'Kürzung prüfen: Beihilfe');
  await expect(prof(`/tasks/${cut.id}/action`, { body: { action: 'approve' } }));
  await expect(prof(`/tasks/${cut.id}/action`, { body: { action: 'reopen' } }));
  await runDigest();
  assert.notEqual(digestOf('prof@example.org').last_digest_at, profFirst.last_digest_at, 'reopened task is announced again');
  // Deleting a case removes everything, files and immutable bookings included; guests who were only in it lose their account.
  const free = tpls.find(t => t.name === 'Freier Vorgang' && t.workspace_id === 'ws_hs');
  const { id: doomed } = await expect(prof('/cases', { body: { template_id: free.id, title: 'Löschtest' } }));
  const delInvite = await expect(prof(`/cases/${doomed}/invitations`, { body: { email: `del.${run}@example.org`, role: 'guest' } }));
  const delGuest = client();
  await expect(delGuest('/invitations/accept', { body: { token: tokenOf(delInvite.link), name: 'Kurzzeitgast' } }));
  await expect(delGuest(`/cases/${doomed}/documents`, { form: file('Notiz.pdf', PDF) }));
  const delClaim = await claimIn(doomed, { title: 'Test', direction: 'payable', amount_cents: 100 });
  await expect(prof(`/claims/${delClaim}/transactions`, { body: { amount_cents: 100 } }));
  const [{ r2_key }] = sql(`SELECT v.r2_key FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.case_id = '${doomed}'`);
  await expect(delGuest(`/cases/${doomed}`, { method: 'DELETE' }), 403);
  await expect(prof(`/cases/${doomed}`, { method: 'DELETE' }));
  await expect(prof(`/cases/${doomed}`), 404);
  assert.equal((await expect(delGuest('/me'))).user, null, 'guest account is gone');
  assert.deepEqual(sql(`SELECT reason FROM case_deletions WHERE case_id = '${doomed}'`), [{ reason: 'manual' }]);
  assert.deepEqual(sql(`SELECT (SELECT COUNT(*) FROM events WHERE case_id = '${doomed}') + (SELECT COUNT(*) FROM financial_claims WHERE case_id = '${doomed}') AS n`), [{ n: 0 }]);
  assert.throws(() => execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `nomocase-files/${r2_key}`, '--local', '--pipe'], { stdio: 'pipe' }), 'file is gone from R2');
  assert.throws(() => sql(`DELETE FROM events WHERE case_id = '${caseId}'`), e => /append-only/.test(`${e.stdout}${e.stderr}`), 'other cases stay append-only');

  // Retention: 14 days ahead the owner is told, at the end of the period the case is deleted.
  const short = tpls.find(t => t.name === 'Kurzlebig') ?? { id: (await expect(prof('/templates', { body: { workspace_id: 'ws_hs', name: 'Kurzlebig',
    definition: { retention_days: 30, roles: [{ key: 'owner', label: 'Verantwortlich', access: 'case_owner' }], phases: [{ title: 'Allgemein', tasks: [] }] } } }))).id };
  const { id: aging } = await expect(prof('/cases', { body: { template_id: short.id, title: 'Aufbewahrungstest' } }));
  await expect(prof(`/cases/${aging}`, { method: 'PATCH', body: { status: 'closed' } }));
  const closedAgo = days => sql(`UPDATE cases SET closed_at = '${new Date(Date.now() - days * 864e5).toISOString()}' WHERE id = '${aging}'`);
  closedAgo(20);
  await runDigest();
  assert.equal(sql(`SELECT COUNT(*) AS n FROM notifications WHERE task_id = '${aging}' AND stage = 'retention'`)[0].n, 1, 'deletion is announced');
  await expect(prof(`/cases/${aging}`));
  closedAgo(31);
  await runDigest();
  await expect(prof(`/cases/${aging}`), 404);
  assert.deepEqual(sql(`SELECT reason FROM case_deletions WHERE case_id = '${aging}'`), [{ reason: 'retention' }]);

  // Rules never trigger on what rules caused (no loops) and run once per event, even if events are looked at again.
  const echo = tpls.find(t => t.name === 'Regeltest') ?? { id: (await expect(prof('/templates', { body: { workspace_id: 'ws_hs', name: 'Regeltest', definition: {
    roles: [{ key: 'owner', label: 'Verantwortlich', access: 'case_owner' }], phases: [{ title: 'Allgemein', tasks: [] }],
    rules: [{ id: 'echo', name: 'Echo', trigger: 'comment', conditions: [{ field: 'comment.text', operator: 'contains', value: 'hallo' }],
      actions: [{ type: 'add_comment', text: 'Echo: {comment.text}' }] }] } } }))).id };
  const { id: echoCase } = await expect(prof('/cases', { body: { template_id: echo.id, title: 'Regeltest' } }));
  // Rules refer to steps by key; an unknown key is a template error, not a rule that silently never fires.
  const typo = await expect(prof('/templates', { body: { workspace_id: 'ws_hs', name: `Tippfehler ${run}`, definition: {
    roles: [{ key: 'owner', label: 'Verantwortlich', access: 'case_owner' }], phases: [{ title: 'Allgemein', tasks: [{ key: 'pruefen', title: 'Prüfen' }] }],
    rules: [{ id: 'r', name: 'Nach dem Prüfen', trigger: 'task.complete', conditions: [{ field: 'task.key', operator: 'equals', value: 'pruefn' }],
      actions: [{ type: 'add_comment', text: 'geprüft' }] }] } } }), 400);
  assert.match(typo.error, /Schritt "pruefn" gibt es nicht/);
  // A rule whose action fails is recorded as failed and shown with the reason; it is not retried forever.
  const brokenTpl = tpls.find(t => t.name === 'Regeltest Fehlerfall') ?? { id: (await expect(prof('/templates', { body: { workspace_id: 'ws_hs', name: 'Regeltest Fehlerfall', definition: {
    roles: [{ key: 'owner', label: 'Verantwortlich', access: 'case_owner' }], phases: [{ title: 'Allgemein', tasks: [] }],
    rules: [{ id: 'kaputt', name: 'Kaputt', trigger: 'comment', conditions: [], actions: [{ type: 'create_subcase', template: 'Gibt es nicht', title: 'Widerspruch' }] }] } } }))).id };
  const { id: brokenCase } = await expect(prof('/cases', { body: { template_id: brokenTpl.id, title: 'Regeltest Fehlerfall' } }));
  await expect(prof(`/cases/${brokenCase}/comments`, { body: { body: 'löst die Regel aus', visible_to: ['*'] } }));
  await runDigest(); // the cron catch-up must not run it again
  const [broken] = (await expect(prof(`/cases/${brokenCase}`))).rule_runs;
  assert.deepEqual([broken.rule_id, broken.n, broken.errors], ['kaputt', 0, 1]);
  assert.match(broken.error, /Gibt es nicht/);
  await expect(prof(`/cases/${echoCase}/comments`, { body: { body: 'Hallo Welt', visible_to: ['*'] } }));
  await expect(prof(`/cases/${echoCase}/comments`, { body: { body: 'ohne Stichwort', visible_to: ['*'] } }));
  const echoes = () => sql(`SELECT COUNT(*) AS n FROM events WHERE case_id = '${echoCase}' AND json_extract(payload, '$.rule') = 'Echo'`)[0].n;
  assert.equal(echoes(), 1, 'one echo: condition holds once, and the echo itself does not echo');
  const [{ first }] = sql(`SELECT MIN(id) AS first FROM events WHERE case_id = '${echoCase}' AND type = 'comment'`);
  sql(`UPDATE rule_cursor SET last_event_id = ${first - 1}`);
  await runDigest();
  assert.equal(echoes(), 1, 'looking at the same events again changes nothing');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM automation_runs WHERE case_id = '${echoCase}' AND status = 'done'`)[0].n, 1);

  // Self-service login links stop at a daily cap, so strangers cannot use up the mail quota.
  const capDay = `${new Date().toISOString().slice(0, 10)}T00:00:01.000Z`;
  sql(`INSERT INTO mail_log (bulk, kind, sent_at) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20) SELECT 0, 'login_request', '${capDay}' FROM n`);
  assert.deepEqual(await expect(client()('/login-link/request', { body: { email: `pa.${run}@example.org` } })), { ok: true }, 'capped: no mail, same answer');
  assert.ok((await expect(client()('/login-link/request', { body: { email: `pa.${run}@example.org` } }))).link === undefined);
  sql(`DELETE FROM mail_log WHERE sent_at = '${capDay}'`);
  assert.ok((await expect(client()('/login-link/request', { body: { email: `pa.${run}@example.org` } }))).link, 'below the cap the link goes out again');

  // Progress mails: bundled news from others, at most one per 20 minutes, and never beyond the daily cap.
  const runProgress = async () => assert.equal((await fetchOnce(`${BASE}/__scheduled?cron=*/20+*+*+*+*`)).status, 200);
  const progressOf = email => sql(`SELECT progress_mail_at AS at FROM users WHERE email = '${email}'`)[0].at;
  const studentMail = `max.${run}@example.org`;
  await runProgress();
  const firstMail = progressOf(studentMail);
  assert.ok(firstMail, 'student got news from the supervisor');
  assert.ok(progressOf('prof@example.org'), 'supervisor got news from the student');
  await expect(prof(`/cases/${caseId}/comments`, { body: { body: 'Kurze Zwischenfrage.', visible_to: ['*'] } }));
  await runProgress();
  assert.equal(progressOf(studentMail), firstMail, 'no second mail within 20 minutes');
  const backdate = () => sql(`UPDATE users SET progress_mail_at = '${new Date(Date.now() - 21 * 60e3).toISOString()}' WHERE email = '${studentMail}'`);
  const capMarker = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  sql(`INSERT INTO mail_log (bulk, sent_at) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 80) SELECT 1, '${capMarker}' FROM n`);
  backdate();
  const held = progressOf(studentMail);
  await runProgress();
  assert.equal(progressOf(studentMail), held, 'daily cap holds bulk mails back');
  sql(`DELETE FROM mail_log WHERE sent_at = '${capMarker}'`);
  await runProgress();
  assert.notEqual(progressOf(studentMail), held, 'held news go out once there is room');
  await expect(student('/me', { method: 'PATCH', body: { email_progress: false } }));
  assert.equal((await expect(student('/me'))).user.email_progress, false);

  await expect(student('/me', { method: 'PATCH', body: { email_reminders: false } }));
  assert.equal((await expect(student('/me'))).user.email_reminders, false);
}

// Praxisprojekt rule: uploading the approval informs the student automatically.
pc = await expect(prof(`/cases/${caseId}`));
await expect(prof(`/tasks/${pc.tasks.find(t => t.title === 'Antrag beim Prüfungsamt einreichen').id}/action`, { body: { action: 'complete' } }));
await expect(prof(`/cases/${caseId}/documents`, { form: file('Genehmigung.pdf', PDF, { task_id: pc.tasks.find(t => t.title === 'Genehmigung erhalten').id }) }));
sc = await expect(student(`/cases/${caseId}`));
const notice = sc.events.find(e => e.type === 'comment' && e.payload.rule === 'Studierende über die Genehmigung informieren');
assert.ok(notice && notice.actor_id === null && /genehmigt/.test(notice.payload.body), 'rule wrote to the student');

// Case → template: the structure goes over, requests, contents and people don't; deadlines become relative.
await expect(student(`/cases/${caseId}/template`, { body: { name: 'x' } }), 403);
const saved = await expect(prof(`/cases/${caseId}/template`, { body: { name: `Aus Vorgang ${run}` } }));
const fromCase = (await expect(prof('/templates'))).find(t => t.id === saved.template_id);
const steps = fromCase.definition.phases.flatMap(ph => ph.tasks);
assert.equal(fromCase.workspace_id, 'ws_hs');
assert.deepEqual(fromCase.definition.phases.map(ph => ph.title), pp.definition.phases.map(ph => ph.title));
assert.ok(!steps.some(t => t.title === 'Verlängerung um 4 Wochen'), 'guest requests stay in the case');
assert.equal(steps.find(t => t.title === 'Abschlussbericht abgeben').due_days, 84);
assert.deepEqual(steps.find(t => t.title === 'Antrag prüfen').after, [steps.find(t => t.title === 'Antrag hochladen').key]);
assert.ok(!JSON.stringify(fromCase.definition).includes('Max Müller'), 'no personal data');
const { id: reborn } = await expect(prof('/cases', { body: { template_id: saved.template_id, title: 'Neu aus Vorlage' } }));
assert.equal((await expect(prof(`/cases/${reborn}`))).tasks.length, steps.length);
const asVersion = await expect(prof(`/cases/${caseId}/template`, { body: { template_id: pp.id } }));
const reinvite = await expect(prof(`/cases/${reborn}/invitations`, { body: { email: `max.${run}@example.org`, role: 'student' } }));
const stranger = client();
assert.equal((await expect(stranger(`/invitations/${tokenOf(reinvite.link)}`))).needs_login, true, 'existing account without passkey');
await expect(stranger('/invitations/accept', { body: { token: tokenOf(reinvite.link), name: 'Mallory' } }), 401);
await expect(student('/invitations/accept', { body: { token: tokenOf(reinvite.link) } }));
assert.ok(asVersion.version > pp.version);

// Template versioning: a new version does not touch running cases.
await expect(prof(`/templates/${pp.id}/versions`, { body: { definition: { roles: [], phases: [] } } }), 400);
const def = structuredClone(pp.definition);
def.fields.push({ key: `company_${run}`, label: 'Unternehmen' });
const { version } = await expect(prof(`/templates/${pp.id}/versions`, { body: { definition: def } }));
assert.equal(version, asVersion.version + 1); // the case → template check above already added one
pc = await expect(prof(`/cases/${caseId}`));
assert.equal(pc.case.template_version, pp.version);
assert.ok(!pc.definition.fields.some(f => f.key === `company_${run}`));

console.log(`ok – smoke test passed (case ${caseId})`);
