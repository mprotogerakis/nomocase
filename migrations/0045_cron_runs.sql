-- The last run of each cron schedule: when, and which steps failed (step names only: the details are in the Worker's
-- log, error texts may name people). The operator sees it on the people page – a failing or missing run is noticed.
CREATE TABLE cron_runs (
  cron TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL,
  failed TEXT NOT NULL DEFAULT '[]'
);
