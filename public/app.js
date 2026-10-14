// NomoCase UI entry: hash router, live refresh, event delegation (data-on / data-submit / data-change).
import { change, input, me, on, set, stamp, submit } from './state.js';
import { api, esc, html, show } from './lib.js';
import { accountView, inviteView, loginLinkView, loginView, uploadLinkView, welcomeView } from './views/account.js';
import { dashboardView } from './views/dashboard.js';
import { peopleView, templatesView } from './views/admin.js';
import { caseView } from './views/case.js';

async function route() {
  const [, view, id] = location.hash.split('/');
  set({ stamp: null }); // set again by the views that refresh live
  try {
    if (view === 'invite') return await inviteView(id);
    if (view === 'login') return await loginLinkView(id);
    if (view === 'upload') return await uploadLinkView(id);
    set({ me: await api('/me') });
    if (!me.user) return loginView();
    if (view === 'case') return await caseView(id);
    if (view === 'templates') return await templatesView();
    if (view === 'account') return await accountView();
    if (view === 'people') return await peopleView();
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

async function poll() {
  const [, view, id] = location.hash.split('/');
  const seen = stamp;
  if (document.hidden || !seen || (view && view !== 'case')) return;
  const r = await api(`/changes${view === 'case' ? `?case=${id}` : ''}`).catch(() => null);
  if (!r || r.stamp === seen || stamp !== seen) return; // unchanged, or the page was re-rendered meanwhile
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

route();
