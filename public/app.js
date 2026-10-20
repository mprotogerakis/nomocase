// NomoCase UI entry: hash router, live refresh, event delegation (data-on / data-submit / data-change).
import { change, input, me, on, set, stamp, submit } from './state.js';
import { api, esc, html, renderedOn, sessionEnded, show, today } from './lib.js';
import { accountView, consentView, inviteView, loginLinkView, loginView, uploadLinkView, welcomeView } from './views/account.js';
import { dashboardView } from './views/dashboard.js';
import { peopleView, templatesView } from './views/admin.js';
import { workspacesView } from './views/workspaces.js';
import { templateEditorView } from './views/template-editor.js';
import { caseView } from './views/case.js';

async function route() {
  const [, view, id] = location.hash.split('/');
  set({ stamp: null }); // set again by the views that refresh live
  try {
    if (view === 'invite') return await inviteView(id);
    if (view === 'login') return await loginLinkView(id);
    if (view === 'upload') return await uploadLinkView(id);
    set({ me: await api('/me') });
    if (newVersion(me.version)) return;
    if (!me.user) return loginView();
    if (!me.consent.accepted) return consentView();
    if (view === 'case') return await caseView(id);
    if (view === 'templates') return id ? await templateEditorView(id) : await templatesView();
    if (view === 'account') return await accountView();
    if (view === 'people') return await peopleView();
    if (view === 'workspaces') return await workspacesView();
    if (view === 'welcome') return welcomeView(id ? `#/case/${id}` : '#/');
    return await dashboardView();
  } catch (e) {
    if (!e.shown) console.error(e); // API errors were shown by api() already
    show(html`<main class="narrow"><p>${e.message}</p><a href="#/">Zur Übersicht</a></main>`);
  }
}

// Live updates: while the page is visible, ask every 15 s whether the shown case or the overview changed and refresh.
// While someone is typing or has a menu open, only a hint appears, so nothing gets lost.
// ponytail: polling (one indexed lookup per call); a Durable Object with WebSockets if many people work at once.
const busy = () => document.querySelector('#app details[open]') || document.activeElement?.matches('#app textarea, #app input, #app select')
  || [...document.querySelectorAll('#app textarea, #app input:not([type=checkbox]):not([type=radio])')].some(x => x.value !== x.defaultValue);

async function refresh() {
  const y = scrollY;
  await route();
  scrollTo(0, y);
}

// A tab can stay open for days, but live refresh only reloads data: after a deployment it would keep running old code.
// So every poll also compares the deployed version with the one this tab started with, and reloads (or asks, while busy).
let startedWith = null;
function newVersion(version) {
  if (!version || version === 'dev') return false;
  startedWith ??= version;
  if (version === startedWith) return false;
  if (!busy()) location.reload();
  else if (!document.querySelector('.banner.update')) {
    document.querySelector('#app header')?.insertAdjacentHTML('afterend', esc(html`<div class="banner fresh update">Es gibt eine neue Version von NomoCase. <button data-on="reloadPage">Neu laden</button></div>`));
  }
  return true;
}

async function poll() {
  const [, view, id] = location.hash.split('/');
  const seen = stamp;
  if (document.hidden || sessionEnded()) return;
  // past midnight with no new data: deadlines turn overdue all the same – drawn anew (not while someone is typing)
  if (renderedOn !== today() && !busy()) return refresh();
  if (!seen || (view && view !== 'case')) { // pages without live refresh: only the version
    newVersion((await api('/version').catch(() => null))?.version);
    return;
  }
  const r = await api(`/changes${view === 'case' ? `?case=${id}` : ''}`).catch(() => null);
  if (!r || newVersion(r.version) || r.stamp === seen || stamp !== seen) return; // unchanged, or the page was re-rendered meanwhile
  if (!busy()) return refresh();
  if (!document.querySelector('.banner.fresh')) {
    document.querySelector('#app header')?.insertAdjacentHTML('afterend', esc(html`<div class="banner fresh">Es gibt Neuigkeiten. <button data-on="refresh">Aktualisieren</button></div>`));
  }
}

setInterval(poll, 15000);

document.addEventListener('visibilitychange', poll);

// Handlers are mostly async. An API error was already shown by api(); anything else is a bug: log it and say so,
// instead of a click that silently does nothing.
const run = (fn, ...args) => Promise.resolve().then(() => fn(...args)).catch(e => {
  if (e?.shown) return;
  console.error(e);
  alert('Da ist etwas schiefgegangen. Bitte laden Sie die Seite neu.');
});

document.addEventListener('click', e => {
  const el = e.target.closest('[data-on]');
  if (el) run(on[el.dataset.on], el.dataset, el);
});

document.addEventListener('submit', e => {
  const form = e.target.closest('form[data-submit]');
  if (!form) return;
  e.preventDefault();
  run(submit[form.dataset.submit], new FormData(form), form);
});

document.addEventListener('change', e => {
  const el = e.target.closest('[data-change]');
  if (el) run(change[el.dataset.change], el);
});

document.addEventListener('input', e => {
  const el = e.target.closest('[data-input]');
  if (el) run(input[el.dataset.input], el);
});

addEventListener('hashchange', route);

on.refresh = refresh; // hint banner of the live updates
on.reloadPage = () => location.reload();

route();
