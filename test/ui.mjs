// UI walk-through in headless Chrome: every view renders, the main forms and buttons do what they say, and no script
// error or error popup appears. The API tests never load app.js; this one does. Needs a local `npm run dev` (dev login).
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BASE, run, PDF } from './lib.mjs';
import { openBrowser, sleep } from './browser.mjs';

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
  for (const [k, v] of Object.entries(${J(values)})) f.elements[k].value = v;
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
  await go('#/account', `document.querySelector('main h1')?.textContent === 'Konto'`);
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
  await submit('accept', { name: 'Ulla Test' });
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
  await upload('form[data-submit="linkUpload"]', pdf);
  await waitFor(`document.querySelector('code.hash')?.textContent.length === 64`, 'Quittung mit SHA-256');

  assert.deepEqual(errors, [], 'no script errors');
  assert.deepEqual(dialogs.filter(d => !/\/#\/(invite|upload)\/|^Gespeichert:/.test(d)), [], 'no error popups');
  console.log('ok – ui test passed');
} finally {
  if (caseId) {
    await login('prof@example.org').catch(() => {});
    await evaluate(`fetch('/api/cases/${caseId}', { method: 'DELETE' }).then(r => r.status)`).catch(() => {});
  }
  await b.close();
}
