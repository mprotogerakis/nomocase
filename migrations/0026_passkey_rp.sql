-- Passkeys belong to one domain (WebAuthn RP ID). Since the move to nomocase.example.org, those created before only
-- work on the former domain: they stay listed but no longer count as a way to log in.
ALTER TABLE passkeys ADD COLUMN rp_id TEXT;
UPDATE passkeys SET rp_id = 'nomocase-old.example.org' WHERE rp_id IS NULL;
