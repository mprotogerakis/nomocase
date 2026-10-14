// Workspace administration: templates and people.
import { input, me, on, submit } from '../state.js';
import { ACCESS_LABELS, api, count, date, dateTime, html, page, reload } from '../lib.js';

// Admin overview (workspace owners): who has an account, how they log in, where they take part, open invitations –
// with the actions an admin needs right there (login link, re-invite, withdraw, end access).
let peopleFilter = 'all';
const PEOPLE_FILTERS = [['all', 'Alle'], ['nopasskey', 'Ohne Passkey'], ['never', 'Nie aktiv'], ['former', 'Ehemalige']];
const peopleMatch = (u, f) => ({ all: true, nopasskey: !u.passkeys, never: !u.last_seen,
  former: !u.workspaces && !u.cases.some(c => c.active) })[f];

export async function peopleView() {
  const { people, invitations, stats } = await api('/people');
  const shown = people.filter(u => peopleMatch(u, peopleFilter));
  const expired = invitations.filter(i => i.expired).length;
  const seat = (u, c) => html`<a href="#/case/${c.case_id}">${c.title}</a> <span class="muted small">${[c.role, ACCESS_LABELS[c.access]].filter((x, i, a) => x && a.indexOf(x) === i).join(' · ')}${c.status === 'closed' ? ' · abgeschlossen' : ''}</span>
    ${c.active ? (u.id === me.user.id ? '' : html`<span class="small"><button class="link" data-on="peopleLink" data-case="${c.case_id}" data-user="${u.id}" data-name="${u.name}">Anmeldelink senden</button>
      · <button class="link" data-on="peopleRevoke" data-case="${c.case_id}" data-user="${u.id}" data-name="${u.name}" data-title="${c.title}">Zugang beenden</button></span>`)
      : html`<span class="tag">Zugang beendet</span>`}`;
  page(html`<main class="narrow"><h1>Personen</h1>
    <p class="muted">Alle, die in Ihren Workspaces mitarbeiten oder an deren Vorgängen beteiligt sind oder waren.</p>
    <section class="stats">
      <div><b>${String(people.length)}</b>Personen</div>
      <div class="${people.some(u => !u.passkeys) ? 'link-tile' : ''}" data-on="peopleFilter" data-id="nopasskey"><b>${String(people.filter(u => !u.passkeys).length)}</b>ohne Passkey</div>
      <div class="${expired ? 'warn' : ''}"><b>${String(invitations.length)}</b>offene Einladungen${expired ? `, ${expired} abgelaufen` : ''}</div>
      <div class="${stats.bulk_today >= stats.bulk_cap ? 'warn' : ''}"><b>${String(stats.mails_today)}</b>Mails heute</div>
    </section>
    ${stats.mails_failed ? html`<p class="warn small">Heute ${count(stats.mails_failed, 'Mail', 'Mails')} nicht verschickt. Letzter Fehler (${dateTime(stats.last_error_at)}): ${stats.last_error}</p>` : ''}
    <p class="muted small">Sammelmails (Tagesübersicht, Fortschritt) heute: ${stats.bulk_today} von ${stats.bulk_cap}.
      ${stats.bulk_today >= stats.bulk_cap ? 'Sie pausieren bis morgen; Einladungen und Anmeldelinks gehen weiter.' : 'Ist die Grenze erreicht, pausieren sie bis morgen; Einladungen und Anmeldelinks gehen weiter.'}</p>
    ${invitations.length ? html`<h2>Einladungen</h2><ul class="list">${invitations.map(i => html`<li>${i.email}
      <span class="muted small">als ${i.role ?? '–'} in</span> <a href="#/case/${i.case_id}">${i.title}</a>
      <span class="small ${i.expired ? 'warn' : 'muted'}">· ${i.expired ? `abgelaufen am ${date(i.expires_at)}` : `eingeladen ${date(i.created_at)}, gültig bis ${date(i.expires_at)}`}</span>
      <span class="small"><button class="link" data-on="peopleReinvite" data-case="${i.case_id}" data-email="${i.email}" data-role="${i.role_key}">erneut einladen</button>
        · <button class="link" data-on="peopleWithdraw" data-case="${i.case_id}" data-email="${i.email}">zurückziehen</button></span></li>`)}</ul>` : ''}
    <h2>Konten</h2>
    <div class="row filters">
      <input type="search" placeholder="Suchen: Name, E-Mail, Vorgang …" data-input="peopleSearch" aria-label="Personen durchsuchen">
      <div class="seg">${PEOPLE_FILTERS.map(([id, label]) => html`<button class="${peopleFilter === id ? 'on' : ''}" data-on="peopleFilter" data-id="${id}">${label}</button>`)}</div>
    </div>
    ${shown.map(u => html`<div class="card" data-search="${[u.name, u.email, ...u.cases.map(c => c.title)].join(' ').toLowerCase()}">
      <b>${u.name}</b> <span class="muted small">${u.email}${u.workspaces ? ` · Workspace ${u.workspaces}` : ''}</span>
      <div class="muted small">seit ${date(u.created_at)} ·
        ${u.passkeys ? `${u.passkeys} Passkey${u.passkeys > 1 ? 's' : ''}` : html`<span class="tag internal">kein Passkey</span>`} ·
        ${u.last_seen ? `zuletzt aktiv ${dateTime(u.last_seen)}` : 'noch nie aktiv'}
        ${u.email_reminders && u.email_progress ? '' : ` · Mails: ${[u.email_reminders && 'Übersicht', u.email_progress && 'Fortschritt'].filter(Boolean).join(', ') || 'keine'}`}</div>
      ${u.cases.length ? html`<ul class="list small">${u.cases.map(c => html`<li>${seat(u, c)}</li>`)}</ul>` : ''}
    </div>`)}
    ${shown.length ? '' : html`<p class="muted">Niemand für diesen Filter.</p>`}
  </main>`);
}

on.peopleFilter = ({ id }) => { peopleFilter = peopleFilter === id ? 'all' : id; reload(); };
input.peopleSearch = el => {
  const words = el.value.toLowerCase().split(/\s+/).filter(Boolean);
  for (const card of document.querySelectorAll('main .card[data-search]')) card.hidden = !words.every(w => card.dataset.search.includes(w));
};
on.peopleReinvite = async ({ case: caseId, email, role }) => {
  const { sent, link } = await api(`/cases/${caseId}/invitations`, { body: { email, role } });
  if (link) prompt(sent ? 'E-Mail verschickt. Lokal zusätzlich der Link:' : 'E-Mail-Versand gerade nicht möglich. Bitte den Link selbst schicken:', link);
  else alert(`Neue Einladung an ${email} verschickt.`);
  reload();
};
on.peopleWithdraw = async ({ case: caseId, email }) => {
  if (!confirm(`Einladung an ${email} zurückziehen?`)) return;
  await api(`/cases/${caseId}/invitations/${encodeURIComponent(email)}`, { method: 'DELETE' });
  reload();
};
on.peopleLink = async ({ case: caseId, user, name }) => {
  const { link } = await api(`/cases/${caseId}/participants/${user}/login-link`, { body: {} });
  if (link) prompt(`Lokal: Anmeldelink für ${name}`, link);
  else alert(`Anmeldelink an ${name} verschickt.`);
};
on.peopleRevoke = async ({ case: caseId, user, name, title }) => {
  if (!confirm(`Zugang von ${name} zu „${title}“ beenden?`)) return;
  await api(`/cases/${caseId}/participants/${user}`, { method: 'DELETE' });
  reload();
};

export async function templatesView() {
  const tpls = await api('/templates');
  const owned = me.workspaces.filter(w => w.role === 'owner');
  const usage = t => (t.cases ? `läuft in ${count(t.cases, 'Vorgang', 'Vorgängen')}${t.open_cases !== t.cases ? `, ${t.open_cases} offen` : ''}` : 'noch in keinem Vorgang');
  const card = t => html`<details class="card">
    <summary><b>${t.name}</b> <span class="muted small">${t.workspace} · v${t.version} · ${count(t.definition.phases.length, 'Phase', 'Phasen')} · ${count(t.definition.phases.flatMap(p => p.tasks).length, 'Aufgabe', 'Aufgaben')} · ${usage(t)}</span></summary>
    ${owned.some(w => w.id === t.workspace_id) ? html`<form data-submit="saveTemplate" data-id="${t.id}" class="stack">
      <textarea name="definition" rows="26" class="code" spellcheck="false">${JSON.stringify(t.definition, null, 2)}</textarea>
      <div class="row" style="justify-content:space-between"><button>Als Version ${t.version + 1} speichern</button>
        ${t.archived_at ? html`<button type="button" class="link" data-on="restoreTemplate" data-id="${t.id}">wiederherstellen</button>`
          : html`<button type="button" class="link danger" data-on="deleteTemplate" data-id="${t.id}" data-name="${t.name}" data-cases="${t.cases}">${t.cases ? 'archivieren' : 'löschen'}</button>`}</div>
    </form>` : html`<p class="muted small">Ändern können die Owner des Workspaces.</p>
      <textarea rows="16" class="code" readonly aria-label="Vorlage (nur lesen)">${JSON.stringify(t.definition, null, 2)}</textarea>`}
  </details>`;
  const archived = tpls.filter(t => t.archived_at);
  page(html`<main class="narrow"><h1>Prozessvorlagen</h1>
    <p class="muted">Speichern erzeugt eine neue Version. Laufende Vorgänge behalten ihre Kopie der Version, aus der sie entstanden sind.
      Vorlagen, die schon in Vorgängen laufen, werden archiviert statt gelöscht.</p>
    ${tpls.filter(t => !t.archived_at).map(card)}
    ${archived.length ? html`<h2>Archiv</h2><p class="muted small">Nicht mehr für neue Vorgänge; laufende Vorgänge sind nicht betroffen.</p>${archived.map(card)}` : ''}
    ${owned.length ? html`<h2>Neue Vorlage</h2>
      <form data-submit="newTemplate" class="row">
        <select name="workspace_id">${owned.map(w => html`<option value="${w.id}">${w.name}</option>`)}</select>
        <input name="name" placeholder="Name" required>
        <button>Anlegen</button>
      </form>` : ''}
  </main>`);
}

submit.saveTemplate = async (fd, form) => {
  let definition;
  try { definition = JSON.parse(fd.get('definition')); } catch (e) { return alert(`JSON ungültig: ${e.message}`); }
  const { version } = await api(`/templates/${form.dataset.id}/versions`, { body: { definition } });
  alert(`Gespeichert als Version ${version}. Laufende Vorgänge bleiben unverändert.`);
  reload();
};

on.deleteTemplate = async ({ id, name, cases }) => {
  const used = Number(cases);
  if (!confirm(used ? `„${name}“ läuft in ${count(used, 'Vorgang', 'Vorgängen')}. Archivieren? Für neue Vorgänge steht sie dann nicht mehr zur Wahl; die laufenden bleiben unverändert.`
    : `„${name}“ endgültig löschen?`)) return;
  await api(`/templates/${id}`, { method: 'DELETE' });
  reload();
};
on.restoreTemplate = async ({ id }) => { await api(`/templates/${id}/restore`, { body: {} }); reload(); };

submit.newTemplate = async fd => {
  await api('/templates', { body: { workspace_id: fd.get('workspace_id'), name: fd.get('name'), definition: {
    roles: [{ key: 'owner', label: 'Verantwortlich', access: 'case_owner' }, { key: 'guest', label: 'Externe:r', access: 'guest_contributor' }],
    fields: [], document_types: [], phases: [{ title: 'Allgemein', tasks: [] }],
  } } });
  reload();
};
