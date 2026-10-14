-- NomoCase prototype schema (D1 / SQLite). Timestamps are ISO-8601 strings, JSON lives in TEXT columns.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL
);

CREATE TABLE template_versions (
  template_id TEXT NOT NULL REFERENCES templates(id),
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (template_id, version)
);

CREATE TABLE cases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  template_id TEXT REFERENCES templates(id),
  template_version INTEGER,
  title TEXT NOT NULL,
  definition TEXT NOT NULL,           -- copy of roles/fields/document_types; phases+tasks are materialized as rows
  fields TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL
);

CREATE TABLE case_participants (
  case_id TEXT NOT NULL REFERENCES cases(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  access TEXT NOT NULL CHECK (access IN ('case_owner', 'case_editor', 'guest_contributor', 'guest_reviewer', 'guest_viewer')),
  role TEXT NOT NULL,                 -- process role key from the case definition, e.g. 'student'
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (case_id, user_id)
);
CREATE INDEX case_participants_user ON case_participants(user_id);

CREATE TABLE phases (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  title TEXT NOT NULL,
  position INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  phase_id TEXT REFERENCES phases(id),
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  role TEXT,                          -- assignee process role
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'skipped')),
  outcome TEXT CHECK (outcome IN ('approved', 'rejected')),
  depends_on TEXT NOT NULL DEFAULT '[]',  -- JSON array of task ids
  visible_to TEXT NOT NULL DEFAULT '[]',  -- roles that see the task besides the assignee
  doc_type TEXT,
  due_date TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  completed_by TEXT REFERENCES users(id),
  completed_at TEXT
);
CREATE INDEX tasks_case ON tasks(case_id);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  title TEXT NOT NULL,
  doc_type TEXT,
  visible_to TEXT NOT NULL DEFAULT '[]',  -- role keys, '*' = all participants; staff and uploader always see
  final INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX documents_case ON documents(case_id);

CREATE TABLE document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  version INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (document_id, version)
);

-- Comments are events of type 'comment'. Same visibility model as documents.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id TEXT NOT NULL REFERENCES cases(id),
  actor_id TEXT REFERENCES users(id),
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  visible_to TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX events_case ON events(case_id);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE invitations (
  token_hash TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  access TEXT NOT NULL,
  access_until TEXT,                  -- becomes case_participants.expires_at
  expires_at TEXT NOT NULL,           -- the link itself
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  accepted_at TEXT
);
