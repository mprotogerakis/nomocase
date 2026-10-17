// UI walk-through in headless Chrome: every view renders, the main forms and buttons do what they say, and no script
// error or error popup appears. The API tests never load app.js; this one does. Needs a local `npm run dev` (dev login).
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE, fetchOnce, run, PDF, freshMailQuota } from './lib.mjs';
import { openBrowser, sleep } from './browser.mjs';

freshMailQuota();
const J = JSON.stringify;
const pdf = join(mkdtempSync(join(tmpdir(), 'nomocase-ui-')), 'UI-Test.pdf');
writeFileSync(pdf, `${PDF}% UI ${run}\n`);

const b = await openBrowser();
const { evaluate, waitFor, dialogs, errors } = b;
// A fresh load each time (unique query): navigating to the same hash would not re-render.
const go = async (hash, ready) => { await b.navigate(`${BASE}/?${Date.now()}${hash}`); await waitFor(ready, `Ansicht ${hash}`); };
const login = email => evaluate(`fetch('/api/dev-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${J(J({ email }))} }).then(r => r.status)`);
const api = path => evaluate(`fetch('/api${path}').then(r => r.json())`);
const has = text => `document.body.textContent.includes(${J(text)})`;
const until = async (check, what) => {
  for (let i = 0; i < 150 && !check(); i++) await sleep(100);
  assert.ok(check(), `Timeout: ${what}`);
};
// Fill a form (found by its data-submit name and optional data-id) and submit it like a user would.
const submit = (name, values = {}, id) => evaluate(`(() => {
  const f = document.querySelector('form[data-submit="${name}"]${id ? `[data-id="${id}"]` : ''}');
  for (const [k, v] of Object.entries(${J(values)})) {
    const el = f.elements[k];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  f.requestSubmit();
  return true;
})()`);
const change = (selector, value) => evaluate(`(() => {
  const el = document.querySelector(${J(selector)});
  ${value === undefined ? '' : `el.value = ${J(value)};`}
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
const upload = async (form, file) => {
  await b.setFile(`${form} input[type=file]`, file);
  await evaluate(`document.querySelector(${J(form)}).requestSubmit() ?? true`);
};

let caseId;
try {
  await b.cdp('Network.enable');

  // --- Team: new case from the dashboard
  await go('#/', `document.readyState === 'complete'`);
  assert.equal(await login('prof@example.org'), 200);
  await go('#/', `!!document.querySelector('form[data-submit="newCase"]')`);
  const tpls = await api('/templates');
  await change('select[name="template_id"]', tpls.find(t => t.name === 'Praxisprojekt (B.Eng.)').id);
  await waitFor(`!!document.querySelector('input[name="f_matrikel"]')`, 'Felder der Vorlage');
  await submit('newCase', { title: `UI-Test ${run}`, f_student: 'Ulla Test', f_end: '2027-07-01' });
  await waitFor(`location.hash.startsWith('#/case/') && ${has(`UI-Test ${run}`)}`, 'neuer Vorgang');
  caseId = await evaluate(`location.hash.split('/')[2]`);
  const current = () => api(`/cases/${caseId}`);
  const taskId = async title => (await current()).tasks.find(t => t.title === title).id;
  const taskIs = (id, check) => `fetch('/api/cases/${caseId}').then(r => r.json()).then(d => { const t = d.tasks.find(t => t.id === '${id}'); return ${check}; })`;

  // Angaben, message
  await b.click('[data-on="editFields"]');
  await waitFor(`!!document.querySelector('form[data-submit="saveFields"]')`, 'Angaben-Formular');
  await submit('saveFields', { matrikel: '4711' });
  await waitFor(`[...document.querySelectorAll('dd')].some(d => d.textContent === '4711')`, 'geänderte Angabe');
  await submit('comment', { body: 'Hallo aus dem UI-Test' });
  await waitFor(has('Hallo aus dem UI-Test'), 'Nachricht im Verlauf');

  // A task: add, rename, deadline, complete
  await submit('addTask', { title: 'UI-Aufgabe', type: 'task', role: 'supervisor' });
  await waitFor(has('UI-Aufgabe'), 'neue Aufgabe');
  const t1 = await taskId('UI-Aufgabe');
  await submit('editTask', { title: 'UI-Aufgabe umbenannt' }, t1);
  await waitFor(has('UI-Aufgabe umbenannt'), 'umbenannte Aufgabe');
  await change(`[data-change="due"][data-id="${t1}"]`, '2027-01-15');
  await waitFor(taskIs(t1, `t.due_date === '2027-01-15'`), 'Frist gesetzt');
  await submit('complete', {}, t1);
  await waitFor(taskIs(t1, `t.status === 'done'`), 'Aufgabe erledigt');

  // Upload with SHA-256, upload link for externals
  await submit('addTask', { title: 'UI-Upload', type: 'upload', role: 'supervisor' });
  await waitFor(has('UI-Upload'), 'Upload-Aufgabe');
  const t2 = await taskId('UI-Upload');
  await upload(`form[data-submit="upload"]:has(input[name="task_id"][value="${t2}"])`, pdf);
  await waitFor(`!!document.querySelector('button.hash')`, 'Fassung mit SHA-256');
  // a digitally signed PDF shows its signatures at the version
  await submit('addTask', { title: 'UI-Signiert', type: 'upload', role: 'supervisor' });
  await waitFor(has('UI-Signiert'), 'Aufgabe für signierte PDF');
  const signedTask = await taskId('UI-Signiert');
  await upload(`form[data-submit="upload"]:has(input[name="task_id"][value="${signedTask}"])`, new URL('./fixtures/signed/two.pdf', import.meta.url).pathname);
  await waitFor(`document.querySelectorAll('.sigs .sig').length === 2`, 'zwei Signaturzeilen');
  await submit('addTask', { title: 'UI-Extern', type: 'upload', role: 'supervisor' });
  await waitFor(has('UI-Extern'), 'zweite Upload-Aufgabe');
  await submit('uploadLink', { label: 'Externe Stelle', days: '7' }, await taskId('UI-Extern'));
  await until(() => dialogs.some(d => d.includes('/#/upload/')), 'Upload-Link');
  const uploadLink = dialogs.find(d => d.includes('/#/upload/')).match(/\S+\/#\/upload\/\S+/)[0];

  // Subcase, rule switch, invitation
  await submit('addSubcase', { template_id: tpls.find(t => t.name === 'Freier Vorgang' && t.workspace === 'Hochschule').id, title: 'UI-Teilvorgang' });
  await waitFor(`location.hash !== '#/case/${caseId}' && ${has('UI-Teilvorgang')}`, 'Teilvorgang geöffnet');
  await go(`#/case/${caseId}`, has('UI-Teilvorgang'));
  const rule = (await current()).definition.rules[0];
  await b.click(`[data-change="rule"][data-id="${rule.id}"]`);
  await waitFor(`fetch('/api/cases/${caseId}').then(r => r.json()).then(d => d.events.some(e => e.type === 'rule.toggled'))`, 'Regel geschaltet');
  const guestEmail = `ui.${run}@example.org`;
  await submit('invite', { email: guestEmail, role: 'student' });
  await until(() => dialogs.some(d => d.includes('/#/invite/')), 'Einladungslink');
  const inviteLink = dialogs.find(d => d.includes('/#/invite/')).match(/\S+\/#\/invite\/\S+/)[0];

  // Case → template, then edit that template on the templates page
  await submit('saveCaseTemplate', { target: 'new', name: `UI-Vorlage ${run}` });
  await until(() => dialogs.some(d => d.startsWith(`Gespeichert: „UI-Vorlage ${run}“`)), 'als Vorlage gespeichert');
  const uiTpl = (await api('/templates')).find(t => t.name === `UI-Vorlage ${run}`);
  await go('#/templates', `!!document.querySelector('form[data-submit="saveTemplate"][data-id="${uiTpl.id}"]')`);
  await submit('saveTemplate', {}, uiTpl.id);
  await waitFor(`fetch('/api/templates').then(r => r.json()).then(ts => ts.find(t => t.id === '${uiTpl.id}').version === 2)`, 'Vorlage als Version 2 gespeichert');
  await until(() => dialogs.some(d => d.startsWith('Gespeichert als Version 2')), 'Bestätigung Version 2');
  await waitFor(`!!document.querySelector('[data-on="deleteTemplate"][data-id="${uiTpl.id}"]')`, 'Löschen-Knopf');
  await b.click(`[data-on="deleteTemplate"][data-id="${uiTpl.id}"]`);
  await waitFor(`fetch('/api/templates').then(r => r.json()).then(ts => !ts.some(t => t.id === '${uiTpl.id}'))`, 'Vorlage gelöscht');

  // Copy a template into another workspace: a template of its own there; a taken name gets "(Kopie)"; templates that
  // its rules start sub-cases from are pointed out
  const before = await api('/templates');
  const copyTo = async (name, from) => {
    const t = before.find(x => x.name === name && x.workspace_id === from);
    await waitFor(`!!document.querySelector('form[data-submit="copyTemplate"][data-id="${t.id}"]')`, `Kopieren: ${name}`);
    await submit('copyTemplate', { workspace_id: 'ws_hs' }, t.id);
    return t;
  };
  const arzt = await copyTo('Arztrechnung', 'ws_priv');
  await until(() => dialogs.some(d => d.includes('„Arztrechnung“ ist jetzt auch in') && d.includes('„Widerspruch“')), 'Kopie mit Hinweis auf Teilvorgänge');
  await waitFor(`fetch('/api/templates').then(r => r.json()).then(ts => ts.some(t => t.workspace_id === 'ws_hs' && t.name === 'Arztrechnung'))`, 'Kopie angelegt');
  await copyTo('Freier Vorgang', 'ws_priv');
  await until(() => dialogs.some(d => d.includes('„Freier Vorgang (Kopie)“ ist jetzt auch in')), 'Kopie unter anderem Namen');
  const copies = (await api('/templates')).filter(t => t.workspace_id === 'ws_hs' && ['Arztrechnung', 'Freier Vorgang (Kopie)'].includes(t.name));
  assert.equal(copies.length, 2);
  assert.deepEqual(copies.find(t => t.name === 'Arztrechnung').definition.phases, arzt.definition.phases, 'same definition');
  assert.ok((await api('/templates')).some(t => t.id === arzt.id && t.workspace_id === 'ws_priv'), 'the original stays where it was');
  assert.ok(await evaluate(`[...document.querySelectorAll('h2.ws-heading')].some(h => h.textContent.startsWith('Privat'))`), 'templates grouped by workspace');
  for (const c of copies) await evaluate(`fetch('/api/templates/${c.id}', { method: 'DELETE' }).then(r => r.status)`);

  // Template editor: rename a step as you type, add one that takes several PDFs, save as the next version
  const post = (path, body) => evaluate(`fetch('/api${path}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${J(J(body))} }).then(r => r.json())`);
  const { id: edId } = await post('/templates', { workspace_id: 'ws_hs', name: `UI-Editor ${run}`, definition: {
    roles: [{ key: 'owner', label: 'Team', access: 'case_owner' }, { key: 'student', label: 'Studierende:r', access: 'guest_contributor' }],
    fields: [{ key: 'grade', label: 'Note' }], document_types: [{ key: 'att', label: 'Anlagen', visible_to: [] }],
    scales: { note: { label: 'Note', range: [1, 4], step: 0.1, extra: [5], pass: { max: 4 } } },
    phases: [{ title: 'Ablauf', tasks: [{ key: 'start', title: 'Start', type: 'task' }] }, { title: 'Bewertung', tasks: [
      { key: 'g1', title: 'Gutachten 1', type: 'review', assess: 'note' }, { key: 'g2', title: 'Gutachten 2', type: 'review' },
      { key: 'g3', title: 'Freigabe', type: 'approval' }] }] } });
  await go(`#/templates/${edId}`, `!!document.querySelector('.template-editor .step')`);
  const typeInto = (path, value) => evaluate(`(() => { const i = document.querySelector('[data-path="${path}"]'); i.value = ${J(value)};
    i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`); // typed, then left
  await typeInto('phases.0.tasks.0.title', 'Beginn');
  await b.click('[data-on="tplAdd"][data-path="phases.0.tasks"]');
  await waitFor(`!!document.querySelector('[data-path="phases.0.tasks.1.title"]')`, 'neuer Schritt');
  await typeInto('phases.0.tasks.1.title', 'Anlagen hochladen');
  await change('[data-path="phases.0.tasks.1.type"]', 'upload');
  await waitFor(`!!document.querySelector('[data-change="tplMultiple"][data-path="phases.0.tasks.1"]')`, 'Datei-Einstellungen');
  await change('[data-change="tplMultiple"][data-path="phases.0.tasks.1"]', 'many');
  await evaluate(`(() => { const c = document.querySelector('[data-change="tplAccept"][data-path="phases.0.tasks.1"][value="pdf"]');
    c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await change('[data-path="phases.0.tasks.1.doc_type"]', 'att');
  const check = (sel, on = true) => evaluate(`(() => { const c = document.querySelector('${sel}'); c.checked = ${on}; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await check('[data-change="tplShare"][data-path="phases.0.tasks.1"][value="student"]');
  // assessments: a second graded step, own button words for an approval, an aggregate of both grades; then one grader goes
  await change('[data-change="tplAssess"][data-path="phases.1.tasks.1"]', 'note');
  await typeInto('phases.1.tasks.2"][data-i="0', 'Passt');
  await b.click('[data-on="tplAdd"][data-path="aggregates"]');
  await waitFor(`!!document.querySelector('[data-path="aggregates.0.label"]')`, 'neue Verrechnung');
  assert.equal(await evaluate(`document.querySelectorAll('[data-prop="from"][data-path="aggregates.0"]:checked').length`), 2, 'both graded steps preselected');
  await typeInto('aggregates.0.label', 'Gesamtnote');
  await change('[data-path="aggregates.0.round"]', 'truncate');
  await change('[data-path="aggregates.0.field"]', 'grade');
  await typeInto('aggregates.0"][data-input="tplFailValue', '5,0');
  await b.click('[data-on="tplRemove"][data-path="phases.1.tasks"][data-i="0"]');
  await waitFor(`!document.querySelector('[data-prop="from"][value="g1"]')`, 'Gutachten 1 entfernt');
  // scales as a form: points (a range, German decimals, own verdict) and a list of named values
  await b.click('[data-on="tplAddScale"]');
  await waitFor(`!!document.querySelector('[data-path="scales.skala.label"]')`, 'neue Skala');
  await typeInto('scales.skala.label', 'Punkte');
  await typeInto('scales.skala.range.1', '60,5');
  await typeInto('scales.skala.step', '0,5');
  await typeInto('scales.skala"][data-i="0', 'erfüllt');
  await b.click('[data-on="tplAddScale"]');
  await waitFor(`!!document.querySelector('[data-path="scales.skala-2.label"]')`, 'zweite Skala');
  await typeInto('scales.skala-2.label', 'Stufe');
  await change('[data-change="tplScaleKind"][data-path="scales.skala-2"]', 'options');
  await b.click('[data-on="tplAdd"][data-path="scales.skala-2.options"]');
  await waitFor(`!!document.querySelector('[data-path="scales.skala-2.options.2.label"]')`, 'dritter Wert');
  await typeInto('scales.skala-2.options.2.label', 'sehr gut');
  // a PDF form, built from lists, offered at "Beginn"; its preview is a real PDF with the placeholder's name in the field
  await b.click('[data-on="tplAdd"][data-path="forms"]');
  await waitFor(`!!document.querySelector('[data-path="forms.0.title"]')`, 'neues Formular');
  await typeInto('forms.0.title', 'Bestätigung');
  await b.click('[data-on="tplAdd"][data-path="forms.0.items"]');
  await waitFor(`!!document.querySelector('[data-path="forms.0.items.1.label"]')`, 'neuer Eintrag');
  await typeInto('forms.0.items.1.label', 'Vorgang');
  await change('[data-change="tplFormValue"][data-path="forms.0.items.1"]', '{case.title}');
  await b.click('[data-on="tplAdd"][data-path="forms.0.items"]');
  await waitFor(`!!document.querySelector('[data-change="tplItemKind"][data-path="forms.0.items.2"]')`, 'dritter Eintrag');
  await change('[data-change="tplItemKind"][data-path="forms.0.items.2"]', 'sign');
  await waitFor(`!!document.querySelector('[data-path="forms.0.items.2.sign"]')`, 'Unterschrift');
  await typeInto('forms.0.items.2.sign', 'Unterschrift Team');
  await change('[data-path="phases.0.tasks.0.form"]', 'bestatigung');
  await evaluate(`(() => { window.pdfs = []; const make = URL.createObjectURL; URL.createObjectURL = blob => { pdfs.push(blob); return make(blob); }; return true; })()`);
  await b.click('[data-on="tplPreview"][data-i="0"]');
  await waitFor('pdfs.length === 1', 'Vorschau aus dem Editor');
  assert.equal(await evaluate(`import('/vendor/pdf-lib.esm.min.js').then(async ({ PDFDocument }) =>
    (await PDFDocument.load(await pdfs[0].arrayBuffer())).getForm().getTextField('Vorgang').getText())`), '‹Titel des Vorgangs›');
  // a rule, built from lists: when "Beginn" is done, a message to everyone
  await b.click('[data-on="tplAdd"][data-path="rules"]');
  await waitFor(`!!document.querySelector('[data-path="rules.0.name"]')`, 'neue Regel');
  await typeInto('rules.0.name', 'Start melden');
  await b.click('[data-on="tplAdd"][data-path="rules.0.conditions"]');
  await waitFor(`!!document.querySelector('[data-change="tplCondValue"][data-path="rules.0.conditions.0"]')`, 'Bedingung');
  await change('[data-change="tplCondValue"][data-path="rules.0.conditions.0"]', 'start');
  await typeInto('rules.0.actions.0.text', 'Gestartet: {task.title}');
  await change('[data-change="tplAudience"][data-path="rules.0.actions.0"]', '*');
  // a new step's key follows its title until a rule refers to it; renamed afterwards, it keeps the key (no broken rule)
  await typeInto('phases.0.tasks.1.title', 'Anlagen später');
  await b.click('[data-on="tplAdd"][data-path="rules"]');
  await waitFor(`!!document.querySelector('[data-path="rules.1.name"]')`, 'zweite Regel');
  await typeInto('rules.1.name', 'Anlagen da');
  await b.click('[data-on="tplAdd"][data-path="rules.1.conditions"]');
  await waitFor(`!!document.querySelector('[data-change="tplCondValue"][data-path="rules.1.conditions.0"]')`, 'Bedingung 2');
  await change('[data-change="tplCondValue"][data-path="rules.1.conditions.0"]', 'anlagen-spater');
  await typeInto('rules.1.actions.0.text', 'Anlagen sind da.');
  await typeInto('phases.0.tasks.1.title', 'Anlagen hochladen');
  // the same for a new role: given to a step, then its name corrected
  await b.click('[data-on="tplAdd"][data-path="roles"]');
  await waitFor(`!!document.querySelector('[data-path="roles.2.label"]')`, 'neue Rolle');
  await typeInto('roles.2.label', 'Gutachter');
  await change('[data-path="phases.0.tasks.0.role"]', 'gutachter');
  await typeInto('roles.2.label', 'Gutachter:in');
  const shown = dialogs.length;
  await b.click('[data-on="tplSave"]');
  await until(() => dialogs.length > shown && dialogs.at(-1).startsWith('Gespeichert als Version 2'), 'im Editor gespeichert');
  const saved = (await api('/templates')).find(t => t.id === edId);
  assert.deepEqual(saved.definition.phases[0].tasks.map(t => [t.key, t.title, t.type, t.files ?? null, t.doc_type ?? null]),
    [['start', 'Beginn', 'task', null, null], ['anlagen-spater', 'Anlagen hochladen', 'upload', { multiple: true, accept: ['pdf'] }, 'att']]);
  assert.deepEqual([saved.definition.roles[2], saved.definition.phases[0].tasks[0].role], [{ key: 'gutachter', label: 'Gutachter:in', access: 'guest_contributor' }, 'gutachter']);
  assert.deepEqual(saved.definition.forms, [{ key: 'bestatigung', title: 'Bestätigung',
    items: [{ heading: 'Angaben' }, { label: 'Vorgang', value: '{case.title}' }, { sign: 'Unterschrift Team', place: 'Düsseldorf' }] }]);
  assert.equal(saved.definition.phases[0].tasks[0].form, 'bestatigung');
  assert.deepEqual(saved.definition.phases[0].tasks[1].visible_to, ['student']);
  assert.deepEqual(saved.definition.phases[1].tasks, [{ key: 'g2', title: 'Gutachten 2', type: 'review', assess: 'note' },
    { key: 'g3', title: 'Freigabe', type: 'approval', labels: ['Passt', 'Ablehnen'] }]);
  assert.deepEqual([saved.definition.scales.skala, saved.definition.scales['skala-2']], [
    { label: 'Punkte', range: [0, 60.5], step: 0.5, pass: { min: 50 }, verdicts: ['erfüllt', 'Nicht bestanden'] },
    { label: 'Stufe', options: [{ value: 1, label: 'bestanden' }, { value: 0, label: 'nicht bestanden' }, { value: 2, label: 'sehr gut' }], pass: { min: 1 } }]);
  assert.deepEqual(saved.definition.aggregates, [{ key: 'gesamtnote', label: 'Gesamtnote', scale: 'note', from: ['g2'], method: 'mean', round: 'truncate', field: 'grade', fail_value: 5 }]);
  assert.deepEqual(saved.definition.rules, [{ id: 'start-melden', name: 'Start melden', trigger: 'task.complete',
    conditions: [{ field: 'task.key', operator: 'equals', value: 'start' }], actions: [{ type: 'add_comment', text: 'Gestartet: {task.title}', visible_to: ['*'] }] },
  { id: 'anlagen-da', name: 'Anlagen da', trigger: 'task.complete', conditions: [{ field: 'task.key', operator: 'equals', value: 'anlagen-spater' }],
    actions: [{ type: 'add_comment', text: 'Anlagen sind da.', visible_to: [] }] }]);
  // … and in a case from it: the step takes several PDFs at once, each one a document, the step done after the last
  const { id: edCase } = await post('/cases', { template_id: edId, title: `UI-Anlagen ${run}` });
  const begin = (await api(`/cases/${edCase}`)).tasks.find(t => t.key === 'start').id;
  await evaluate(`fetch('/api/tasks/${begin}/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"complete"}' }).then(r => r.status)`);
  assert.ok((await api(`/cases/${edCase}`)).events.some(e => e.type === 'comment' && e.payload.rule === 'Start melden' && e.payload.body === 'Gestartet: Beginn'), 'the rule fired');
  await go(`#/case/${edCase}`, `!!document.querySelector('form[data-submit="upload"] input[multiple]')`);
  assert.equal(await evaluate(`document.querySelector('form[data-submit="upload"] input[type=file]').accept`), '.pdf');
  const second = pdf.replace('UI-Test.pdf', 'Zweite.pdf');
  writeFileSync(second, `${PDF}% zwei ${run}\n`);
  await b.setFile('form[data-submit="upload"] input[type=file]', [pdf, second]);
  await evaluate(`document.querySelector('form[data-submit="upload"]').requestSubmit() ?? true`);
  await waitFor(`fetch('/api/cases/${edCase}').then(r => r.json()).then(c => c.documents.length === 2 && c.tasks.find(t => t.title === 'Anlagen hochladen').status === 'done')`, 'zwei Dateien hochgeladen');
  await evaluate(`fetch('/api/cases/${edCase}', { method: 'DELETE' }).then(r => r.status)`);
  await evaluate(`fetch('/api/templates/${edId}', { method: 'DELETE' }).then(r => r.status)`);

  // Assessment: two examiners give grades on the template's scale, the combined value can be taken over into a field
  const mtpl = tpls.find(t => t.name === 'Masterprojekt (M.Sc.)');
  const master = await evaluate(`fetch('/api/cases', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: ${J(J({ template_id: mtpl.id, title: `UI-Master ${run}` }))} }).then(r => r.json()).then(r => r.id)`);
  const mcase = await api(`/cases/${master}`);
  for (const t of mcase.tasks.filter(t => !t.assess && !mcase.aggregates?.length && mcase.phases.findIndex(p => p.id === t.phase_id) < 4)) {
    await evaluate(`fetch('/api/tasks/${t.id}/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"action":"skip"}' }).then(r => r.status)`);
  }
  await go(`#/case/${master}`, `!!document.querySelector('form[data-submit="taskScore"]')`);
  const [g2, g1] = mcase.tasks.filter(t => t.assess).map(t => t.id);
  await submit('taskScore', { score: '4,5' }, g2);
  await until(() => dialogs.some(d => d.startsWith('Note:')), 'Hinweis bei ungültiger Note');
  dialogs.splice(dialogs.findIndex(d => d.startsWith('Note:')), 1);
  await submit('taskScore', { score: '1,7' }, g2);
  await waitFor(`!document.querySelector('form[data-submit="taskScore"][data-id="${g2}"]')`, 'erste Note');
  await submit('taskScore', { score: '2,3' }, g1);
  await waitFor(has('Modulnote rechnerisch: 2,0'), 'Modulnote');
  await b.click('[data-on="takeAggregate"]');
  await waitFor(has('steht in den Angaben'), 'Modulnote übernommen');
  await evaluate(`fetch('/api/cases/${master}', { method: 'DELETE' }).then(r => r.status)`);

  // Forms: a step's form is generated in the browser (pdf-lib loaded on demand), prefilled from the case, with the
  // workspace's logo (a one-pixel test image here)
  const btpl = tpls.find(t => t.name === 'Bachelor-Thesis (B.Eng.)');
  const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
  const setLogo = logo => evaluate(`fetch('/api/workspaces/${btpl.workspace_id}/branding', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: ${J(J({ logo }))} }).then(r => r.status)`);
  assert.equal(await setLogo(PIXEL), 200);
  const thesis = await evaluate(`fetch('/api/cases', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: ${J(J({ template_id: btpl.id, title: `UI-BA ${run}`, fields: { student: 'Ulla Test', matrikel: '4242' } }))} }).then(r => r.json()).then(r => r.id)`);
  await go(`#/case/${thesis}`, `!!document.querySelector('[data-on="taskForm"]')`);
  await evaluate(`(() => { window.pdfs = []; const make = URL.createObjectURL; URL.createObjectURL = blob => { pdfs.push(blob); return make(blob); }; return true; })()`);
  await b.click('[data-on="taskForm"]');
  await waitFor('pdfs.length === 1', 'Formular erzeugt');
  assert.deepEqual(await evaluate(`import('/vendor/pdf-lib.esm.min.js').then(async ({ PDFDocument, PDFName }) => {
    const doc = await PDFDocument.load(await pdfs[0].arrayBuffer());
    const xo = doc.getPage(0).node.Resources().lookup(PDFName.of('XObject'));
    const image = xo.entries().some(([, ref]) => doc.context.lookup(ref).dict?.get(PDFName.of('Subtype')) === PDFName.of('Image')); // the logo
    return [doc.getTitle(), doc.getForm().getTextField('Matrikelnummer').getText(), pdfs[0].type, image];
  })`), ['Antrag auf Zulassung zur Bachelor-Thesis', '4242', 'application/pdf', true], 'prefilled PDF with the logo');
  // Uploaded again with another matrikel: the team sees the difference on the case and can take the form's value
  const sent = await evaluate(`import('/vendor/pdf-lib.esm.min.js').then(async ({ PDFDocument }) => {
    const doc = await PDFDocument.load(await pdfs[0].arrayBuffer());
    doc.getForm().getTextField('Matrikelnummer').setText('4243');
    const fd = new FormData();
    fd.append('file', new File([await doc.save()], 'Antrag.pdf', { type: 'application/pdf' }));
    fd.append('doc_type', 'application');
    return fetch('/api/cases/${thesis}/documents', { method: 'POST', body: fd }).then(r => r.json());
  })`);
  assert.deepEqual(sent.form?.differs, ['Matrikelnummer']);
  await go(`#/case/${thesis}`, `!!document.querySelector('[data-on="takeFormValue"][data-key="matrikel"]')`);
  assert.ok(await evaluate(has('weicht ab – im Formular „4243“, in den Angaben „4242“')), 'difference shown with both values');
  await b.click('[data-on="takeFormValue"][data-key="matrikel"]');
  await waitFor(`fetch('/api/cases/${thesis}').then(r => r.json()).then(c => c.case.fields.matrikel === '4243')`, 'Formularwert übernommen');
  await waitFor(has('passt zu den Angaben'), 'Formular passt danach');
  // Long entries in the log: three lines with "…", opened on request
  await evaluate(`fetch('/api/cases/${thesis}/comments', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: ${J(J({ body: `${'Eine lange Rückmeldung. '.repeat(40)}\nEnde` }))} }).then(r => r.status)`);
  await go(`#/case/${thesis}`, `!!document.querySelector('.ev p.clamp')`);
  assert.ok(await evaluate(`(() => { const p = document.querySelector('.ev p.clamp'); return p.scrollHeight > p.clientHeight + 4 && p.clientHeight < 80; })()`), 'clamped to three lines');
  await b.click('[data-on="toggleEvent"]');
  assert.ok(await evaluate(`(() => { const p = document.querySelector('.ev p.clamp'); return p.classList.contains('open') && p.scrollHeight <= p.clientHeight + 1; })()`), 'opened in full');
  // Move to another workspace (owners of both)
  await submit('moveCase', { workspace_id: 'ws_priv' });
  await until(() => dialogs.some(d => d.startsWith('Verschoben nach')), 'verschoben');
  assert.equal((await api(`/cases/${thesis}`)).case.workspace_id, 'ws_priv');
  await evaluate(`fetch('/api/cases/${thesis}', { method: 'DELETE' }).then(r => r.status)`);
  // … and previewed on the templates page, with the placeholders' names
  await go('#/templates', `!!document.querySelector('[data-on="previewForm"][data-key="ergebnis"]')`);
  await evaluate(`(() => { window.pdfs = []; const make = URL.createObjectURL; URL.createObjectURL = blob => { pdfs.push(blob); return make(blob); }; return true; })()`);
  await b.click(`[data-on="previewForm"][data-id="${btpl.id}"][data-key="ergebnis"]`);
  await waitFor('pdfs.length === 1', 'Formular-Vorschau');
  assert.equal(await evaluate(`import('/vendor/pdf-lib.esm.min.js').then(async ({ PDFDocument }) =>
    (await PDFDocument.load(await pdfs[0].arrayBuffer())).getForm().getTextField('Matrikelnummer').getText())`), '‹Matrikelnummer›');
  assert.equal(await setLogo(null), 200);

  // A mail with attachments, CC'd to the case: its attachments become documents with all upload checks, once
  const inbox = (await current()).case.inbox;
  const b64 = s => Buffer.from(s).toString('base64');
  assert.equal((await fetchOnce(`${BASE}/cdn-cgi/handler/email?from=extern@example.org&to=${inbox}`, { method: 'POST', body: [
    'From: Extern <extern@example.org>', `Cc: ${inbox}`, `Subject: Anlagen ${run}`, `Message-ID: <anlagen-${run}@example.org>`, 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"', '', '--b', 'Content-Type: text/plain', '', 'Anbei.',
    '--b', 'Content-Type: application/pdf; name="Anlage.pdf"', 'Content-Transfer-Encoding: base64', '', b64(`${PDF}% Anlage ${run}\n`),
    '--b', 'Content-Type: application/zip; name="archiv.zip"', 'Content-Transfer-Encoding: base64', '', b64('PK\u0003\u0004'), '--b--', ''].join('\r\n') })).status, 200);
  await go(`#/case/${caseId}`, `!!document.querySelector('[data-on="mailAttachments"]')`);
  const mailVersion = (await current()).documents.find(d => d.title === `E-Mail: Anlagen ${run}`).versions[0].id;
  await b.click(`[data-on="mailAttachments"][data-id="${mailVersion}"]`);
  await until(() => dialogs.some(d => d.startsWith('Anhänge der E-Mail') && d.includes('Anlage.pdf: übernommen') && d.includes('archiv.zip: nicht übernommen')), 'Anhänge übernommen');
  assert.ok((await current()).documents.some(d => d.title === 'Anlage.pdf' && d.visible_to.length === 0), 'a team-only document of its own');
  await waitFor(`!!document.querySelector('[data-on="mailAttachments"][data-id="${mailVersion}"]')`, 'neu gezeichnet');
  await b.click(`[data-on="mailAttachments"][data-id="${mailVersion}"]`);
  await until(() => dialogs.some(d => d.includes('Anlage.pdf: schon im Vorgang')), 'kein zweites Mal');

  // How a step takes files, changed in a running case (⋯ menu): several at once, and back
  const exposeStep = (await current()).tasks.find(t => t.title === 'Exposé hochladen');
  await go(`#/case/${caseId}`, `!!document.querySelector('[data-change="taskFiles"][data-id="${exposeStep.id}"][data-kind="multiple"]')`);
  const tick = on => evaluate(`(() => { const c = document.querySelector('[data-change="taskFiles"][data-id="${exposeStep.id}"][data-kind="multiple"]');
    c.checked = ${on}; c.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await tick(true);
  await waitFor(`fetch('/api/cases/${caseId}').then(r => r.json()).then(c => c.tasks.find(t => t.id === '${exposeStep.id}').files?.multiple === true)`, 'mehrere Dateien eingeschaltet');
  await waitFor(`!!document.querySelector('[data-change="taskFiles"][data-id="${exposeStep.id}"][data-kind="multiple"]:checked')`, 'neu gezeichnet');
  await tick(false);
  await waitFor(`fetch('/api/cases/${caseId}').then(r => r.json()).then(c => c.tasks.find(t => t.id === '${exposeStep.id}').files === null)`, 'wieder eine Datei');

  // Many cases from a pasted table: the preview marks problems, then cases are created with invitations, listed per line
  const bt = tpls.find(t => t.name === 'Bachelor-Thesis (B.Eng.)');
  await go('#/', `!!document.querySelector('form[data-submit="bulkCreate"]')`);
  await change('#bulk [name=template_id]', bt.id);
  await waitFor(`!!document.querySelector('#bulk [name=role]')`, 'Rolle für Einladungen');
  const table = rows => ['Name der/des Studierenden\tE-Mail\tMatrikelnummer\tAusgabe des Themas', ...rows].join('\n');
  const pasteTable = text => evaluate(`(() => { const t = document.querySelector('#bulk [name=table]'); t.value = ${J(text)};
    t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await pasteTable(table([`Eins ${run}\tbulk1.${run}@example.org\t111\t01.03.2027`, `Zwei ${run}\tkaputt\t222\t`]));
  await waitFor(has('Bitte erst die markierte Zeile korrigieren'), 'Vorschau mit Problem');
  await pasteTable(table([`Eins ${run}\tbulk1.${run}@example.org\t111\t01.03.2027`, `Zwei ${run}\tbulk2.${run}@example.org\t222\t`]));
  await waitFor(`!${has('korrigieren')} && ${has('2 Vorgänge, 2 mit E-Mail')}`, 'Vorschau ohne Problem');
  await submit('bulkCreate');
  await waitFor(has('2 von 2 Vorgängen angelegt'), 'Massenanlage');
  const made = (await api('/dashboard')).cases.filter(c => c.title.endsWith(run) && /– (Eins|Zwei) /.test(c.title));
  assert.equal(made.length, 2);
  const one = await api(`/cases/${made.find(c => c.title.includes('Eins')).id}`);
  assert.deepEqual([one.case.title, one.case.fields.matrikel, one.case.fields.issued], [`Bachelor-Thesis (B.Eng.) – Eins ${run}`, '111', '2027-03-01']);
  assert.ok(one.invitations.some(i => i.email === `bulk1.${run}@example.org` && i.role === 'student'), 'invited as student');
  for (const c of made) await evaluate(`fetch('/api/cases/${c.id}', { method: 'DELETE' }).then(r => r.status)`);
  await b.click('[data-on="bulkDismiss"]');

  // Dashboard as a worklist: search narrows the cards in place, filters and the template choice reload the list
  await go('#/', `!!document.querySelector('[data-input="caseSearch"]')`);
  await evaluate(`(() => { const s = document.querySelector('[data-input="caseSearch"]'); s.value = ${J(`ui-test ${run}`)}; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  assert.equal(await evaluate(`[...document.querySelectorAll('.cards li')].filter(li => !li.hidden).length`), 1, 'search finds exactly the new case');
  const onCard = `[...document.querySelectorAll('.cards li')].some(li => li.textContent.includes(${J(`UI-Test ${run}`)}))`;
  await b.click('[data-on="caseFilter"][data-id="closed"]');
  await waitFor(`!${onCard} && document.querySelector('[data-on="caseFilter"][data-id="closed"]').classList.contains('on')`, 'Filter abgeschlossen');
  await b.click('[data-on="caseFilter"][data-id="open"]');
  await waitFor(onCard, 'Filter offen');

  // People, account, phone layout
  await go('#/people', has(guestEmail));
  await evaluate(`(() => { const s = document.querySelector('[data-input="peopleSearch"]'); s.value = 'prof@example.org'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  assert.equal(await evaluate(`[...document.querySelectorAll('main .card[data-search]')].filter(c => !c.hidden).length`), 1, 'people search');
  await b.click('[data-on="peopleFilter"][data-id="nopasskey"]');
  await waitFor(`document.querySelector('.seg [data-on="peopleFilter"][data-id="nopasskey"]').classList.contains('on')`, 'Filter ohne Passkey');
  // Workspaces: create, invite a colleague, rename, delete again (empty)
  await go('#/workspaces', `!!document.querySelector('form[data-submit="wsCreate"]')`);
  await submit('wsCreate', { name: `UI-WS ${run}` });
  await waitFor(has(`UI-WS ${run}`), 'Workspace angelegt');
  const ws = (await api('/workspaces')).find(w => w.name === `UI-WS ${run}`);
  const invitesBefore = dialogs.filter(d => d.includes('/#/invite/')).length;
  await submit('wsInvite', { email: `kollege.${run}@example.org`, role: 'member' }, ws.id);
  await until(() => dialogs.filter(d => d.includes('/#/invite/')).length > invitesBefore, 'Workspace-Einladung');
  await waitFor(has(`kollege.${run}@example.org`), 'Einladung in der Liste');
  await submit('wsRename', { name: `UI-WS umbenannt ${run}` }, ws.id);
  await waitFor(has(`UI-WS umbenannt ${run}`), 'umbenannt');
  await b.click(`[data-on="wsLog"][data-id="${ws.id}"]`);
  await waitFor(`document.getElementById('wslog-${ws.id}')?.textContent.includes('umbenannt')`, 'Änderungsprotokoll');
  await b.click(`[data-on="wsDelete"][data-id="${ws.id}"]`);
  await waitFor(`!${has(`UI-WS umbenannt ${run}`)}`, 'Workspace gelöscht');

  await go('#/account', `document.querySelector('main h1')?.textContent === 'Konto'`);
  await b.click('[data-on="testMail"]');
  await waitFor(`document.getElementById('test-mail')?.textContent.includes('angenommen')`, 'Testmail angenommen');
  const reminders = (await api('/me')).user.email_reminders;
  await b.click('[data-change="mailSetting"][data-key="email_reminders"]');
  await waitFor(`fetch('/api/me').then(r => r.json()).then(m => m.user.email_reminders === ${!reminders})`, 'Mail-Einstellung');
  await b.click('[data-change="mailSetting"][data-key="email_reminders"]');
  await waitFor(`fetch('/api/me').then(r => r.json()).then(m => m.user.email_reminders === ${reminders})`, 'Mail-Einstellung zurück');
  await b.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await go(`#/case/${caseId}`, `!!document.querySelector('[data-on="caseTab"]')`);
  for (const tab of ['log', 'info', 'tasks']) {
    await b.click(`[data-on="caseTab"][data-tab="${tab}"]`);
    await waitFor(`document.querySelector('[data-on="caseTab"][data-tab="${tab}"]').classList.contains('on')`, `Reiter ${tab}`);
  }
  await b.cdp('Emulation.clearDeviceMetricsOverride');

  // --- Guest: accept the invitation, work on the own step, write
  await b.cdp('Network.clearBrowserCookies');
  await b.navigate(inviteLink);
  await waitFor(`!!document.querySelector('form[data-submit="accept"]')`, 'Einladungsseite');
  await submit('accept', { name: 'Ulla Test', consent: true });
  await waitFor(`location.hash.startsWith('#/welcome/')`, 'Willkommensseite');
  await go(`#/case/${caseId}`, has(`UI-Test ${run}`));
  assert.ok(!(await evaluate(has('4711'))), 'guests do not see the Angaben');
  const own = (await current()).tasks.find(t => t.title.startsWith('Thema'));
  await submit('complete', {}, own.id);
  await waitFor(taskIs(own.id, `t.status === 'done'`), 'Gast erledigt eigene Aufgabe');
  await submit('comment', { body: 'Frage vom Gast' });
  await waitFor(has('Frage vom Gast'), 'Nachricht vom Gast');

  // --- Without an account: upload link
  await b.cdp('Network.clearBrowserCookies');
  await b.navigate(uploadLink);
  await waitFor(`!!document.querySelector('form[data-submit="linkUpload"]')`, 'Upload-Link-Seite');
  await evaluate(`document.querySelector('form[data-submit="linkUpload"] [name=consent]').checked = true`);
  await upload('form[data-submit="linkUpload"]', pdf);
  await waitFor(`document.querySelector('code.hash')?.textContent.length === 64`, 'Quittung mit SHA-256');

  // On a phone (390 px wide) no page is wider than the screen (mobile browsers would shrink the whole page)
  await b.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await login('prof@example.org');
  for (const [hash, ready] of [['#/', `!!document.querySelector('.stats')`], ['#/templates', `!!document.querySelector('details.card')`],
    [`#/templates/${bt.id}`, `!!document.querySelector('.template-editor .step')`], [`#/case/${caseId}`, `!!document.querySelector('.task')`],
    ['#/workspaces', `!!document.querySelector('.card')`], ['#/people', `!!document.querySelector('.stats')`],
    ['#/account', `document.querySelector('main h1')?.textContent === 'Konto'`]]) {
    await go(hash, ready);
    await evaluate(`(() => { document.querySelectorAll('details').forEach(d => d.open = true); return true; })()`);
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1 && innerWidth <= 391`), `${hash} fits a phone`);
    // every control has a name a screen reader can announce (aria-label, a label around it, button text or title)
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('main input:not([type=hidden]), main select, main textarea, main button')].filter(el => {
      const labelText = l => { const c = l.cloneNode(true); c.querySelectorAll('input, select, textarea, button, option').forEach(x => x.remove()); return c.textContent.trim(); };
      return !(el.getAttribute('aria-label')?.trim() || [...(el.labels ?? [])].map(labelText).find(Boolean) || (el.tagName === 'BUTTON' && el.textContent.trim())
        || el.title?.trim() || el.placeholder?.trim());
    }).map(el => el.tagName + ' ' + (el.name || el.dataset.path || el.dataset.on || ''))`), [], `${hash}: every control has a name`);
    // everything clickable is reachable with the keyboard (no click handlers on plain boxes)
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-on]:not(button):not(a):not(summary):not(input):not(select):not(textarea)')].map(el => el.dataset.on)`),
      [], `${hash}: clickable only through keyboard-reachable elements`);
  }
  await b.cdp('Emulation.clearDeviceMetricsOverride');

  assert.deepEqual(errors, [], 'no script errors');
  assert.deepEqual(dialogs.filter(d => !/\/#\/(invite|upload)\/|^Gespeichert|ist jetzt auch in|verschieben\?$|^Verschoben nach|Vorgänge aus „.*“ anlegen|^Anhänge der E-Mail|^Workspace „UI-WS|^„UI-Vorlage .*löschen\?$/.test(d)), [], 'no error popups');
  console.log('ok – ui test passed');
} finally {
  if (caseId) {
    await login('prof@example.org').catch(() => {});
    await evaluate(`fetch('/api/cases/${caseId}', { method: 'DELETE' }).then(r => r.status)`).catch(() => {});
  }
  await b.close();
}
