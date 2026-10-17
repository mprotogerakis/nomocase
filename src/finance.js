// Finance: claims, decisions and transactions (immutable, cents), money steps on tasks.
import { DB, ev, fail, isDate, now, q, row, uid } from './core.js';
import { caseCtx } from './access.js';
import { loadTask } from './tasks.js';

// Staff only. The overview is always computed from claims, decisions and transactions, never stored.

export const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

// Whole cents up to 100 Mio. €: far inside the safe integers, so sums stay exact (it takes ~900 000 maximal bookings to leave them).
const MAX_CENTS = 1e10;
const cents = v => (Number.isSafeInteger(v) && v >= 0 && v <= MAX_CENTS ? v : fail(400, 'Betrag ungültig (0 bis 100 000 000 €, in Cent)'));

export const eur = c => `${(c / 100).toFixed(2).replace('.', ',')} €`;

const dayOrToday = d => (d ? (isDate(d) ? d : fail(400, 'Datum ungültig')) : now().slice(0, 10));

export async function loadFinance(caseIds) {
  const ids = JSON.stringify(caseIds);
  const [claims, decisions, txs] = (await DB.batch([
    q('SELECT * FROM financial_claims WHERE case_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid', ids),
    q(`SELECT d.*, u.name AS author FROM financial_decisions d JOIN financial_claims c ON c.id = d.claim_id LEFT JOIN users u ON u.id = d.created_by
       WHERE c.case_id IN (SELECT value FROM json_each(?)) ORDER BY d.created_at, d.rowid`, ids),
    q(`SELECT t.*, u.name AS author FROM financial_transactions t JOIN financial_claims c ON c.id = t.claim_id LEFT JOIN users u ON u.id = t.created_by
       WHERE c.case_id IN (SELECT value FROM json_each(?)) ORDER BY t.created_at, t.rowid`, ids),
  ])).map(r => r.results);
  return claims.map(c => {
    const ds = decisions.filter(d => d.claim_id === c.id);
    const ts = txs.filter(t => t.claim_id === c.id);
    const recognized = ds.at(-1)?.approved_cents ?? null; // latest decision wins
    const settled = sum(ts, t => t.amount_cents);
    return {
      ...c, decisions: ds, transactions: ts,
      recognized_cents: recognized,
      settled_cents: settled, // paid (payable) or received (receivable)
      cut_cents: recognized == null ? 0 : Math.max(c.amount_cents - recognized, 0),
      open_cents: (recognized ?? c.amount_cents) - settled,
    };
  });
}

export function financeSummary(claims) {
  const pay = claims.filter(c => c.direction === 'payable');
  const rec = claims.filter(c => c.direction === 'receivable');
  return {
    claims,
    totals: {
      paid_cents: sum(pay, c => c.settled_cents),
      open_payable_cents: sum(pay, c => c.open_cents),
      requested_cents: sum(rec, c => c.amount_cents),
      received_cents: sum(rec, c => c.settled_cents),
      cut_cents: sum(rec, c => c.cut_cents),
      open_receivable_cents: sum(rec, c => c.open_cents),
      own_share_cents: sum(pay, c => c.settled_cents) - sum(rec, c => c.settled_cents),
    },
  };
}

async function loadClaim(user, claimId) {
  const c = (await row('SELECT * FROM financial_claims WHERE id = ?', claimId)) ?? fail(404, 'Forderung nicht gefunden');
  const ctx = await caseCtx(user, c.case_id);
  if (!ctx.staff) fail(404, 'Forderung nicht gefunden');
  return { ctx, c };
}

// Statement builders, shared by the finance panel and by tasks with a money step.
function claimStmts(ctx, user, { id = uid(), title, direction, amount, counterparty }) {
  return [
    q('INSERT INTO financial_claims (id, case_id, title, counterparty, direction, amount_cents, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, ctx.c.id, title, counterparty || null, direction, amount, user.id, now()),
    ev(ctx.c.id, user.id, 'claim.added', { claim: title, claim_id: id, direction, amount_cents: amount }, []),
  ];
}

// What follows from a decision (e.g. a review task for a cut) is up to the case's rules.
function decisionStmts(ctx, user, c, approved, { day, note } = {}) {
  return [
    q('INSERT INTO financial_decisions (id, claim_id, approved_cents, decided_on, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      uid(), c.id, approved, dayOrToday(day), String(note ?? '').trim() || null, user.id, now()),
    ev(ctx.c.id, user.id, 'decision.added', { claim: c.title, claim_id: c.id, approved_cents: approved, amount_cents: c.amount_cents }, []),
  ];
}

function transactionStmts(ctx, user, c, amount, { day, note } = {}) {
  return [
    q('INSERT INTO financial_transactions (id, claim_id, amount_cents, booked_on, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      uid(), c.id, amount, dayOrToday(day), String(note ?? '').trim() || null, user.id, now()),
    ev(ctx.c.id, user.id, 'transaction.booked', { claim: c.title, claim_id: c.id, direction: c.direction, amount_cents: amount }, []),
  ];
}

// The money step of a template task, done together with the task. Staff only; no amount = no booking.
export async function moneyStmts(ctx, user, t, amount) {
  const m = t.money;
  if (!m || !ctx.def.finance || !ctx.staff) return [];
  if (amount == null || amount === '') {
    if (m.claim) fail(400, `Bitte den Betrag angeben – daraus entsteht die Forderung „${m.claim}“.`);
    return [];
  }
  const cts = cents(Number(amount));
  if (m.claim) {
    const counterparty = m.counterparty_field ? JSON.parse(ctx.c.fields)[m.counterparty_field] : m.counterparty;
    return claimStmts(ctx, user, { title: m.claim, direction: m.direction, amount: cts, counterparty });
  }
  const name = m.decision ?? m.payment;
  const c = (await row('SELECT * FROM financial_claims WHERE case_id = ? AND title = ? ORDER BY created_at DESC LIMIT 1', ctx.c.id, name))
    ?? fail(409, `Es gibt noch keine Forderung „${name}“. Bitte zuerst die vorherige Aufgabe mit Betrag erledigen.`);
  return m.decision ? decisionStmts(ctx, user, c, cts) : transactionStmts(ctx, user, c, cts || fail(400, 'Betrag muss größer als 0 sein'));
}

// Book the money step of a task afterwards (e.g. the task was done before the amount was known).
export async function taskMoney({ user, params, body }) {
  const { ctx, t } = await loadTask(user, params.id);
  if (!ctx.staff) fail(403, 'Nur das Team bucht Beträge');
  if (!t.money || !ctx.def.finance) fail(400, 'Diese Aufgabe hat keinen Geldschritt');
  if (body.amount_cents == null) fail(400, 'Betrag fehlt');
  await DB.batch(await moneyStmts(ctx, user, t, body.amount_cents));
}

export async function addClaim({ user, params, body }) {
  const ctx = await caseCtx(user, params.id);
  if (!ctx.staff) fail(404, 'Vorgang nicht gefunden');
  const title = String(body.title ?? '').trim() || fail(400, 'Titel fehlt');
  if (!['payable', 'receivable'].includes(body.direction)) fail(400, 'Richtung ungültig');
  const id = uid();
  await DB.batch(claimStmts(ctx, user, { id, title, direction: body.direction, amount: cents(body.amount_cents), counterparty: String(body.counterparty ?? '').trim() }));
  return { id };
}

export async function addDecision({ user, params, body }) {
  const { ctx, c } = await loadClaim(user, params.id);
  await DB.batch(decisionStmts(ctx, user, c, cents(body.approved_cents), { day: body.decided_on, note: body.note }));
}

export async function addTransaction({ user, params, body }) {
  const { ctx, c } = await loadClaim(user, params.id);
  const amount = cents(body.amount_cents) || fail(400, 'Betrag muss größer als 0 sein');
  await DB.batch(transactionStmts(ctx, user, c, amount, { day: body.booked_on, note: body.note }));
}

// Corrections are counter-entries; the original booking stays visible.
export async function reverseTransaction({ user, params, body }) {
  const t = (await row('SELECT * FROM financial_transactions WHERE id = ?', params.id)) ?? fail(404, 'Buchung nicht gefunden');
  const { ctx, c } = await loadClaim(user, t.claim_id);
  if (t.reverses_id) fail(400, 'Ein Storno kann nicht storniert werden');
  if (await row('SELECT 1 FROM financial_transactions WHERE reverses_id = ?', t.id)) fail(409, 'Buchung ist bereits storniert');
  await DB.batch([
    q('INSERT INTO financial_transactions (id, claim_id, amount_cents, booked_on, note, reverses_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      uid(), c.id, -t.amount_cents, now().slice(0, 10), String(body.note ?? '').trim() || null, t.id, user.id, now()),
    ev(ctx.c.id, user.id, 'transaction.reversed', { claim: c.title, amount_cents: t.amount_cents }, []),
  ]);
}
