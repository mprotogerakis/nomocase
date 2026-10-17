-- What happened to a workspace: name, members and roles, invitations, look, trusted issuers, templates, cases moved in
-- or out. Only added to (no updates); it goes with the workspace. No foreign keys: entries outlive deleted accounts.
CREATE TABLE workspace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  actor_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX workspace_events_ws ON workspace_events(workspace_id, id);
CREATE TRIGGER workspace_events_no_update BEFORE UPDATE ON workspace_events BEGIN SELECT RAISE(ABORT, 'the workspace log is append-only'); END;
