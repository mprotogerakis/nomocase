// Workspace administration: templates and people.
import { me, submit } from '../state.js';
import { ACCESS_LABELS, api, count, date, dateTime, html, page, reload } from '../lib.js';

// Admin overview (workspace owners): who has an account, how they log in, where they take part, open invitations.
export async function peopleView() {
  const { people, invitations, stats } = await api('/people');
  const seat = c => html`<a href="#/case/${c.case_id}">${c.title}</a> <span class="muted small">${[c.role, ACCESS_LABELS[c.access]].filter((x, i, a) => x && a.indexOf(x) === i).join(' · ')}${c.status === 'closed' ? ' · abgeschlossen' : ''}</span>
    ${c.active ? '' : html`<span class="tag">Zugang beendet</span>`}`;
  page(html`<main class="narrow"><h1>Personen</h1>
    <p class="muted">Alle, die in Ihren Workspaces mitarbeiten oder an deren Vorgängen beteiligt sind oder waren.</p>
    <section class="stats">
      <div><b>${String(people.length)}</b>Personen</div>
      <div><b>${String(invitations.length)}</b>offene Einladungen</div>
      <div><b>${String(stats.cases_open)}</b>offene Vorgänge</div>
      <div class="${stats.bulk_today >= stats.bulk_cap ? 'warn' : ''}"><b>${String(stats.mails_today)}</b>Mails heute (Sammelmails ${stats.bulk_today}/${stats.bulk_cap})</div>
    </section>
    ${people.map(u => html`<div class="card">
      <b>${u.name}</b> <span class="muted small">${u.email}${u.workspaces ? ` · Workspace ${u.workspaces}` : ''}</span>
      <div class="muted small">seit ${date(u.created_at)} ·
        ${u.passkeys ? `${u.passkeys} Passkey${u.passkeys > 1 ? 's' : ''}` : html`<span class="tag internal">kein Passkey</span>`} ·
        ${u.last_seen ? `zuletzt aktiv ${dateTime(u.last_seen)}` : 'noch nie aktiv'}
        ${u.email_reminders && u.email_progress ? '' : ` · Mails: ${[u.email_reminders && 'Übersicht', u.email_progress && 'Fortschritt'].filter(Boolean).join(', ') || 'keine'}`}</div>
      ${u.cases.length ? html`<ul class="list small">${u.cases.map(c => html`<li>${seat(c)}</li>`)}</ul>` : ''}
    </div>`)}
    ${invitations.length ? html`<h2>Offene Einladungen</h2><ul class="list">${invitations.map(i => html`<li>${i.email}
      <span class="muted small">als ${i.role ?? '–'} in</span> <a href="#/case/${i.case_id}">${i.title}</a>
      <span class="muted small">· eingeladen ${date(i.created_at)}, gültig bis ${date(i.expires_at)}</span></li>`)}</ul>` : ''}
  </main>`);
}

export async function templatesView() {
  const tpls = await api('/templates');
  const owned = me.workspaces.filter(w => w.role === 'owner');
  page(html`<main class="narrow"><h1>Prozessvorlagen</h1>
    <p class="muted">Speichern erzeugt eine neue Version. Laufende Vorgänge behalten ihre Kopie der Version, aus der sie entstanden sind.</p>
    ${tpls.map(t => html`<details class="card">
      <summary><b>${t.name}</b> <span class="muted small">${t.workspace} · v${t.version} · ${count(t.definition.phases.length, 'Phase', 'Phasen')} · ${count(t.definition.phases.flatMap(p => p.tasks).length, 'Aufgabe', 'Aufgaben')}</span></summary>
      <form data-submit="saveTemplate" data-id="${t.id}" class="stack">
        <textarea name="definition" rows="26" class="code" spellcheck="false">${JSON.stringify(t.definition, null, 2)}</textarea>
        <button>Als Version ${t.version + 1} speichern</button>
      </form>
    </details>`)}
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
  await api(`/templates/${form.dataset.id}/versions`, { body: { definition } });
  reload();
};

submit.newTemplate = async fd => {
  await api('/templates', { body: { workspace_id: fd.get('workspace_id'), name: fd.get('name'), definition: {
    roles: [{ key: 'owner', label: 'Verantwortlich', access: 'case_owner' }, { key: 'guest', label: 'Externe:r', access: 'guest_contributor' }],
    fields: [], document_types: [], phases: [{ title: 'Allgemein', tasks: [] }],
  } } });
  reload();
};
