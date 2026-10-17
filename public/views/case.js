// Case page for the team and for guests: frame, timeline, details (fields, people, subcases, rules), case actions.
import { filesHint, RULE_FIELD_LABELS, RULE_OP_LABELS, RULE_TRIGGER_LABELS, STAFF } from '../shared/vocab.js';
import { change, cur, me, on, set, submit } from '../state.js';
import { ACCESS_LABELS, api, CAN, count, date, dateTime, due, eur, go, html, linkify, page, reload, shortHash, today, TYPES, VERDICT } from '../lib.js';
import { addTaskForm, aggregatesSummary, canWork, questionsTo, resultsOf, taskActions, taskItem, taskResult } from './tasks.js';
import { documents, verifyFile } from './documents.js';
import { financeSection, moneyWord } from './finance.js';

const EVENTS = {
  'case.created': p => `hat den Vorgang angelegt (Vorlage ${p.template} v${p.version})`,
  'case.closed': () => 'hat den Vorgang abgeschlossen',
  'case.reopened': () => 'hat den Vorgang wieder geöffnet',
  'phase.added': p => `hat die Phase „${p.phase}“ ergänzt`,
  'task.added': p => `hat die Aufgabe „${p.task}“ hinzugefügt`,
  'task.updated': p => `hat „${p.task}“ geändert (${Object.entries(p.changes).map(([k, v]) => (k === 'files'
    ? `Dateien: ${filesHint(v && JSON.parse(v)) || 'eine Datei, alle Arten'}` : `${k}: ${v ?? '–'}`)).join(', ')})`,
  'task.removed': p => `hat „${p.task}“ entfernt`,
  'task.complete': p => `hat „${p.task}“ erledigt`,
  'task.approve': p => (p.score_label ?? p.grade ? `hat „${p.task}“ bewertet: ${p.score_label ?? p.grade} (${p.verdict})` : p.verdict ? `hat „${p.task}“ entschieden: ${p.verdict}` : `hat „${p.task}“ ${(VERDICT[p.type] ?? VERDICT.approval)[0]}`),
  'task.reject': p => (p.score_label ?? p.grade ? `hat „${p.task}“ bewertet: ${p.score_label ?? p.grade} (${p.verdict})` : p.verdict ? `hat „${p.task}“ entschieden: ${p.verdict}` : `hat „${p.task}“ ${(VERDICT[p.type] ?? VERDICT.approval)[1]}`),
  'task.question': p => `hat zu „${p.task}“ eine Rückfrage gestellt`,
  'task.skip': p => `hat „${p.task}“ übersprungen`,
  'task.reopen': p => `hat „${p.task}“ wieder geöffnet`,
  'request.created': p => `hat ein Anliegen eingereicht: „${p.task}“`,
  'document.uploaded': p => (p.channel === 'mail' ? `E-Mail „${p.subject}“${p.attachments?.length ? ` mit Anhang: ${p.attachments.join(', ')}` : ''} abgelegt (SHA-256 ${shortHash(p.sha256)})`
    : `hat „${p.document}“ hochgeladen (v${p.version}: ${p.filename}${p.sha256 ? `, SHA-256 ${shortHash(p.sha256)}` : ''})${p.completed ? ` und damit „${p.task}“ erledigt` : p.task ? ` zu „${p.task}“` : ''}`),
  'upload.rejected': p => `wollte „${p.filename}“ hochladen – abgelehnt`,
  'document.updated': p => `hat Freigabe oder Status von „${p.document}“ geändert${p.final ? ' (Endfassung)' : ''}`,
  'role.added': p => `hat die Rolle „${p.role}“ angelegt`,
  'invitation.withdrawn': p => `hat die Einladung an ${p.email} zurückgezogen`,
  'document.version_deleted': p => `hat Version ${p.version} von „${p.document}“ gelöscht`,
  'upload_link.created': p => `hat einen Upload-Link für „${p.task}“ erstellt (${p.label}, ${p.days} Tage gültig)`,
  'upload_link.revoked': p => `hat die Upload-Links für „${p.task}“ widerrufen`,
  'case.fields_updated': p => (p.from ? `hat aus „${p.from}“ in die Angaben übernommen: ${p.fields.join(', ')}` : `hat die Angaben geändert (${p.fields.join(', ')})`),
  'form.mismatch': p => `Achtung: „${p.document}“ passt nicht zu den Angaben (${p.fields.join(', ')})`,
  'subcase.created': p => `hat den Teilvorgang „${p.title}“ angelegt (Vorlage ${p.template})`,
  'subcase.closed': p => `hat den Teilvorgang „${p.title}“ abgeschlossen`,
  'case.moved': p => `hat den Vorgang vom Workspace „${p.from}“ nach „${p.to}“ verschoben`,
  'case.saved_as_template': p => `hat den Ablauf als Vorlage „${p.template}“ (Version ${p.version}) gespeichert`,
  'rule.toggled': p => `hat die Regel „${p.rule}“ ${p.enabled ? 'eingeschaltet' : 'ausgeschaltet'}`,
  'signature.changed': p => `Achtung: In „${p.document}“ signiert ${p.signers.join(', ')} mit einem anderen Schlüssel als bisher`,
  'signature.assigned': p => (p.self ? `hat die eigene Signatur in „${p.document}“ bestätigt` : `hat die Signatur in „${p.document}“ ${p.signer} zugeordnet`),
  'participant.declined': p => `${p.email} möchte NomoCase nicht nutzen – bitte auf dem bisherigen Weg per E-Mail weitermachen`,
  'consent.withdrawn': () => 'hat die Einwilligung widerrufen – bitte auf dem bisherigen Weg per E-Mail weitermachen',
  'participant.invited': p => `hat ${p.email} als ${p.role} ${p.again ? 'erneut ' : ''}eingeladen`,
  'participant.joined': p => `ist als ${p.role} beigetreten`,
  'participant.revoked': p => `hat den Zugang von ${p.name} beendet`,
  'claim.added': (p, d) => `hat „${p.claim}“ (${moneyWord(d, p.direction)}) über ${eur(p.amount_cents)} erfasst`,
  'decision.added': p => `hat für „${p.claim}“ ${eur(p.approved_cents)} von ${eur(p.amount_cents)} als anerkannt erfasst`,
  'transaction.booked': p => `hat ${eur(p.amount_cents)} auf „${p.claim}“ gebucht (${p.direction === 'payable' ? 'Zahlung' : 'Eingang'})`,
  'transaction.reversed': p => `hat die Buchung über ${eur(p.amount_cents)} auf „${p.claim}“ storniert`,
};

export const roleLabel = k => cur?.definition.roles.find(r => r.key === k)?.label ?? k ?? '–';

export const docTypeLabel = k => cur?.definition.document_types.find(t => t.key === k)?.label ?? '';

export const guestRoles = d => d.definition.roles.filter(r => !STAFF.includes(r.access));

const statusText = d => (d.case.status === 'closed' ? 'Abgeschlossen' : d.case.phase ?? 'Alle Aufgaben erledigt');

export async function caseView(id) {
  if (cur?.case.id !== id) editingFields = false;
  set({ cur: await api(`/cases/${id}`) });
  set({ stamp: cur.stamp });
  page(cur.me.staff ? staffCase(cur) : guestCase(cur));
}

// A role is a seat in the case. People are invited into a role; tasks and sharing go to the role,
// so everyone holding it sees the same and one of them is enough to do a task.
const active = p => !p.revoked_at && !(p.expires_at && p.expires_at < new Date().toISOString());

export const holders = (d, role) => d.participants.filter(p => p.role === role && active(p)).map(p => p.name);

// Who sees an entry. Only worth showing when the case has external roles at all.
function audienceTag(v, d) {
  const ext = guestRoles(d);
  if (!ext.length) return '';
  const shared = v.filter(k => ext.some(r => r.key === k));
  const text = v.includes('*') ? 'alle' : shared.length ? `Team + ${shared.map(roleLabel).join(', ')}` : 'nur Team';
  return html` · <span class="tag ${text === 'nur Team' ? 'internal' : ''}">${text}</span>`;
}

// Long texts (messages, notes) show three lines with "…" and open on request; open ones stay open on live refresh.
const openEvents = new Set();
const isLong = text => text.length > 240 || text.split('\n').length > 3;

function eventItem(e, d) {
  const text = e.payload.body ?? e.payload.note ?? e.payload.description;
  const long = text && isLong(String(text)), open = openEvents.has(String(e.id));
  return html`<li class="ev ${e.type === 'comment' ? 'comment' : ''}">
    <div class="small muted">${dateTime(e.created_at)}${d.me.staff ? audienceTag(e.visible_to, d) : ''}</div>
    <div><b>${e.actor ?? e.payload.via ?? (e.payload.rule ? 'Automatik' : 'System')}</b>${e.payload.via ? html` <span class="tag">${e.payload.channel === 'mail' ? 'E-Mail' : 'Upload-Link'}</span>` : ''} ${e.type === 'comment' ? '' : EVENTS[e.type]?.(e.payload, d) ?? e.type}
      ${e.payload.rule ? html`<span class="tag">Regel: ${e.payload.rule}</span>` : ''}</div>
    ${text ? html`<p class="${long ? `clamp${open ? ' open' : ''}` : ''}">${linkify(text)}</p>` : ''}
    ${long ? html`<button class="link small" data-on="toggleEvent" data-id="${e.id}">${open ? 'weniger anzeigen' : 'mehr anzeigen'}</button>` : ''}
  </li>`;
}

on.toggleEvent = ({ id }, el) => {
  const open = el.previousElementSibling.classList.toggle('open');
  if (open) openEvents.add(id); else openEvents.delete(id);
  el.textContent = open ? 'weniger anzeigen' : 'mehr anzeigen';
};

let onlyMessages = false;

const MESSAGE_TYPES = ['comment', 'task.question', 'task.reject', 'request.created'];

// Newest first, writing on top.
const timeline = d => html`${d.me.access === 'guest_viewer' ? '' : html`<form data-submit="comment" class="stack">
    <textarea name="body" rows="2" placeholder="Nachricht schreiben…" aria-label="Nachricht" required></textarea>
    <div class="row">
      ${d.me.staff && guestRoles(d).length ? html`<select name="visible_to" aria-label="Empfänger">
        <option value="*">an alle</option>
        <option value="">nur Team (intern)</option>
        ${guestRoles(d).map(r => html`<option value="${r.key}">Team + ${r.label}</option>`)}
      </select>` : ''}
      <button>Senden</button>
      <label class="small muted push"><input type="checkbox" data-change="onlyMessages" ${onlyMessages ? 'checked' : ''}> nur Nachrichten</label>
    </div>
  </form>`}
  <ul class="timeline">${d.events.filter(e => !onlyMessages || MESSAGE_TYPES.includes(e.type)).reverse().map(e => eventItem(e, d))}</ul>`;

// Participants grouped by role (team first), including empty roles, so it is clear who holds which seat.
function participantsSection(d) {
  const roles = [...d.definition.roles].sort((a, b) => STAFF.includes(b.access) - STAFF.includes(a.access));
  return html`<h3>Beteiligte</h3>
    <ul class="list small">${roles.map(r => {
      const people = d.participants.filter(p => p.role === r.key);
      const pending = d.invitations.filter(i => i.role === r.key);
      return html`<li><b>${r.label}</b> <span class="muted">· ${ACCESS_LABELS[r.access]}</span>
        ${people.map(p => html`<div class="${active(p) ? '' : 'revoked'}">${p.user_id === me.user.id ? 'Sie' : p.name}
          <span class="muted">${p.revoked_at ? `· Zugang beendet am ${date(p.revoked_at)}` : p.expires_at ? `· Zugang bis ${date(p.expires_at)}` : ''}</span>
          ${d.me.owner && active(p) && p.user_id !== me.user.id ? html`<button class="link" data-on="sendLink" data-id="${p.user_id}" data-name="${p.name}">Anmeldelink senden</button>
            · <button class="link" data-on="revoke" data-id="${p.user_id}">Zugang beenden</button>` : ''}</div>`)}
        ${pending.map(i => html`<div class="${i.expired ? 'warn' : 'muted'}">${i.email} – ${i.expired ? `Einladung abgelaufen am ${date(i.expires_at)}` : 'eingeladen, noch nicht angenommen'}
          ${d.me.owner ? html`· ${i.expired ? html`<button class="link" data-on="reinvite" data-email="${i.email}" data-role="${i.role}">erneut einladen</button> · ` : ''}<button class="link" data-on="withdraw" data-email="${i.email}">zurückziehen</button>` : ''}</div>`)}
        ${people.some(active) || pending.length ? '' : html`<div class="muted">niemand${d.me.owner ? html` – <button class="link" data-on="inviteRole" data-role="${r.key}">einladen</button>` : ''}</div>`}
      </li>`;
    })}</ul>
    ${d.me.owner ? inviteForm(d) : ''}`;
}

const inviteForm = d => {
  const roles = [...d.definition.roles].sort((a, b) => STAFF.includes(a.access) - STAFF.includes(b.access)); // externals first
  return html`<details class="add" id="invite"><summary>+ Person einladen</summary>
    <form data-submit="invite" class="stack small">
      <input type="email" name="email" placeholder="E-Mail" required>
      <label class="stack">Rolle im Vorgang
        <select name="role" data-change="pickInviteRole">
          ${roles.map(r => html`<option value="${r.key}">${r.label} – ${CAN[r.access]}${holders(d, r.key).length ? ` · derzeit: ${holders(d, r.key).join(', ')}` : ''}</option>`)}
          <option value="__new">Neue Rolle anlegen …</option>
        </select>
      </label>
      <div id="newrole" class="row" hidden>
        <input name="new_label" placeholder="Name der Rolle, z. B. Steuerberater">
        <select name="new_access" aria-label="Zugriff der neuen Rolle">${['guest_contributor', 'guest_viewer', 'case_editor'].map(a => html`<option value="${a}">${ACCESS_LABELS[a]}</option>`)}</select>
      </div>
      <label class="row">Zugang bis <input type="date" name="access_until"> <span class="muted">(optional)</span></label>
      <p class="muted">Alle Personen in einer Rolle sehen dasselbe und teilen sich deren Aufgaben.</p>
      <button>Einladung senden</button>
    </form>
  </details>`;
};

function staffCase(d) {
  const loose = d.tasks.filter(t => !t.phase_id);
  const deadlines = d.tasks.filter(t => t.status === 'open' && t.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date));
  return html`<main>
    <h1>${d.case.title}</h1>
    <div class="muted">${d.parent ? html`Teil von <a href="#/case/${d.parent.id}">${d.parent.title}</a> · ` : ''}${d.case.template_name ?? 'ohne Vorlage'} v${d.case.template_version} · <b>${statusText(d)}</b></div>
    <nav class="tabs">${[['tasks', 'Aufgaben'], ['log', 'Verlauf'], ['info', 'Details']].map(([k, label]) =>
      html`<button class="${caseTab === k ? 'on' : ''}" data-on="caseTab" data-tab="${k}">${label}</button>`)}</nav>
    <div class="cols" style="margin-top:12px">
      <section class="col ${caseTab === 'tasks' ? 'active' : ''}">
        <h3>Prozess</h3>
        ${d.phases.map(ph => html`<h4>${ph.title}</h4>
          <ul class="tasks">${d.tasks.filter(t => t.phase_id === ph.id).map(t => taskItem(t, d))}</ul>
          ${aggregatesSummary(d, ph.id)}${addTaskForm(d, ph.id)}`)}
        ${loose.length ? html`<h4>Weitere Aufgaben</h4><ul class="tasks">${loose.map(t => taskItem(t, d))}</ul>` : ''}
        <details class="add"><summary>+ Phase</summary>
          <form data-submit="addPhase" class="row"><input name="title" placeholder="z. B. Verlängerung" required><button>Anlegen</button></form>
        </details>
      </section>
      <section class="col ${caseTab === 'log' ? 'active' : ''}"><h3>Verlauf</h3>${timeline(d)}</section>
      <aside class="col ${caseTab === 'info' ? 'active' : ''}">
        ${fieldsSection(d)}
        <h3>Fristen</h3>
        ${deadlines.length ? html`<ul class="list small">${deadlines.map(t => html`<li class="${t.due_date < today ? 'warn' : ''}">${date(t.due_date)} – ${t.title}</li>`)}</ul>` : html`<p class="muted small">Keine offenen Fristen.</p>`}
        ${financeSection(d)}
        ${participantsSection(d)}
        <h3>Dokumente</h3>${documents(d)}${verifyFile()}
        ${d.case.inbox ? html`<p class="small">E-Mails an diesen Vorgang: <code>${d.case.inbox}</code>
          <button class="link" data-on="copyText" data-text="${d.case.inbox}">kopieren</button><br>
          <span class="muted">In CC setzen: Jede Mail wird als Dokument abgelegt (nur für das Team sichtbar, freigebbar wie andere Dokumente).</span></p>` : ''}
        ${subcasesSection(d)}
        ${rulesSection(d)}
        ${d.me.owner ? html`<h3>Vorgang</h3>
          <p class="small muted">${retentionText(d)}</p>
          <div class="row">${d.case.status === 'open'
            ? html`<button data-on="caseStatus" data-status="closed">Vorgang abschließen</button>`
            : html`<button data-on="caseStatus" data-status="open">Wieder öffnen</button>`}
            <button class="danger" data-on="deleteCase">Vorgang löschen</button></div>
          ${saveTemplateForm(d)}${moveForm(d)}` : ''}
      </aside>
    </div>
  </main>`;
}

// Externals get a radically simpler view: their next task (with any Rückfrage), their documents, messages.
function guestCase(d) {
  const mine = d.tasks.filter(t => t.role === d.me.role || t.created_by === me.user.id);
  const next = mine.find(t => t.role === d.me.role && canWork(t, d));
  const last = next && resultsOf(next, d).at(-1);
  const asked = next && questionsTo(next, d).filter(e => !last || e.created_at > last.v.created_at).at(-1);
  return html`<main class="narrow">
    <h1>${d.case.title}</h1>
    <div class="muted">${d.parent ? html`Teil von <a href="#/case/${d.parent.id}">${d.parent.title}</a> · ` : ''}Status: <b>${statusText(d)}</b> · Sie sind beteiligt als ${roleLabel(d.me.role)}</div>
    ${d.me.access !== 'guest_viewer' ? html`<section class="card next"><h3>Nächste Aufgabe</h3>
      ${next ? html`<b>${next.title}</b>${due(next.due_date)}
        ${asked ? html`<div class="ask"><b>Rückfrage von ${asked.actor}:</b> „${asked.payload.note}“</div>` : ''}
        ${next.description ? html`<p>${linkify(next.description)}</p>` : ''}
        ${taskResult(next, d)}
        ${taskActions(next, d)}`
        : html`<p class="muted">Gerade ist nichts von Ihnen zu tun.${d.case.waiting_on.length ? ` Der Vorgang wartet auf: ${d.case.waiting_on.join(', ')}.` : ''}</p>`}
    </section>` : html`<p class="muted">Sie können die für ${roleLabel(d.me.role)} freigegebenen Dokumente und Nachrichten lesen.</p>`}
    <h3>Ablauf</h3>
    <div class="phases">${d.phases.map(ph => html`<span class="${ph.title === d.case.phase ? 'on' : ''}">${ph.title}</span>`)}</div>
    ${d.phases.map(ph => {
      const steps = d.tasks.filter(t => t.phase_id === ph.id);
      return steps.length ? html`<h4>${ph.title}</h4><ul class="tasks">${steps.map(t => taskItem(t, d, false))}</ul>` : '';
    })}
    ${d.tasks.some(t => !t.phase_id) ? html`<h4>Anliegen</h4><ul class="tasks">${d.tasks.filter(t => !t.phase_id).map(t => taskItem(t, d, false))}</ul>` : ''}
    <h3>Dokumente</h3>${documents(d)}${verifyFile()}
    <h3>Nachrichten & Verlauf</h3>
    ${d.me.access === 'guest_contributor' ? html`<details class="add"><summary>Anliegen einreichen, z. B. eine Verlängerung beantragen</summary>
      <form data-submit="request" class="stack">
        <input name="title" placeholder="z. B. Verlängerung um 4 Wochen" required>
        <textarea name="description" rows="3" placeholder="Begründung"></textarea>
        <button>Einreichen</button>
      </form>
    </details>` : ''}
    ${timeline(d)}
  </main>`;
}

// Angaben: shown as a list, editable in place by the team.
let editingFields = false;

function fieldsSection(d) {
  const defs = d.definition.fields;
  if (!defs.length) return '';
  const value = f => d.case.fields[f.key] ?? '';
  if (editingFields) {
    return html`<h3>Angaben</h3>
      <form data-submit="saveFields" class="stack small">
        ${defs.map(f => html`<label class="stack">${f.label}<input name="${f.key}" type="${f.type === 'date' ? 'date' : 'text'}" value="${value(f)}"></label>`)}
        <div class="row"><button>Speichern</button><button type="button" class="link" data-on="editFields">Abbrechen</button></div>
        ${defs.some(f => f.type === 'date') ? html`<p class="muted">Ändern Sie ein Datum, wandern offene Fristen mit, die daraus stammen.</p>` : ''}
      </form>`;
  }
  return html`<h3>Angaben ${d.me.staff ? html`<button class="link small" data-on="editFields" data-open="1">bearbeiten</button>` : ''}</h3>
    <dl>${defs.map(f => html`<dt>${f.label}</dt><dd>${(f.type === 'date' ? date(value(f)) : value(f)) || '–'}</dd>`)}</dl>`;
}

on.editFields = ({ open }) => { editingFields = !!open; rerender(); };

submit.saveFields = async fd => {
  await api(caseApi('/fields'), { method: 'PATCH', body: { fields: Object.fromEntries(fd) } });
  editingFields = false;
  reload();
};

// Subcases: own cases (template, participants) that belong to this one, e.g. an objection or an extension request.
function subcasesSection(d) {
  if (!d.subcases.length && !d.me.owner) return '';
  return html`<h3>Teilvorgänge</h3>
    ${d.subcases.length ? html`<ul class="list small">${d.subcases.map(c => html`<li><a href="#/case/${c.id}">${c.title}</a>
      <span class="muted">· ${c.template ?? ''} · ${c.status === 'closed' ? 'abgeschlossen' : c.phase ?? 'alle Aufgaben erledigt'}</span></li>`)}</ul>`
      : html`<p class="muted small">Keine.</p>`}
    ${d.me.owner ? html`<details class="add"><summary>+ Teilvorgang</summary>
      <form data-submit="addSubcase" class="stack small">
        <select name="template_id" required aria-label="Vorlage des Teilvorgangs">${d.templates.map(t => html`<option value="${t.id}">${t.name}</option>`)}</select>
        <input name="title" placeholder="Titel des Teilvorgangs" required>
        <button>Anlegen</button>
      </form>
    </details>` : ''}`;
}

submit.addSubcase = async fd => {
  const { id } = await api(caseApi('/subcases'), { body: { template_id: fd.get('template_id'), title: fd.get('title') } });
  go(`#/case/${id}`);
};

// Rules in plain words, with an on/off switch per case.
const MONEY_FIELDS = ['claim.amount', 'claim.recognized', 'claim.cut', 'claim.settled', 'claim.open', 'case.payables_open', 'case.receivables_open'];

const stepTitle = (key, d) => d.tasks.find(t => t.key === key)?.title ?? key;
const ruleValue = (field, v, d) => MONEY_FIELDS.includes(field) ? eur(Number(v))
  : field === 'claim.direction' ? moneyWord(d, v)
  : field === 'document.type' ? docTypeLabel(v) || v
  : field === 'task.key' ? [v].flat().map(k => `„${stepTitle(k, d)}“`).join(', ')
  : field.endsWith('role') ? roleLabel(v) : Array.isArray(v) ? v.join(', ') : v;

const placeholders = text => String(text)
  .replace(/\{date(?:\+(\d+))?\}/g, (_, n) => (n ? `‹heute + ${n} Tage›` : '‹heute›'))
  .replace(/\{([\w.]+)\}/g, (_, k) => `‹${RULE_FIELD_LABELS[k] ?? k}›`);

const ruleAction = (a, d) => a.type === 'create_task' ? `Aufgabe „${placeholders(a.title)}“ für ${a.assign_to_role && a.assign_to_role !== 'owner' ? roleLabel(a.assign_to_role) : 'die Verantwortlichen'} anlegen`
  : a.type === 'create_subcase' ? `Teilvorgang „${placeholders(a.title)}“ aus der Vorlage „${a.template}“ anlegen`
  : a.type === 'complete_tasks' ? `offene Aufgaben ${a.key ? `„${stepTitle(a.key, d)}“` : a.task_type ? `vom Typ ${TYPES[a.task_type]}` : `„${a.title}“`} abhaken`
  : `Nachricht „${placeholders(a.text)}“ an ${(a.visible_to ?? ['*']).includes('*') ? 'alle' : (a.visible_to.length ? a.visible_to.map(roleLabel).join(', ') : 'das Team')}`;

function rulesSection(d) {
  const rules = d.definition.rules ?? [];
  if (!rules.length) return '';
  return html`<h3>Automatik</h3>
    <ul class="list small">${rules.map(r => {
      const runs = d.rule_runs.find(x => x.rule_id === r.id);
      return html`<li>
        <label class="row"><input type="checkbox" data-change="rule" data-id="${r.id}" ${r.enabled === false ? '' : 'checked'} ${d.me.owner ? '' : 'disabled'}> <b>${r.name}</b></label>
        <div class="muted">Wenn ${RULE_TRIGGER_LABELS[r.trigger] ?? r.trigger}${r.conditions.length ? ` und ${r.conditions.map(c => `${RULE_FIELD_LABELS[c.field] ?? c.field} ${RULE_OP_LABELS[c.operator]} ${ruleValue(c.field, c.value, d)}`).join(' und ')}` : ''}:
          ${r.actions.map(a => ruleAction(a, d)).join('; ')}.${runs?.n ? ` Bisher ${runs.n}× ausgeführt, zuletzt ${dateTime(runs.last)}.` : ''}</div>
        ${runs?.errors ? html`<div><span class="tag rejected">${runs.errors}× fehlgeschlagen</span> <span class="muted">${runs.error}</span></div>` : ''}
      </li>`;
    })}</ul>
    <p class="muted small">Regeln stehen in der Vorlage. Sie reagieren nicht auf das, was andere Regeln auslösen.</p>`;
}

change.rule = async el => { await api(caseApi(`/rules/${el.dataset.id}`), { method: 'PATCH', body: { enabled: el.checked } }); reload(); };

// Shape a case by hand, then keep its structure as a template (only workspace owners manage templates).
function saveTemplateForm(d) {
  if (me.workspaces.find(w => w.id === d.case.workspace_id)?.role !== 'owner') return '';
  return html`<details class="add"><summary>Als Vorlage speichern …</summary>
    <form data-submit="saveCaseTemplate" class="stack small">
      <p class="muted">Übernommen werden Rollen, Felder (ohne Inhalte), Dokumenttypen, Phasen, Aufgaben mit Reihenfolge,
        Fristen, Sichtbarkeit und Regeln. Keine Dokumente, Nachrichten, Personen und keine Anliegen.
        Bitte Aufgabentitel und Beschreibungen vorher auf persönliche Angaben prüfen – sie gehen in die Vorlage über.</p>
      ${d.case.template_id ? html`<label class="row"><input type="radio" name="target" value="version" checked>
        als neue Version von „${d.case.template_name}“</label>` : ''}
      <label class="row"><input type="radio" name="target" value="new" ${d.case.template_id ? '' : 'checked'}>
        als neue Vorlage: <input name="name" placeholder="Name der Vorlage"></label>
      <button>Speichern</button>
    </form>
  </details>`;
}

// To another workspace: only owners of both (it changes who oversees the case).
function moveForm(d) {
  const owned = me.workspaces.filter(w => w.role === 'owner');
  if (!owned.some(w => w.id === d.case.workspace_id) || owned.length < 2) return '';
  return html`<details class="add"><summary>In anderen Workspace verschieben …</summary>
    <form data-submit="moveCase" class="stack small">
      <p class="muted">Danach sehen die Owner des neuen Workspace den Vorgang, die des bisherigen nur noch, wenn sie beteiligt sind.
        Teilvorgänge wandern mit; Beteiligte, Dokumente und Verlauf bleiben. Logo und Farbe der Formulare kommen dann vom neuen Workspace.</p>
      <div class="row"><select name="workspace_id" aria-label="Ziel-Workspace">${owned.filter(w => w.id !== d.case.workspace_id)
        .map(w => html`<option value="${w.id}">${w.name}</option>`)}</select><button>Verschieben</button></div>
    </form>
  </details>`;
}

submit.moveCase = async fd => {
  const target = me.workspaces.find(w => w.id === fd.get('workspace_id'));
  if (!confirm(`Vorgang „${cur.case.title}“ in den Workspace „${target.name}“ verschieben?`)) return;
  const r = await api(caseApi('/move'), { body: { workspace_id: target.id } });
  alert(`Verschoben nach „${r.workspace}“${r.moved > 1 ? `, zusammen mit ${count(r.moved - 1, 'Teilvorgang', 'Teilvorgängen')}` : ''}.`
    + (r.missing_templates.length ? `\nDie Regeln des Vorgangs starten Teilvorgänge aus ${r.missing_templates.map(n => `„${n}“`).join(', ')} – diese Vorlage(n) bitte nach „${r.workspace}“ kopieren.` : ''));
  reload();
};

submit.saveCaseTemplate = async fd => {
  const asVersion = fd.get('target') === 'version';
  if (!asVersion && !fd.get('name')?.trim()) return alert('Bitte einen Namen für die neue Vorlage angeben.');
  const r = await api(caseApi('/template'), { body: asVersion ? { template_id: cur.case.template_id } : { name: fd.get('name') } });
  alert(`Gespeichert: „${r.name}“, Version ${r.version}. Laufende Vorgänge bleiben unverändert.`);
  reload();
};

function retentionText(d) {
  const days = d.case.retention_days;
  if (!days) return 'Keine Aufbewahrungsfrist: Der Vorgang bleibt, bis Sie ihn löschen.';
  if (d.case.status !== 'closed' || !d.case.closed_at) return `Aufbewahrung: wird ${days} Tage nach dem Abschluss automatisch gelöscht.`;
  return `Wird am ${date(new Date(Date.parse(d.case.closed_at) + days * 864e5).toISOString())} automatisch gelöscht (Aufbewahrungsfrist). Wieder öffnen hält ihn.`;
}

export const caseApi = path => `/cases/${cur.case.id}${path}`;

const rerender = () => page(cur.me.staff ? staffCase(cur) : guestCase(cur));

// On phones the three columns become tabs (CSS decides; on wide screens all columns show).
let caseTab = 'tasks';

on.caseTab = ({ tab }) => { caseTab = tab; rerender(); scrollTo(0, 0); };

on.revoke = async ({ id }) => { if (confirm('Zugang zu diesem Vorgang beenden?')) { await api(caseApi(`/participants/${id}`), { method: 'DELETE' }); reload(); } };

on.caseStatus = async ({ status }) => { await api(caseApi(''), { method: 'PATCH', body: { status } }); reload(); };

on.deleteCase = async () => {
  if (!confirm(`Vorgang „${cur.case.title}“ endgültig löschen?\n\nAlle Aufgaben, Dokumente, Nachrichten und Beträge werden entfernt. Das lässt sich nicht rückgängig machen.`)) return;
  await api(caseApi(''), { method: 'DELETE' });
  go('#/');
};

on.reinvite = async ({ email, role }) => {
  const { sent, link } = await api(caseApi('/invitations'), { body: { email, role } });
  if (link) prompt(sent ? 'E-Mail verschickt. Lokal zusätzlich der Link:' : 'E-Mail-Versand gerade nicht möglich. Bitte den Link selbst schicken:', link);
  else alert(`Neue Einladung an ${email} verschickt.`);
  reload();
};

on.copyText = async ({ text }, el) => { await navigator.clipboard.writeText(text); el.textContent = 'kopiert'; };

on.withdraw = async ({ email }) => {
  if (!confirm(`Einladung an ${email} zurückziehen?`)) return;
  await api(caseApi(`/invitations/${encodeURIComponent(email)}`), { method: 'DELETE' });
  reload();
};

on.sendLink = async ({ id, name }) => {
  const { link } = await api(caseApi(`/participants/${id}/login-link`), { body: {} });
  if (link) prompt(`Lokal: Anmeldelink für ${name}`, link);
  else alert(`Anmeldelink an ${name} verschickt.`);
};

on.inviteRole = ({ role }) => {
  const box = document.getElementById('invite');
  box.open = true;
  box.querySelector('select[name=role]').value = role;
  box.querySelector('input[name=email]').focus();
};

change.onlyMessages = el => { onlyMessages = el.checked; rerender(); };

change.pickInviteRole = el => {
  const box = document.getElementById('newrole');
  box.hidden = el.value !== '__new';
  box.querySelector('input').required = !box.hidden;
};

submit.comment = async fd => {
  const v = fd.get('visible_to');
  await api(caseApi('/comments'), { body: { body: fd.get('body'), visible_to: v ? [v] : [] } });
  reload();
};

submit.addPhase = async fd => { await api(caseApi('/phases'), { body: { title: fd.get('title') } }); reload(); };

submit.request = async fd => { await api(caseApi('/tasks'), { body: Object.fromEntries(fd) }); reload(); };

submit.invite = async fd => {
  const role = fd.get('role');
  const { sent, link } = await api(caseApi('/invitations'), { body: {
    email: fd.get('email'), access_until: fd.get('access_until'),
    ...(role === '__new' ? { new_role: { label: fd.get('new_label'), access: fd.get('new_access') } } : { role }),
  } });
  if (!link) alert(`Einladung an ${fd.get('email')} per E-Mail verschickt.`);
  else prompt(sent ? 'E-Mail verschickt. Lokal zusätzlich der Link:' : 'E-Mail-Versand gerade nicht möglich. Bitte den Link selbst schicken (wird nur jetzt angezeigt):', link);
  reload();
};
