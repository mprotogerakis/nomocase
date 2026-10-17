// Tasks in a case: list items, actions, menu, money steps and assessments.
import { acceptAttr, DECISIONS, FILE_KIND_LABELS, filesHint, NEEDS_FILE } from '../shared/vocab.js';
import { change, on, submit } from '../state.js';
import { api, date, DECISION_LABELS, due, eur, html, linkify, OUTCOME, plainEur, reload, TYPES } from '../lib.js';
import { caseApi, guestRoles, holders, roleLabel } from './case.js';
import { fileLink, formCheck, uploadFiles } from './documents.js';
import { amountOf } from './finance.js';
import { aggregate, formatScore } from '../shared/assess.js';

export const canWork = (t, d) => t.status === 'open' && !t.blocked && (d.me.staff || (t.role === d.me.role && d.me.access !== 'guest_viewer'));

export const taskTitle = (id, d) => (id ? d.tasks.find(t => t.id === id)?.title : null);

// While an external has an open task for this document type, the task is the one way to hand in a new version.
export const openTaskFor = (doc, d) => !d.me.staff && d.tasks.some(t => t.doc_type && t.doc_type === doc.doc_type && canWork(t, d));

// Versions uploaded through a task (oldest first), each with its document.
export const resultsOf = (t, d) => d.documents.flatMap(doc => doc.versions.filter(v => v.task_id === t.id).map(v => ({ v, doc })))
  .sort((a, b) => a.v.created_at.localeCompare(b.v.created_at));

export const questionsTo = (t, d) => d.events.filter(e => e.type === 'task.question' && e.payload.reopened?.includes(t.id));

function assignee(t, d) {
  if (!t.role) return '';
  if (t.role === d.me.role) return html` · zuständig: <b>Sie</b>`;
  const names = holders(d, t.role);
  return html` · zuständig: ${roleLabel(t.role)} ${names.length
    ? `(${names.join(' oder ')}${names.length > 1 ? ' – eine:r genügt' : ''})`
    : html`<span class="warn">(noch niemand eingeladen)</span>`}`;
}

// What a task produced: the version uploaded through it, earlier rounds and the Rückfragen that caused them.
export function taskResult(t, d) {
  const results = resultsOf(t, d);
  if (!results.length) return reviewed(t, d);
  const asked = questionsTo(t, d);
  const { v, doc } = results.at(-1);
  const latest = doc.versions.at(-1);
  const label = t.status === 'open' ? 'Bisherige Fassung' : !d.me.staff && v.mine ? 'Ihre Abgabe' : 'Ergebnis';
  const earlier = [
    ...results.slice(0, -1).map(r => ({ at: r.v.created_at, item: html`${date(r.v.created_at)} · v${r.v.version} ${fileLink(r.v, r.v.filename)}` })),
    ...asked.map(e => ({ at: e.created_at, item: html`${date(e.created_at)} · Rückfrage von ${e.actor}: „${e.payload.note}“` })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const summary = [asked.length && `${asked.length} ${asked.length === 1 ? 'Rückfrage' : 'Rückfragen'}`, results.length > 1 && 'frühere Fassungen'].filter(Boolean).join(' · ');
  return html`<div class="result small">${label}: ${fileLink(v, `${doc.title} v${v.version} – ${v.filename}`)}
    ${latest.id === v.id && doc.final ? html` <span class="tag approved">Endfassung</span>` : ''}
    ${latest.id !== v.id ? html` <span class="muted">· inzwischen v${latest.version}</span>` : ''}
    ${earlier.length ? html`<details><summary class="muted">${summary}</summary><ul class="rounds">${earlier.map(e => html`<li>${e.item}</li>`)}</ul></details>` : ''}
    ${latest.id === v.id ? formCheck(v, d) : ''}
  </div>`;
}

// For a decided review: the version that was in front of the reviewer.
function reviewed(t, d) {
  if (!DECISIONS.includes(t.type) || t.status !== 'done') return '';
  const r = d.tasks.filter(x => t.depends_on.includes(x.id)).flatMap(x => resultsOf(x, d))
    .filter(x => x.v.created_at <= t.completed_at).sort((a, b) => a.v.created_at.localeCompare(b.v.created_at)).at(-1);
  return r ? html`<div class="result small">geprüft: ${fileLink(r.v, `${r.doc.title} v${r.v.version} – ${r.v.filename}`)}</div>` : '';
}

export function taskItem(t, d, withActions = true) {
  const icon = t.status === 'skipped' ? '–' : t.status === 'done' ? (t.outcome === 'rejected' ? '✗' : '✓') : t.blocked ? '○' : '→';
  const waitsFor = d.tasks.filter(x => t.depends_on.includes(x.id) && x.status === 'open').map(x => x.title);
  const scale = t.assess && d.definition.scales?.[t.assess];
  const outcome = t.outcome && (scale && t.score != null ? formatScore(scale, t.score) : (t.labels ?? OUTCOME[t.type] ?? OUTCOME.approval)[t.outcome === 'approved' ? 0 : 1]);
  const doneBy = t.completed_by_name ? ` · ${t.status === 'skipped' ? 'übersprungen' : 'erledigt'}: ${t.completed_by_name}, ${date(t.completed_at)}` : '';
  return html`<li class="task ${t.status} ${t.blocked ? 'blocked' : ''}">
    <span class="ico">${icon}</span>
    <div class="body">
      <b>${t.title}</b>${outcome ? html` <span class="tag ${t.outcome}">${outcome}</span>` : ''}
      <div class="small muted">${t.assess ? 'Bewertung' : TYPES[t.type]}${assignee(t, d)}${t.status === 'open' ? due(t.due_date) : doneBy}${d.me.staff ? sharedWith(t, d) : ''}</div>
      ${t.description && t.status === 'open' ? html`<div class="small">${linkify(t.description)}</div>` : ''}
      ${t.form && t.status === 'open' ? formButton(t, d) : ''}
      ${t.blocked && waitsFor.length ? html`<div class="small muted">wartet auf: ${waitsFor.join(', ')}</div>` : ''}
      ${taskResult(t, d)}
      ${d.me.staff ? (d.upload_links ?? []).filter(l => l.task_id === t.id).map(l => html`<div class="small muted">Upload-Link für ${l.label}, gültig bis ${date(l.expires_at)}
        · <button class="link" data-on="revokeLinks" data-id="${t.id}">widerrufen</button></div>`) : ''}
      ${withActions ? moneyStatus(t, d) : ''}
      ${withActions && canWork(t, d) ? taskActions(t, d) : ''}
    </div>
    ${withActions && d.me.staff ? taskTools(t, d) : ''}
  </li>`;
}

// A form the template brings for this step, generated as a PDF with what the case already knows.
function formButton(t, d) {
  const f = d.definition.forms?.find(x => x.key === t.form);
  return f ? html`<div><button class="link" data-on="taskForm" data-id="${t.id}">Formular „${f.title}“ vorausgefüllt herunterladen</button></div>` : '';
}

on.taskForm = async ({ id }) => {
  const [{ formPdf, formFilename, saveFile }, f] = await Promise.all([import('../formpdf.js'), api(`/tasks/${id}/form`)]);
  saveFile(await formPdf(f), formFilename(f));
};

// Per step: besides the role doing it, other roles can follow it (status, outcome, result if the document is shared).
const shareableRoles = (t, d) => guestRoles(d).filter(r => r.key !== t.role);

function sharedWith(t, d) {
  const names = shareableRoles(t, d).filter(r => t.visible_to.includes(r.key) || t.visible_to.includes('*')).map(r => r.label);
  return names.length ? ` · auch sichtbar für: ${names.join(', ')}` : '';
}

// Money steps (template "money"): the claim a task creates, decides on or pays. Only the team sees money.
const claimFor = (t, d) => d.finance?.claims.filter(c => c.title === (t.money.claim ?? t.money.decision ?? t.money.payment)).at(-1);

const hasMoney = (t, d) => t.money && d.finance && d.definition.finance;

function amountInput(t, d) {
  const m = t.money;
  const claim = claimFor(t, d);
  const label = m.claim ? (m.direction === 'payable' ? 'Rechnungsbetrag €' : 'beantragt €')
    : m.decision ? 'anerkannt €' : claim?.direction === 'receivable' ? 'erhalten €' : 'bezahlt €';
  const value = m.decision ? claim?.amount_cents : m.payment ? Math.max(claim?.open_cents ?? 0, 0) : 0;
  return html`<label class="row small">${label} <input name="amount" required inputmode="decimal" size="9" value="${value ? plainEur(value) : ''}"></label>`;
}

// Field for open tasks: an amount, or a hint when the claim it refers to does not exist yet.
function moneyField(t, d) {
  if (!hasMoney(t, d)) return '';
  if (!t.money.claim && !claimFor(t, d)) {
    return html`<span class="small warn">Es gibt noch keine Forderung „${t.money.decision ?? t.money.payment}“ – erst bei der Aufgabe davor den Betrag eintragen.</span>`;
  }
  return amountInput(t, d);
}

// For done tasks: what the step booked, or a form to add the missing amount.
function moneyStatus(t, d) {
  if (!hasMoney(t, d) || t.status !== 'done') return '';
  const m = t.money;
  const c = claimFor(t, d);
  const missing = !c || (m.decision && !c.decisions.length) || (m.payment && !c.transactions.length);
  if (missing) {
    return !m.claim && !c ? '' : html`<form data-submit="taskMoney" data-id="${t.id}" class="row small">
      <span class="warn">Betrag fehlt noch:</span> ${amountInput(t, d)} <button>Nachtragen</button></form>`;
  }
  return html`<div class="result small">${m.claim ? `Forderung „${c.title}“: ${eur(c.amount_cents)}`
    : m.decision ? `„${c.title}“: anerkannt ${eur(c.recognized_cents)} von ${eur(c.amount_cents)}`
    : `„${c.title}“: ${c.direction === 'payable' ? 'bezahlt' : 'erhalten'} ${eur(c.settled_cents)} · offen ${eur(Math.max(c.open_cents, 0))}`}</div>`;
}

// File input of a step: the kinds it takes (template "files.accept"), several files if allowed.
const fileInput = (t, required) => html`<input type="file" name="file" ${required ? 'required' : html`title="Datei (optional)"`}
  accept="${acceptAttr(t.files)}" ${t.files?.multiple ? 'multiple' : ''}>`;

// The task type decides the actions. Upload and signature tasks are done by uploading; decisions by their
// buttons (a file is only attached); everything else by "Erledigt", optionally with a file and an amount.
export function taskActions(t, d) {
  const money = moneyField(t, d);
  if (NEEDS_FILE.includes(t.type)) {
    const several = t.files?.multiple;
    return html`<div class="actions"><form data-submit="upload" class="row">
      <input type="hidden" name="task_id" value="${t.id}">${fileInput(t, true)}${money}
      <button>${several ? 'Dateien hochladen' : resultsOf(t, d).length ? 'Korrigierte Fassung hochladen' : 'Hochladen'}</button>
      ${filesHint(t.files) ? html`<span class="small muted">${filesHint(t.files)}</span>` : ''}
    </form></div>`;
  }
  if (DECISIONS.includes(t.type)) {
    const deps = d.tasks.filter(x => t.depends_on.includes(x.id));
    const back = [...new Set(deps.map(x => x.role).filter(Boolean))].map(roleLabel).join(', ') || 'vorherige Aufgabe';
    const [yes, no] = t.labels ?? DECISION_LABELS[t.type];
    return html`<div class="actions">
      ${t.doc_type ? html`<form data-submit="upload" class="row">
        <input type="hidden" name="task_id" value="${t.id}">${fileInput(t, true)}<button>Datei anhängen</button>
      </form>` : ''}
      ${t.assess ? scoreForm(t, d) : html`<button data-on="taskAct" data-act="approve" data-id="${t.id}">${yes}</button>
      <details class="inline"><summary class="btn">${no}</summary>
        <form data-submit="taskNote" data-act="reject" data-id="${t.id}" class="stack">
          <textarea name="note" rows="2" placeholder="Begründung (optional)"></textarea><button>${no}</button>
        </form></details>`}
      ${deps.length && !t.assess ? html`<details class="inline"><summary class="btn">Rückfrage an ${back}</summary>
        <form data-submit="taskNote" data-act="question" data-id="${t.id}" class="stack">
          <textarea name="note" rows="3" required placeholder="Was soll ergänzt oder korrigiert werden?"></textarea>
          <button>Rückfrage senden</button>
        </form></details>` : ''}
    </div>`;
  }
  return html`<div class="actions"><form data-submit="complete" data-id="${t.id}" class="row">
    ${t.doc_type ? fileInput(t, false) : ''}${money}<button>Erledigt</button>
  </form></div>`;
}

const taskTools = (t, d) => html`<details class="menu"><summary title="Aufgabe bearbeiten">⋯</summary><div class="menu-body small">
  ${shareableRoles(t, d).length ? html`<div>Sichtbar für:</div>${shareableRoles(t, d).map(r => html`<label class="row">
    <input type="checkbox" data-change="taskShare" data-id="${t.id}" value="${r.key}" ${t.visible_to.includes(r.key) || t.visible_to.includes('*') ? 'checked' : ''}> ${r.label}</label>`)}` : ''}
  ${NEEDS_FILE.includes(t.type) || t.doc_type ? html`<div>Dateien:</div>
    <label class="row"><input type="checkbox" data-change="taskFiles" data-id="${t.id}" data-kind="multiple" ${t.files?.multiple ? 'checked' : ''}> mehrere auf einmal</label>
    <div class="muted">erlaubt (nichts angehakt: alle):</div>
    ${Object.entries(FILE_KIND_LABELS).map(([k, label]) => html`<label class="row"><input type="checkbox" data-change="taskFiles" data-id="${t.id}"
      data-kind="accept" value="${k}" ${t.files?.accept?.includes(k) ? 'checked' : ''}> ${label}</label>`)}` : ''}
  ${t.status === 'open' ? html`<label class="row">Frist <input type="date" value="${t.due_date ?? ''}" data-change="due" data-id="${t.id}"></label>
    <button class="link" data-on="taskAct" data-act="skip" data-id="${t.id}">überspringen</button>`
    : html`<button class="link" data-on="taskAct" data-act="reopen" data-id="${t.id}">wieder öffnen</button>`}
  ${t.status === 'open' && (t.doc_type || NEEDS_FILE.includes(t.type)) ? html`<details><summary class="small">Upload-Link für Externe</summary>
    <form data-submit="uploadLink" data-id="${t.id}" class="stack">
      <input name="label" placeholder="Wer lädt hoch? (Name oder Stelle)" required>
      <input name="email" type="email" placeholder="E-Mail (optional, dann per Mail)">
      <label class="row">gültig <input name="days" type="number" min="1" max="60" value="14" style="width:5em"> Tage</label>
      <button>Link erzeugen</button>
    </form>
  </details>` : ''}
  <details><summary class="small">Titel und Beschreibung</summary>
    <form data-submit="editTask" data-id="${t.id}" class="stack">
      <input name="title" value="${t.title}" required>
      <textarea name="description" rows="3" placeholder="Beschreibung (optional)">${t.description ?? ''}</textarea>
      <button>Speichern</button>
    </form>
  </details>
  <button class="link" data-on="deleteTask" data-id="${t.id}">entfernen</button>
</div></details>`;

export const addTaskForm = (d, phaseId) => html`<details class="add"><summary>+ Aufgabe</summary>
  <form data-submit="addTask" class="stack small">
    <input type="hidden" name="phase_id" value="${phaseId}">
    <input name="title" placeholder="Titel" required>
    <div class="row">
      <select name="type">${Object.entries(TYPES).map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select>
      <select name="role"><option value="">– zuständig –</option>${d.definition.roles.map(r => html`<option value="${r.key}">${r.label}</option>`)}</select>
      <select name="doc_type"><option value="">– Dokumenttyp –</option>${d.definition.document_types.map(t => html`<option value="${t.key}">${t.label}</option>`)}</select>
    </div>
    <div class="row">
      <select name="depends_on"><option value="">– startet sofort –</option>${d.tasks.map(t => html`<option value="${t.id}">nach: ${t.title}</option>`)}</select>
      <input type="date" name="due_date">
    </div>
    <button>Hinzufügen</button>
  </form>
</details>`;

// Input for an assessed step: the template's scale decides what can be entered.
function scoreForm(t, d) {
  const scale = d.definition.scales[t.assess];
  const label = t.role && t.role !== d.me.role ? `${scale.label} für ${roleLabel(t.role)} eintragen` : `${scale.label} vergeben`;
  return html`<form data-submit="taskScore" data-id="${t.id}" class="row">
    ${scale.options ? html`<select name="score" required><option value="">${scale.label} …</option>${scale.options.map(o => html`<option value="${o.value}">${o.label}</option>`)}</select>`
      : html`<input name="score" required inputmode="decimal" placeholder="${scale.label}" title="${scale.hint ?? ''}" size="12">`}
    <input name="note" placeholder="Begründung (optional)"><button>${label}</button>
  </form>${scale.hint ? html`<div class="muted small">${scale.hint}</div>` : ''}`;
}

// Combined values the template defines (e.g. a module grade from two examiners), shown below the phase of their last
// step once all of them are assessed; can be taken over into a field.
export function aggregatesSummary(d, phaseId) {
  return (d.definition.aggregates ?? []).filter(a => d.tasks.findLast(t => a.from.includes(t.key))?.phase_id === phaseId).map(a => {
    const steps = d.tasks.filter(t => a.from.includes(t.key));
    if (!steps.length || steps.some(t => t.status === 'open')) return '';
    const scale = d.definition.scales[a.scale];
    const given = steps.filter(t => t.score != null).map(t => t.score);
    const r = aggregate(a, scale, given);
    if (!r) return '';
    const text = formatScore(scale, r.value);
    const field = a.field && d.definition.fields.find(f => f.key === a.field);
    return html`<p class="small card">${a.label} rechnerisch: <b>${text}</b> (${r.passed ? 'bestanden' : `nicht bestanden${r.value !== r.raw ? `, rechnerisch ${formatScore(scale, r.raw)}` : ''}`})
      aus ${given.map(v => formatScore(scale, v)).join(' und ')}${a.note ? ` · ${a.note}` : ''}
      ${field && d.case.fields[a.field] !== text ? html`<button class="link" data-on="takeAggregate" data-field="${a.field}" data-value="${text}">als „${field.label}“ übernehmen</button>`
        : field ? html`<span class="muted">· steht in den Angaben</span>` : ''}</p>`;
  });
}

on.takeAggregate = async ({ field, value }) => { await api(caseApi('/fields'), { method: 'PATCH', body: { fields: { [field]: value } } }); reload(); };

on.taskAct = async ({ act, id }) => { await api(`/tasks/${id}/action`, { body: { action: act } }); reload(); };

submit.taskMoney = async (fd, form) => {
  const amount_cents = amountOf(fd);
  if (amount_cents == null) return;
  await api(`/tasks/${form.dataset.id}/money`, { body: { amount_cents } });
  reload();
};

submit.taskScore = async (fd, form) => { await api(`/tasks/${form.dataset.id}/action`, { body: { action: 'assess', score: fd.get('score'), note: fd.get('note') } }); reload(); };

submit.taskNote = async (fd, form) => { await api(`/tasks/${form.dataset.id}/action`, { body: { action: form.dataset.act, note: fd.get('note') } }); reload(); };

on.deleteTask = async ({ id }) => { if (confirm('Aufgabe entfernen?')) { await api(`/tasks/${id}`, { method: 'DELETE' }); reload(); } };

submit.uploadLink = async (fd, form) => {
  const { sent, link } = await api(`/tasks/${form.dataset.id}/upload-links`, { body: { label: fd.get('label'), email: fd.get('email'), days: Number(fd.get('days')) } });
  if (!link) alert('Upload-Link per E-Mail verschickt.');
  else prompt(sent ? 'E-Mail verschickt. Lokal zusätzlich der Link:' : 'Upload-Link – bitte selbst weitergeben (wird nur jetzt angezeigt):', link);
  reload();
};

on.revokeLinks = async ({ id }) => { if (confirm('Alle Upload-Links dieser Aufgabe widerrufen?')) { await api(`/tasks/${id}/upload-links`, { method: 'DELETE' }); reload(); } };

submit.editTask = async (fd, form) => {
  await api(`/tasks/${form.dataset.id}`, { method: 'PATCH', body: { title: fd.get('title'), description: fd.get('description') } });
  reload();
};

change.taskShare = async el => {
  const boxes = document.querySelectorAll(`[data-change="taskShare"][data-id="${el.dataset.id}"]`);
  await api(`/tasks/${el.dataset.id}`, { method: 'PATCH', body: { visible_to: [...boxes].filter(b => b.checked).map(b => b.value) } });
  reload();
};

// How a step takes files, changed for this case: several at once, which kinds (none ticked: every kind).
change.taskFiles = async el => {
  const boxes = [...document.querySelectorAll(`[data-change="taskFiles"][data-id="${el.dataset.id}"]`)];
  const files = { multiple: boxes.some(b => b.dataset.kind === 'multiple' && b.checked), accept: boxes.filter(b => b.dataset.kind === 'accept' && b.checked).map(b => b.value) };
  await api(`/tasks/${el.dataset.id}`, { method: 'PATCH', body: { files } });
  reload();
};

change.due = async el => { await api(`/tasks/${el.dataset.id}`, { method: 'PATCH', body: { due_date: el.value || null } }); reload(); };

// "Erledigt" with an optional file (then it is an upload through the task) and an optional amount.
submit.complete = async (fd, form) => {
  const amount_cents = fd.get('amount') ? amountOf(fd) : undefined;
  if (amount_cents === null) return;
  if (fd.getAll('file').some(f => f.size)) {
    const up = new FormData();
    for (const f of fd.getAll('file')) up.append('file', f);
    up.append('task_id', form.dataset.id);
    if (amount_cents != null) up.append('amount_cents', amount_cents);
    await uploadFiles(up);
  } else {
    await api(`/tasks/${form.dataset.id}/action`, { body: { action: 'complete', amount_cents } });
  }
  reload();
};

submit.addTask = async fd => {
  const b = Object.fromEntries(fd);
  b.depends_on = b.depends_on ? [b.depends_on] : [];
  await api(caseApi('/tasks'), { body: b });
  reload();
};
