-- Deleting a case removes everything in it. Only this tombstone remains: no title, no personal data.
CREATE TABLE case_deletions (
  case_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  template_name TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('manual', 'retention')),
  deleted_by TEXT,                    -- user id; NULL when the retention job deleted it
  deleted_at TEXT NOT NULL
);

-- When the case was closed; retention periods count from here.
ALTER TABLE cases ADD COLUMN closed_at TEXT;

-- Append-only / immutable stays true, except while a whole case is being deleted (its tombstone exists).
DROP TRIGGER events_no_delete;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  WHEN OLD.case_id NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

DROP TRIGGER financial_decisions_no_delete;
CREATE TRIGGER financial_decisions_no_delete BEFORE DELETE ON financial_decisions
  WHEN (SELECT case_id FROM financial_claims WHERE id = OLD.claim_id) NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;

DROP TRIGGER financial_transactions_no_delete;
CREATE TRIGGER financial_transactions_no_delete BEFORE DELETE ON financial_transactions
  WHEN (SELECT case_id FROM financial_claims WHERE id = OLD.claim_id) NOT IN (SELECT case_id FROM case_deletions)
  BEGIN SELECT RAISE(ABORT, 'transactions are immutable'); END;
