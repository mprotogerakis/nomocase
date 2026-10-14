// Dashboard: cases per workspace, own tasks, new case.
import { change, me, on, set, submit, templates } from '../state.js';
import { api, date, due, esc, eur, go, html, page, reload, today, TYPES } from '../lib.js';

// The dot says what the case needs from you; the words say it too (colour is never the only signal).
function caseState(c, myTasks) {
  const mine = myTasks.filter(t => t.case_id === c.id).length;
  const phase = c.phase ? `${c.phase} · ` : '';
  const [kind, text] = c.status === 'closed' ? ['closed', 'Abgeschlossen']
    : !c.open_tasks ? ['done', 'Alle Aufgaben erledigt']
    : c.next_due && c.next_due < today ? ['late', `${phase}Frist überschritten`]
    : mine ? ['mine', `${phase}${mine} ${mine === 1 ? 'Aufgabe' : 'Aufgaben'} für Sie`]
    : ['wait', `${phase}wartet auf andere`];
  return html`<span class="state ${kind}">${text}</span>`;
}

// Which workspace the dashboard shows; remembered per device (e.g. "Hochschule" on the office machine).
let wsFilter = (() => { try { return localStorage.getItem('nomocase.ws') || 'all'; } catch { return 'all'; } })();

on.ws = ({ id }) => {
  wsFilter = id;
  try { localStorage.setItem('nomocase.ws', id); } catch { /* private mode: not remembered */ }
  reload();
};

export async function dashboardView() {
  const [d, tpls] = await Promise.all([api('/dashboard'), me.workspaces.length ? api('/templates') : []]);
  set({ templates: tpls, stamp: d.stamp });
  if (wsFilter !== 'all' && !me.workspaces.some(w => w.id === wsFilter)) wsFilter = 'all';
  const cases = d.cases.filter(c => wsFilter === 'all' || c.workspace_id === wsFilter);
  const caseIds = new Set(cases.map(c => c.id));
  const myTasks = d.my_tasks.filter(t => caseIds.has(t.case_id));
  const overdue = myTasks.filter(t => t.due_date && t.due_date < today).length;
  // Money only inside one workspace, never on the mixed view (screen sharing, projector).
  const money = wsFilter === 'all' ? 0 : cases.reduce((s, c) => s + (c.open_receivable_cents || 0), 0);
  page(html`<main>
    ${me.workspaces.length > 1 ? html`<div class="seg">${[['all', 'Alle'], ...me.workspaces.map(w => [w.id, w.name])].map(([id, label]) =>
      html`<button class="${wsFilter === id ? 'on' : ''}" data-on="ws" data-id="${id}">${label}</button>`)}</div>` : ''}
    <section class="stats">
      <div class="${overdue ? 'warn' : ''}"><b>${String(overdue)}</b>überfällig</div>
      <div><b>${String(myTasks.length)}</b>offene Aufgaben</div>
      <div><b>${String(cases.length)}</b>Vorgänge</div>
      ${money ? html`<div><b>${eur(money)}</b>offen zu erhalten</div>` : ''}
    </section>
    <h2>Meine Aufgaben</h2>
    ${myTasks.length
      ? html`<ul class="list">${myTasks.map(t => html`<li><a href="#/case/${t.case_id}">${t.title}</a> <span class="muted small">${t.assess ? 'Bewertung' : TYPES[t.type]} · ${t.case_title}</span>${due(t.due_date)}</li>`)}</ul>`
      : html`<p class="muted">Gerade nichts zu tun.</p>`}
    ${Object.entries(Object.groupBy(cases, c => c.workspace)).map(([ws, cases]) => html`
      <h2>${me.workspaces.length ? ws : 'Meine Vorgänge'}</h2>
      <ul class="cards">${cases.map(c => html`<li><a href="#/case/${c.id}">
        <b>${c.title}</b>${c.parent_title ? html`<span class="small muted">↳ Teil von „${c.parent_title}“</span>` : ''}
        ${caseState(c, myTasks)}
        ${c.next_due ? html`<span class="small ${c.next_due < today ? 'warn' : 'muted'}">Nächste Frist: ${date(c.next_due)}</span>` : ''}
        ${wsFilter !== 'all' && c.open_receivable_cents > 0 ? html`<span class="small muted">Offen zu erhalten: ${eur(c.open_receivable_cents)}</span>` : ''}
      </a></li>`)}</ul>`)}
    ${tpls.length ? html`<h2>Neuer Vorgang</h2>
      <form data-submit="newCase" class="stack card">
        <select name="template_id" data-change="pickTemplate" required>
          <option value="">Vorlage wählen…</option>
          ${Object.entries(Object.groupBy(tpls, t => t.workspace)).map(([ws, ts]) => html`<optgroup label="${ws}">${ts.map(t => html`<option value="${t.id}">${t.name} (v${t.version})</option>`)}</optgroup>`)}
        </select>
        <input name="title" placeholder="Titel des Vorgangs" required>
        <div id="fields" class="stack"></div>
        <button>Vorgang anlegen</button>
      </form>` : ''}
  </main>`);
}

change.pickTemplate = el => {
  const t = templates.find(x => x.id === el.value);
  document.getElementById('fields').innerHTML = esc(html`${(t?.definition.fields ?? []).map(f => html`<label class="stack small">${f.label}<input name="f_${f.key}" type="${f.type === 'date' ? 'date' : 'text'}"></label>`)}`);
};

submit.newCase = async fd => {
  const fields = Object.fromEntries([...fd].filter(([k]) => k.startsWith('f_')).map(([k, v]) => [k.slice(2), v]));
  const { id } = await api('/cases', { body: { template_id: fd.get('template_id'), title: fd.get('title'), fields } });
  go(`#/case/${id}`);
};
