-- Spec 4.2 variant B: a link that lets someone without an account upload one file for one task.
CREATE TABLE upload_links (
  token_hash TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  task_id TEXT NOT NULL,              -- no FK: tasks may be deleted (the link then simply stops working)
  label TEXT NOT NULL,                -- who uploads, e.g. "Praxis Dr. Weber"
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  single_use INTEGER NOT NULL DEFAULT 1,
  used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX upload_links_case ON upload_links(case_id);

-- Shown instead of a user name for files that came in through such a link.
ALTER TABLE document_versions ADD COLUMN uploader_label TEXT;
