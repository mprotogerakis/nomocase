-- Digital signatures found in uploaded PDFs (src/pdfsig.js), one row per signature of a version. The certificates are
-- kept (base64 DER, signer first) so trust in an issuer added later applies to earlier uploads too.
CREATE TABLE document_signatures (
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  position INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- valid | invalid | unsupported | timestamp
  detail TEXT,
  subject_name TEXT,
  subject_email TEXT,
  issuer_name TEXT,
  self_signed INTEGER,
  key_fingerprint TEXT,                 -- SHA-256 of the signer's public key
  certs TEXT,                           -- JSON array of base64 DER certificates
  signed_at TEXT,
  covers_all INTEGER NOT NULL,          -- nothing was appended to the file after this signature
  PRIMARY KEY (version_id, position)
);
CREATE INDEX document_signatures_key ON document_signatures(key_fingerprint);

-- Which person a signing key belongs to: confirmed by that person on first contact, optionally vouched for by the team.
CREATE TABLE signing_keys (
  key_fingerprint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  subject_name TEXT,
  issuer_name TEXT,
  confirmed_at TEXT NOT NULL,
  vouched_by TEXT,                      -- user id of a team member who vouched (no FK: guests can be purged)
  vouched_at TEXT
);
CREATE INDEX signing_keys_user ON signing_keys(user_id);

-- Issuers a workspace trusts (e.g. its own small CA): signatures whose certificate chains up to one count as identified.
CREATE TABLE trusted_issuers (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  fingerprint TEXT NOT NULL,            -- SHA-256 of the issuer's public key
  name TEXT NOT NULL,
  certificate TEXT NOT NULL,            -- base64 DER
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, fingerprint)
);
