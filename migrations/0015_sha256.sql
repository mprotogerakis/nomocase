-- SHA-256 of each stored file version: proof of exactly what was submitted. Versions from before stay NULL.
ALTER TABLE document_versions ADD COLUMN sha256 TEXT;
