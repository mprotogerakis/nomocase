-- Remember which task a document version was uploaded through, so a task can show its result.
-- No FK: tasks may be deleted.
ALTER TABLE document_versions ADD COLUMN task_id TEXT;
