-- Finance module: claims (what is owed / requested), decisions (what was recognized), transactions (what was paid).
-- Amounts in euro cents. Decisions and transactions are immutable; corrections are new rows (new decision, reversal).

CREATE TABLE financial_claims (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  title TEXT NOT NULL,
  counterparty TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('payable', 'receivable')),  -- payable: I owe it; receivable: owed to me
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX financial_claims_case ON financial_claims(case_id);

-- The latest decision per claim is the current recognized amount.
CREATE TABLE financial_decisions (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES financial_claims(id),
  approved_cents INTEGER NOT NULL CHECK (approved_cents >= 0),
  decided_on TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX financial_decisions_claim ON financial_decisions(claim_id);

CREATE TABLE financial_transactions (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES financial_claims(id),
  amount_cents INTEGER NOT NULL,      -- negative only for reversals
  booked_on TEXT NOT NULL,
  note TEXT,
  reverses_id TEXT UNIQUE REFERENCES financial_transactions(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX financial_transactions_claim ON financial_transactions(claim_id);

CREATE TRIGGER financial_decisions_no_update BEFORE UPDATE ON financial_decisions BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER financial_decisions_no_delete BEFORE DELETE ON financial_decisions BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER financial_transactions_no_update BEFORE UPDATE ON financial_transactions BEGIN SELECT RAISE(ABORT, 'transactions are immutable'); END;
CREATE TRIGGER financial_transactions_no_delete BEFORE DELETE ON financial_transactions BEGIN SELECT RAISE(ABORT, 'transactions are immutable'); END;
