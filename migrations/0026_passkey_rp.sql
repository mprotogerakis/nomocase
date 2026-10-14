-- Passkeys belong to one domain (WebAuthn RP ID); new ones remember it. Older ones without rp_id were made on a former
-- domain: they stay listed but no longer count as a way to log in.
ALTER TABLE passkeys ADD COLUMN rp_id TEXT;
