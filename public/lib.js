// UI basics: safe HTML templates, formatting, labels, the API client, navigation and the page frame.
import { me } from './state.js';

const app = document.getElementById('app');

// html`` escapes every interpolation unless it is itself html`` (or an array of those).
class Safe { constructor(s) { this.s = s; } }

export const esc = v => v instanceof Safe ? v.s
  : Array.isArray(v) ? v.map(esc).join('')
  : v == null || v === false ? ''
  : String(v).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export const html = (strings, ...vals) => new Safe(strings.reduce((out, s, i) => out + s + (i < vals.length ? esc(vals[i]) : ''), ''));

export const show = view => { app.innerHTML = esc(view); };

// Plain text with clickable http(s) links and mail addresses; long URLs show their file name.
const LINK = /(https?:\/\/[^\s<>"]*[^\s<>".,;:)])|([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;

// split() with two capture groups yields [text, url, mail, text, url, mail, …]; the unused group is undefined.
export const linkify = text => String(text ?? '').split(LINK).map((part, i) => {
  if (i % 3 === 1 && part) {
    try {
      const u = new URL(part);
      const name = decodeURIComponent(u.pathname.split('/').pop() || '');
      return html`<a href="${u.href}" target="_blank" rel="noopener noreferrer">${/\.\w{2,4}$/.test(name) ? name : u.hostname}</a>`;
    } catch {
      return part; // not a valid URL after all: plain text
    }
  }
  if (i % 3 === 2 && part) return html`<a href="mailto:${part}">${part}</a>`;
  return part ?? '';
});

export const TYPES = { task: 'Aufgabe', upload: 'Upload', review: 'Prüfung', approval: 'Genehmigung', signature: 'Unterschrift', submission: 'Einreichung', payment: 'Zahlung', reimbursement: 'Erstattung', decision: 'Entscheidung', information: 'Information', wait: 'Warten' };

// Access level of a role. "Team" sees the whole case; "Extern" only what is shared with its role.
export const ACCESS_LABELS = { case_owner: 'Verantwortlich', case_editor: 'Team', guest_contributor: 'Extern · mitwirkend', guest_viewer: 'Extern · nur lesen' };

export const CAN = { case_owner: 'sieht alles, steuert den Vorgang', case_editor: 'sieht alles, arbeitet mit', guest_contributor: 'kann hochladen und schreiben', guest_viewer: 'kann nur lesen' };

export const DECISION_LABELS = { review: ['In Ordnung', 'Beanstanden'], approval: ['Genehmigen', 'Ablehnen'], decision: ['Zustimmen', 'Ablehnen'] };

export const OUTCOME = { review: ['in Ordnung', 'beanstandet'], approval: ['genehmigt', 'abgelehnt'], decision: ['zugestimmt', 'abgelehnt'] };

export const VERDICT = { review: ['als in Ordnung bestätigt', 'beanstandet'], approval: ['genehmigt', 'abgelehnt'], decision: ['zugestimmt', 'abgelehnt'] };

export const today = new Date().toISOString().slice(0, 10);

export const eur = c => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

// Accepts "1.245,50", "1.245", "450,5", "450.50", "450 €"; returns integer cents or NaN.
export const toCents = s => {
  const t = String(s).replace(/[\s€]/g, '');
  const thousands = t.includes(',') || /^\d{1,3}(\.\d{3})+$/.test(t); // German: dots group thousands
  return Math.round(Number(thousands ? t.replace(/\./g, '').replace(',', '.') : t) * 100);
};

export const plainEur = c => (c / 100).toFixed(2).replace('.', ',');

export const date = d => (d ? new Date(d.length === 10 ? `${d}T00:00` : d).toLocaleDateString('de-DE') : '');

export const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export const dateTime = d => new Date(d).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

export const due = d => (d ? html` <span class="small ${d < today ? 'warn' : 'muted'}">· Frist ${date(d)}</span>` : '');

export const sha256 = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');

export const shortHash = h => `${h.slice(0, 8)}…${h.slice(-4)}`;

// `quiet`: errors are only thrown (with .status), not shown – for callers that collect them (e.g. bulk creation).
export async function api(path, { method, body, quiet = false } = {}) {
  const isForm = body instanceof FormData;
  // Uploads carry the file's SHA-256 as read here; storage verifies it, so the stored file provably is this one.
  if (isForm && body.get('file')?.size) body.set('sha256', await sha256(body.get('file')));
  const res = await fetch(`/api${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body && !isForm ? { 'content-type': 'application/json' } : {},
    body: isForm ? body : body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (!quiet) alert(data.error ?? `Fehler ${res.status}`);
    throw Object.assign(new Error(data.error ?? `Fehler ${res.status}`), { shown: !quiet, status: res.status });
  }
  return data;
}

export const go = hash => (location.hash === hash ? reload() : (location.hash = hash));

const header = () => html`<header>
  <a href="#/" class="logo">NomoCase</a>
  <nav>
    <a href="#/">Vorgänge</a>
    ${me.workspaces.length ? html`<a href="#/templates">Vorlagen</a>` : ''}
    ${me.workspaces.some(w => w.role === 'owner') ? html`<a href="#/people">Personen</a>` : ''}
    ${me.workspaces.length ? html`<a href="#/workspaces">Workspaces</a>` : ''}
    <a href="#/account">${me.user.name}</a>
    <button class="link" data-on="logout">${me.dev ? 'Benutzer wechseln' : 'Abmelden'}</button>
  </nav>
</header>
${me.passkeys ? '' : html`<div class="banner">
  Richten Sie einen Passkey ein, damit Sie sich später wieder anmelden können.
  <button data-on="passkeyAdd">Passkey einrichten</button>
</div>`}`;

export const page = (...parts) => show(html`${header()}${parts}`);

// Re-runs the router for the current hash (app.js listens to hashchange).
export const reload = () => dispatchEvent(new HashChangeEvent('hashchange'));

// What became of a mail with a link (invitation, login link): handed over, or queued – the server delivers it as soon as
// the mail provider takes it. Locally the link comes back too, for testing.
export function mailNotice({ sent, link }, what) {
  if (link) prompt(`${sent ? 'E-Mail verschickt' : 'E-Mail noch nicht zugestellt'}. Lokal zusätzlich der Link:`, link);
  else alert(sent ? `${what} per E-Mail verschickt.` : `${what} ist angelegt. Die E-Mail wird automatisch zugestellt, sobald der Mail-Anbieter wieder erreichbar ist.`);
}
