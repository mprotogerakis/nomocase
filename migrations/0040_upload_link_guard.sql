-- A file through an upload link is stored only while the link is still valid – checked in the same transaction as the
-- version row, so a link revoked (or its case moved) while the file was being checked stops the upload.
ALTER TABLE document_versions ADD COLUMN upload_link TEXT;
CREATE TRIGGER document_versions_upload_link BEFORE INSERT ON document_versions
WHEN NEW.upload_link IS NOT NULL AND NOT EXISTS (SELECT 1 FROM upload_links WHERE token_hash = NEW.upload_link
  AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
BEGIN SELECT RAISE(ABORT, 'upload link no longer valid'); END;
