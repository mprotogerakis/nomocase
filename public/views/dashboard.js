// Dashboard as a worklist: what needs me first, what is stuck next, everything else findable (search, filters).
import { change, input, me, on, set, submit, templates } from '../state.js';
import { api, count, date, due, esc, eur, go, html, page, reload, today, TYPES } from '../lib.js';
import { bulkForm } from './bulk.js';

// Remembered per device (e.g. workspace "Hochschule" on the office machine); private mode just forgets.
const remembered = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { /* not remembered */ } };
let wsFilter = remembered('nomocase.ws', 'all');
let caseFilter = remembered('nomocase.filter', 'open');
let tplFilter = '';

const daysSince = ts => Math.floor((Date.now() - Date.parse(ts)) / 864e5);
// What a case needs: decides the dot, the filter and the order (urgent first).
const stateOf = (c, mine) => (c.status === 'closed' ? 'closed' : !c.open_tasks ? 'done'
  : c.next_due && c.next_due < today ? 'late' : mine ? 'mine' : 'wait');
const ORDER = ['late', 'mine', 'wait', 'done', 'closed'];
const FILTERS = [['open', 'Offen'], ['mine', 'Für mich'], ['late', 'Überfällig'], ['wait', 'Wartet auf andere'], ['done', 'Fertig'], ['closed', 'Abgeschlossen']];
const matches = (c, filter) => ({ open: c.kind !== 'closed', mine: c.mine > 0 && c.kind !== 'closed', late: c.kind === 'late',
  wait: c.kind === 'wait', done: c.kind === 'done', closed: c.kind === 'closed' })[filter];

// The dot says what the case needs from you; the words say it too (colour is never the only signal).
function caseState(c) {
  const phase = c.phase ? `${c.phase} · ` : '';
  const text = { closed: 'Abgeschlossen', done: 'Alle Aufgaben erledigt', late: `${phase}Frist überschritten`,
    mine: `${phase}${count(c.mine, 'Aufgabe', 'Aufgaben')} für Sie`, wait: `${phase}wartet auf andere` }[c.kind];
  return html`<span class="state ${c.kind}">${text}</span>`;
}

function waitingLine(c) {
  if (c.kind === 'closed' || !c.waiting_for.length) return '';
  const who = c.waiting_for.map(w => (w.names.length ? `${w.role} (${w.names.join(', ')})` : w.role)).join(', ');
  const idle = c.last_activity ? daysSince(c.last_activity) : 0;
  return html`<span class="small muted">wartet auf ${who}${idle >= 2 ? html` · <span class="${idle >= 14 ? 'warn' : ''}">seit ${idle} Tagen keine Aktivität</span>` : ''}</span>`;
}

const card = c => html`<li data-search="${[c.title, c.template, c.phase, ...c.waiting_for.flatMap(w => [w.role, ...w.names])].join(' ').toLowerCase()}"><a href="#/case/${c.id}">
  <b>${c.title}</b>${c.parent_title ? html`<span class="small muted">↳ Teil von „${c.parent_title}“</span>` : ''}
  ${caseState(c)}
  ${waitingLine(c)}
  ${c.next_due && c.kind !== 'closed' ? html`<span class="small ${c.next_due < today ? 'warn' : 'muted'}">Nächste Frist: ${date(c.next_due)}</span>` : ''}
  ${c.template ? html`<span class="small muted">${c.template}</span>` : ''}
  ${wsFilter !== 'all' && c.open_receivable_cents > 0 ? html`<span class="small muted">Offen zu erhalten: ${eur(c.open_receivable_cents)}</span>` : ''}
</a></li>`;

function newCaseForm(tpls) {
  if (!tpls.length) return '';
  return html`<details class="add"><summary>+ Neuer Vorgang</summary>
    <form data-submit="newCase" class="stack card">
      <select name="template_id" data-change="pickTemplate" required aria-label="Vorlage">
        <option value="">Vorlage wählen…</option>
        ${Object.entries(Object.groupBy(tpls, t => t.workspace)).map(([ws, ts]) => html`<optgroup label="${ws}">${ts.map(t => html`<option value="${t.id}">${t.name} (v${t.version})</option>`)}</optgroup>`)}
      </select>
      <input name="title" placeholder="Titel des Vorgangs" aria-label="Titel des Vorgangs" required>
      <div id="fields" class="stack"></div>
      <button>Vorgang anlegen</button>
    </form>
  </details>`;
}

export async function dashboardView() {
  const [d, tpls] = await Promise.all([api('/dashboard'), me.workspaces.length ? api('/templates') : []]);
  set({ templates: tpls.filter(t => !t.archived_at), stamp: d.stamp });
  if (wsFilter !== 'all' && !me.workspaces.some(w => w.id === wsFilter)) wsFilter = 'all';
  const inWs = d.cases.filter(c => wsFilter === 'all' || c.workspace_id === wsFilter);
  const caseIds = new Set(inWs.map(c => c.id));
  const myTasks = d.my_tasks.filter(t => caseIds.has(t.case_id));
  for (const c of inWs) {
    c.mine = myTasks.filter(t => t.case_id === c.id).length;
    c.kind = stateOf(c, c.mine);
  }
  const shownTemplates = [...new Set(inWs.map(c => c.template).filter(Boolean))].sort();
  if (!shownTemplates.includes(tplFilter)) tplFilter = '';
  const cases = inWs.filter(c => matches(c, caseFilter) && (!tplFilter || c.template === tplFilter))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.next_due ?? '9999').localeCompare(b.next_due ?? '9999')
      || (a.last_activity ?? '').localeCompare(b.last_activity ?? '')); // longest without activity first
  const overdue = myTasks.filter(t => t.due_date && t.due_date < today).length;
  const overdueOthers = inWs.reduce((n, c) => n + (c.status === 'closed' ? 0 : c.overdue_others), 0);
  // Money only inside one workspace, never on the mixed view (screen sharing, projector).
  const money = wsFilter === 'all' ? 0 : inWs.reduce((s, c) => s + (c.open_receivable_cents || 0), 0);
  const MY_TASKS_SHOWN = 8;
  const taskLine = t => html`<li><a href="#/case/${t.case_id}">${t.title}</a> <span class="muted small">${t.assess ? 'Bewertung' : TYPES[t.type]} · ${t.case_title}</span>${due(t.due_date)}</li>`;
  page(html`<main>
    <div class="row" style="justify-content:space-between; align-items:flex-start">
      ${me.workspaces.length > 1 ? html`<div class="seg">${[['all', 'Alle'], ...me.workspaces.map(w => [w.id, w.name])].map(([id, label]) =>
        html`<button class="${wsFilter === id ? 'on' : ''}" data-on="ws" data-id="${id}">${label}</button>`)}</div>` : html`<span></span>`}
      <div class="stack" style="align-items:flex-end; min-width:0; max-width:100%">${newCaseForm(tpls.filter(t => !t.archived_at))}${bulkForm(tpls.filter(t => !t.archived_at))}</div>
    </div>
    <section class="stats">
      <div class="${overdue ? 'warn' : ''}"><b>${String(overdue)}</b>überfällig bei Ihnen</div>
      ${overdueOthers ? html`<div class="warn link-tile" data-on="caseFilter" data-id="late" title="Vorgänge mit überschrittener Frist zeigen"><b>${String(overdueOthers)}</b>überfällig bei anderen</div>` : ''}
      <div><b>${String(myTasks.length)}</b>offene Aufgaben</div>
      <div><b>${String(inWs.filter(c => c.status !== 'closed').length)}</b>offene Vorgänge</div>
      ${money ? html`<div><b>${eur(money)}</b>offen zu erhalten</div>` : ''}
    </section>
    <h2>Meine Aufgaben</h2>
    ${myTasks.length ? html`<ul class="list">${myTasks.slice(0, MY_TASKS_SHOWN).map(taskLine)}</ul>
      ${myTasks.length > MY_TASKS_SHOWN ? html`<details><summary class="small">alle ${myTasks.length} anzeigen</summary>
        <ul class="list">${myTasks.slice(MY_TASKS_SHOWN).map(taskLine)}</ul></details>` : ''}`
      : html`<p class="muted">Gerade nichts zu tun.</p>`}
    <h2>Vorgänge</h2>
    <div class="row filters">
      <input type="search" placeholder="Suchen: Titel, Vorlage, Person …" data-input="caseSearch" aria-label="Vorgänge durchsuchen">
      <div class="seg">${FILTERS.map(([id, label]) => html`<button class="${caseFilter === id ? 'on' : ''}" data-on="caseFilter" data-id="${id}">${label}</button>`)}</div>
      ${shownTemplates.length > 1 ? html`<select data-change="tplFilter" aria-label="Vorlage"><option value="">alle Vorlagen</option>
        ${shownTemplates.map(t => html`<option value="${t}" ${t === tplFilter ? 'selected' : ''}>${t}</option>`)}</select>` : ''}
    </div>
    ${cases.length ? Object.entries(Object.groupBy(cases, c => c.workspace)).map(([ws, list]) => html`
      ${me.workspaces.length > 1 && wsFilter === 'all' ? html`<h3>${ws}</h3>` : ''}
      <ul class="cards">${list.map(card)}</ul>`)
      : html`<p class="muted">Keine Vorgänge für diesen Filter.</p>`}
    <p class="muted small" id="no-hits" hidden>Keine Treffer.</p>
  </main>`);
}

on.ws = ({ id }) => { wsFilter = id; remember('nomocase.ws', id); reload(); };
on.caseFilter = ({ id }) => { caseFilter = id; remember('nomocase.filter', id); reload(); };
change.tplFilter = el => { tplFilter = el.value; reload(); };
// Search filters the rendered cards in place: no re-render, so typing is never interrupted.
input.caseSearch = el => {
  const words = el.value.toLowerCase().split(/\s+/).filter(Boolean);
  let hits = 0;
  for (const li of document.querySelectorAll('.cards li[data-search]')) {
    li.hidden = !words.every(w => li.dataset.search.includes(w));
    hits += li.hidden ? 0 : 1;
  }
  document.getElementById('no-hits').hidden = hits > 0 || !words.length;
};

change.pickTemplate = el => {
  const t = templates.find(x => x.id === el.value);
  document.getElementById('fields').innerHTML = esc(html`${(t?.definition.fields ?? []).map(f => html`<label class="stack small">${f.label}<input name="f_${f.key}" type="${f.type === 'date' ? 'date' : 'text'}"></label>`)}`);
};

submit.newCase = async fd => {
  const fields = Object.fromEntries([...fd].filter(([k]) => k.startsWith('f_')).map(([k, v]) => [k.slice(2), v]));
  const { id } = await api('/cases', { body: { template_id: fd.get('template_id'), title: fd.get('title'), fields } });
  go(`#/case/${id}`);
};
