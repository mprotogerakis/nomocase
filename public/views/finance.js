// Finance section of a case: claims, decisions, transactions.
import { on, submit } from '../state.js';
import { api, date, eur, html, plainEur, reload, toCents } from '../lib.js';
import { caseApi } from './case.js';

// Words for money in a case: neutral by default; a template can bring its own (finance.labels, e.g. "Erstattung").
const MONEY_WORDS = { payable: 'zu zahlen', receivable: 'zu erhalten', received: 'Erhalten', receivables_open: 'Offen zu erhalten',
  balance: 'Saldo bisher', add: 'Betrag erfassen' };
export const moneyWord = (d, key) => d.definition.finance?.labels?.[key] ?? MONEY_WORDS[key];

function claimStatus(c) {
  const parts = c.direction === 'payable'
    ? [`bezahlt ${eur(c.settled_cents)}`]
    : [c.recognized_cents == null ? 'Entscheidung offen' : `anerkannt ${eur(c.recognized_cents)}`, `erhalten ${eur(c.settled_cents)}`];
  if (c.cut_cents) parts.push(`gekürzt ${eur(c.cut_cents)}`);
  if (c.open_cents) parts.push(`offen ${eur(c.open_cents)}`);
  return parts.join(' · ');
}

function claimHistory(c) {
  const reversed = new Set(c.transactions.map(t => t.reverses_id).filter(Boolean));
  const entries = [
    ...c.decisions.map(x => ({ at: x.created_at, day: x.decided_on, note: x.note, text: `Entscheidung: ${eur(x.approved_cents)} anerkannt` })),
    ...c.transactions.map(x => ({
      at: x.created_at, day: x.booked_on, note: x.note,
      text: x.reverses_id ? `Storno ${eur(x.amount_cents)}` : `${c.direction === 'payable' ? 'Zahlung' : 'Eingang'} ${eur(x.amount_cents)}${reversed.has(x.id) ? ' (storniert)' : ''}`,
      reversible: !x.reverses_id && !reversed.has(x.id) ? x.id : null,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return entries.length ? html`<ul class="list small">${entries.map(e => html`<li>${date(e.day)} · ${e.text}${e.note ? html` <span class="muted">– ${e.note}</span>` : ''}
    ${e.reversible ? html` <button class="link" data-on="reverse" data-id="${e.reversible}">stornieren</button>` : ''}</li>`)}</ul>` : '';
}

export function financeSection(d) {
  const f = d.finance;
  if (!f || (!d.definition.finance && !f.claims.length)) return '';
  const t = f.totals;
  return html`<h3>Finanzen</h3>
    ${f.claims.map(c => html`<details class="claim">
      <summary><span class="row" style="justify-content:space-between"><span><b>${c.title}</b> <span class="muted small">${c.counterparty ?? ''} · ${moneyWord(d, c.direction)}</span></span><b>${eur(c.amount_cents)}</b></span>
        <div class="small ${c.cut_cents ? 'warn' : 'muted'}">${claimStatus(c)}</div></summary>
      ${claimHistory(c)}
      ${c.direction === 'receivable' ? html`<form data-submit="addDecision" data-id="${c.id}" class="row small">
        <input name="amount" placeholder="anerkannt €" inputmode="decimal" size="9" required value="${c.recognized_cents == null ? plainEur(c.amount_cents) : ''}">
        <input type="date" name="day"><input name="note" placeholder="Notiz, z. B. Bescheid vom …" size="14"><button>Entscheidung erfassen</button>
      </form>` : ''}
      <form data-submit="addTransaction" data-id="${c.id}" class="row small">
        <input name="amount" placeholder="Betrag €" inputmode="decimal" size="9" required value="${c.open_cents > 0 ? plainEur(c.open_cents) : ''}">
        <input type="date" name="day"><input name="note" placeholder="Notiz" size="14"><button>${c.direction === 'payable' ? 'Zahlung buchen' : 'Eingang buchen'}</button>
      </form>
    </details>`)}
    ${f.claims.length ? html`<dl class="totals small">
      <dt>Bezahlt</dt><dd>${eur(t.paid_cents)}</dd>
      <dt>${moneyWord(d, 'received')}</dt><dd>${eur(t.received_cents)} von ${eur(t.requested_cents)}</dd>
      ${t.cut_cents ? html`<dt>Gekürzt</dt><dd class="warn">${eur(t.cut_cents)}</dd>` : ''}
      <dt>${moneyWord(d, 'receivables_open')}</dt><dd>${eur(t.open_receivable_cents)}</dd>
      <dt><b>${moneyWord(d, 'balance')}</b></dt><dd><b>${eur(t.own_share_cents)}</b></dd>
    </dl>` : html`<p class="muted small">Noch keine Beträge erfasst.</p>`}
    <details class="add"><summary>+ ${moneyWord(d, 'add')}</summary>
      <form data-submit="addClaim" class="stack small">
        <div class="row">
          <select name="direction"><option value="payable">${moneyWord(d, 'payable')}</option><option value="receivable">${moneyWord(d, 'receivable')}</option></select>
          <input name="amount" placeholder="Betrag €" inputmode="decimal" size="9" required>
        </div>
        <div class="row"><input name="title" placeholder="Bezeichnung" required><input name="counterparty" placeholder="Gegenüber (optional)"></div>
        <button>Anlegen</button>
      </form>
    </details>`;
}

// Money input → cents, or an alert and null.
export const amountOf = fd => {
  const c = toCents(fd.get('amount'));
  if (!Number.isInteger(c) || c < 0) { alert('Bitte einen gültigen Betrag eingeben, z. B. 190,00'); return null; }
  return c;
};

submit.addClaim = async fd => {
  const amount_cents = amountOf(fd);
  if (amount_cents == null) return;
  await api(caseApi('/claims'), { body: { direction: fd.get('direction'), title: fd.get('title'), counterparty: fd.get('counterparty'), amount_cents } });
  reload();
};

submit.addDecision = async (fd, form) => {
  const approved_cents = amountOf(fd);
  if (approved_cents == null) return;
  await api(`/claims/${form.dataset.id}/decisions`, { body: { approved_cents, decided_on: fd.get('day'), note: fd.get('note') } });
  reload();
};

submit.addTransaction = async (fd, form) => {
  const amount_cents = amountOf(fd);
  if (amount_cents == null) return;
  await api(`/claims/${form.dataset.id}/transactions`, { body: { amount_cents, booked_on: fd.get('day'), note: fd.get('note') } });
  reload();
};

on.reverse = async ({ id }) => {
  const note = prompt('Buchung stornieren (Gegenbuchung). Grund:');
  if (note === null) return;
  await api(`/transactions/${id}/reverse`, { body: { note } });
  reload();
};
