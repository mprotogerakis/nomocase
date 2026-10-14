-- Consent to the processing in NomoCase, per person and text version (accountability: who agreed to what, when).
CREATE TABLE consents (
  user_id TEXT NOT NULL REFERENCES users(id),
  version TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  withdrawn_at TEXT,
  PRIMARY KEY (user_id, version)
);
