// Finance: claims, decisions and transactions (immutable, cents), money steps on tasks.
import { fail, isDate, uid } from './core.js';
import { caseCtx } from './access.js';

// Staff only. The overview is always computed from claims, decisions and transactions, never stored.

export const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

// Whole cents up to 100 Mio. €: far inside the safe integers, so sums stay exact (it takes ~900 000 maximal bookings to leave them).
const MAX_CENTS = 1e10;
const cents = v => (Number.isSafeInteger(v) && v >= 0 && v <= MAX_CENTS ? v : fail(400, 'Betrag ungültig (0 bis 100 000 000 €, in Cent)'));

export const eur = c => `${(c / 100).toFixed(2).replace('.', ',')} €`;

const dayOrToday = (rq, d) => (d ? (isDate(d) ? d : fail(400, 'Datum ungültig')) : rq.today);

export async function loadFinance(rq, caseIds) {
  const { batch, sql } = rq;
  const ids = JSON.stringify(caseIds);
  const [claims, decisions, txs] = (await batch([
    sql('SELECT * FROM financial_claims WHERE case_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid', ids),
    sql(`SELECT d.*, u.name AS author FROM financial_decisions d JOIN financial_claims c ON c.id = d.claim_id LEFT JOIN users u ON u.id = d.created_by
       WHERE c.case_id IN (SELECT value FROM json_each(?)) ORDER BY d.created_at, d.rowid`, ids),
    sql(`SELECT t.*, u.name AS author FROM financial_transactions t JOIN financial_claims c ON c.id = t.claim_id LEFT JOIN users u ON u.id = t.created_by
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

async function loadClaim(rq, user, claimId) {
  const c = (await rq.row('SELECT * FROM financial_claims WHERE id = ?', claimId)) ?? fail(404, 'Forderung nicht gefunden');
  const ctx = await caseCtx(rq, user, c.case_id);
  if (!ctx.staff) fail(404, 'Forderung nicht gefunden');
  return { ctx, c };
}

// Statement builders, shared by the finance panel and by tasks with a money step.
// `taskId`: the step that created the claim (money steps); claims added by hand have none.
function claimStmts(rq, ctx, user, { id = uid(), title, direction, amount, counterparty, taskId = null }) {
  return [
    rq.sql('INSERT INTO financial_claims (id, case_id, title, counterparty, direction, amount_cents, created_by, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, ctx.c.id, title, counterparty || null, direction, amount, user.id, rq.time, taskId),
    rq.event(ctx.c.id, user.id, 'claim.added', { claim: title, claim_id: id, direction, amount_cents: amount }, []),
  ];
}

// What follows from a decision (e.g. a review task for a cut) is up to the case's rules.
function decisionStmts(rq, ctx, user, c, approved, { day, note, taskId = null } = {}) {
  return [
    rq.sql('INSERT INTO financial_decisions (id, claim_id, approved_cents, decided_on, note, created_by, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      uid(), c.id, approved, dayOrToday(rq, day), String(note ?? '').trim() || null, user.id, rq.time, taskId),
    rq.event(ctx.c.id, user.id, 'decision.added', { claim: c.title, claim_id: c.id, approved_cents: approved, amount_cents: c.amount_cents }, []),
  ];
}

function transactionStmts(rq, ctx, user, c, amount, { day, note, taskId = null } = {}) {
  return [
    rq.sql('INSERT INTO financial_transactions (id, claim_id, amount_cents, booked_on, note, created_by, created_at, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      uid(), c.id, amount, dayOrToday(rq, day), String(note ?? '').trim() || null, user.id, rq.time, taskId),
    rq.event(ctx.c.id, user.id, 'transaction.booked', { claim: c.title, claim_id: c.id, direction: c.direction, amount_cents: amount }, []),
  ];
}

// A money step books once (unique task_id on claims, decisions and payments, so also for simultaneous requests).
export const BOOKED_ONCE = 'Für diese Aufgabe ist schon ein Betrag gebucht. Korrekturen bitte direkt bei der Forderung.';

// The money step of a template task, done together with the task. Staff only; no amount = no booking.
export async function moneyStmts(rq, ctx, user, t, amount) {
  const { row } = rq;
  const m = t.money;
  if (!m || !ctx.def.finance || !ctx.staff) return [];
  const booked = await row(`SELECT 1 FROM financial_claims WHERE task_id = ?1 UNION ALL SELECT 1 FROM financial_decisions WHERE task_id = ?1
    UNION ALL SELECT 1 FROM financial_transactions WHERE task_id = ?1 LIMIT 1`, t.id);
  if (booked) { // done again after reopening: fine without an amount, a second amount is refused
    if (amount == null || amount === '') return [];
    fail(409, BOOKED_ONCE);
  }
  if (amount == null || amount === '') {
    if (m.claim) fail(400, `Bitte den Betrag angeben – daraus entsteht die Forderung „${m.claim}“.`);
    return [];
  }
  const cts = cents(Number(amount));
  if (m.claim) {
    const counterparty = m.counterparty_field ? JSON.parse(ctx.c.fields)[m.counterparty_field] : m.counterparty;
    return claimStmts(rq, ctx, user, { title: m.claim, direction: m.direction, amount: cts, counterparty, taskId: t.id });
  }
  // A claim a money step created (task_id set, also when that step was deleted since): claim names are unique per
  // template, so the title tells which step's. Claims added by hand have no task_id and never catch a booking.
  const name = m.decision ?? m.payment;
  const c = (await row(`SELECT * FROM financial_claims WHERE case_id = ? AND task_id IS NOT NULL AND title = ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`, ctx.c.id, name))
    ?? fail(409, `Es gibt noch keine Forderung „${name}“ aus der Aufgabe davor. Bitte dort zuerst den Betrag eintragen – oder direkt bei der Forderung buchen.`);
  return m.decision ? decisionStmts(rq, ctx, user, c, cts, { taskId: t.id }) : transactionStmts(rq, ctx, user, c, cts || fail(400, 'Betrag muss größer als 0 sein'), { taskId: t.id });
}

export async function addClaim(rq) {
  const { user, params, body, batch } = rq;
  const ctx = await caseCtx(rq, user, params.id);
  if (!ctx.staff) fail(404, 'Vorgang nicht gefunden');
  const title = String(body.title ?? '').trim() || fail(400, 'Titel fehlt');
  if (!['payable', 'receivable'].includes(body.direction)) fail(400, 'Richtung ungültig');
  const id = uid();
  await batch(claimStmts(rq, ctx, user, { id, title, direction: body.direction, amount: cents(body.amount_cents), counterparty: String(body.counterparty ?? '').trim() }));
  return { id };
}

export async function addDecision(rq) {
  const { user, params, body, batch } = rq;
  const { ctx, c } = await loadClaim(rq, user, params.id);
  await batch(decisionStmts(rq, ctx, user, c, cents(body.approved_cents), { day: body.decided_on, note: body.note }));
}

export async function addTransaction(rq) {
  const { user, params, body, batch } = rq;
  const { ctx, c } = await loadClaim(rq, user, params.id);
  const amount = cents(body.amount_cents) || fail(400, 'Betrag muss größer als 0 sein');
  await batch(transactionStmts(rq, ctx, user, c, amount, { day: body.booked_on, note: body.note }));
}

// Corrections are counter-entries; the original booking stays visible.
export async function reverseTransaction(rq) {
  const { user, params, body, row, sql, batch, event, time, today } = rq;
  const t = (await row('SELECT * FROM financial_transactions WHERE id = ?', params.id)) ?? fail(404, 'Buchung nicht gefunden');
  const { ctx, c } = await loadClaim(rq, user, t.claim_id);
  if (t.reverses_id) fail(400, 'Ein Storno kann nicht storniert werden');
  if (await row('SELECT 1 FROM financial_transactions WHERE reverses_id = ?', t.id)) fail(409, 'Buchung ist bereits storniert');
  await batch([
    sql('INSERT INTO financial_transactions (id, claim_id, amount_cents, booked_on, note, reverses_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      uid(), c.id, -t.amount_cents, today, String(body.note ?? '').trim() || null, t.id, user.id, time),
    event(ctx.c.id, user.id, 'transaction.reversed', { claim: c.title, amount_cents: t.amount_cents }, []),
  ]);
}
