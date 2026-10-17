-- A money step books once: decisions and payments remember their step too, and each step has at most one claim,
-- decision or payment (a repeated request, or a step done again after reopening, must not book twice; corrections
-- go to the claim). The unique indexes make that hold for simultaneous requests as well.
ALTER TABLE financial_decisions ADD COLUMN task_id TEXT;
ALTER TABLE financial_transactions ADD COLUMN task_id TEXT;
-- claims a step made twice before this (done, reopened, done again): the first stays the step's, later ones
-- become claims of their own (no step), as if added by hand
UPDATE financial_claims SET task_id = NULL WHERE task_id IS NOT NULL
  AND rowid > (SELECT MIN(o.rowid) FROM financial_claims o WHERE o.task_id = financial_claims.task_id);
CREATE UNIQUE INDEX financial_claims_task ON financial_claims(task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX financial_decisions_task ON financial_decisions(task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX financial_transactions_task ON financial_transactions(task_id) WHERE task_id IS NOT NULL;
