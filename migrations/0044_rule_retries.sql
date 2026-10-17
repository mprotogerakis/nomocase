-- A rule run that failed is tried again: status 'retry' with its attempts and when it is due; after the last attempt it
-- stays 'error', shown at the case's rules. (Rebuilt, because SQLite cannot change a CHECK.)
CREATE TABLE automation_runs_new (
  event_id INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'retry', 'error')),
  detail TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, rule_id)
);
INSERT INTO automation_runs_new (event_id, rule_id, case_id, status, detail, created_at)
  SELECT event_id, rule_id, case_id, status, detail, created_at FROM automation_runs;
DROP TABLE automation_runs;
ALTER TABLE automation_runs_new RENAME TO automation_runs;
CREATE INDEX automation_runs_case ON automation_runs(case_id);
CREATE INDEX automation_runs_due ON automation_runs(status, next_attempt_at);
