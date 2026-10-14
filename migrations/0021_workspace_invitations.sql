-- Invitations into a workspace (as owner or member), accepted on the same link page as case invitations.
-- Rows are never deleted: withdrawn or replaced ones get revoked_at, so the daily cap per address counts every mail.
CREATE TABLE workspace_invitations (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT
);
CREATE INDEX workspace_invitations_ws ON workspace_invitations(workspace_id);
