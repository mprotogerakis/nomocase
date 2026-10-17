-- The upload-link guard (0040) also checks that the case and the step are still open: a case closed, or a step done,
-- skipped or deleted while the file was being checked stops the upload too. (In the upload's own transaction the
-- version row comes before the step is ticked off, so the step is still open there.)
DROP TRIGGER document_versions_upload_link;
CREATE TRIGGER document_versions_upload_link BEFORE INSERT ON document_versions
WHEN NEW.upload_link IS NOT NULL AND NOT EXISTS (SELECT 1 FROM upload_links l JOIN cases c ON c.id = l.case_id JOIN tasks t ON t.id = l.task_id
  WHERE l.token_hash = NEW.upload_link AND l.revoked_at IS NULL AND l.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    AND c.status = 'open' AND t.status = 'open')
BEGIN SELECT RAISE(ABORT, 'upload link no longer valid'); END;
