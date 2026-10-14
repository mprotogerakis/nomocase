-- Passkey login (WebAuthn) plus one-time login links for owner bootstrap/recovery.

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,                -- credential id (base64url)
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,           -- COSE key (base64url)
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX passkeys_user ON passkeys(user_id);

-- WebAuthn challenges, single use (deleted on verify), user_id set for registration only.
CREATE TABLE challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  expires_at TEXT NOT NULL
);

-- Issued only from the CLI (scripts/login-link.mjs).
CREATE TABLE login_links (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
