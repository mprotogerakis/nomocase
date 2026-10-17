-- Keys the Worker makes for itself on first use (no secret to configure), e.g. to sign passkey login challenges.
CREATE TABLE app_secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
