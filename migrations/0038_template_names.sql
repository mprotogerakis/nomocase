-- Rules start subcases from a template named in the rule: within a workspace, an active template name names one
-- template. (Archived ones may share a name; restoring such one is refused while the name is taken.)
-- Earlier versions allowed several active templates of one name: the oldest keeps it, the others get a suffix.
UPDATE templates SET name = name || ' (' || rowid || ')'
WHERE archived_at IS NULL AND EXISTS (SELECT 1 FROM templates o WHERE o.workspace_id = templates.workspace_id
  AND o.name = templates.name AND o.archived_at IS NULL AND o.rowid < templates.rowid);
CREATE UNIQUE INDEX templates_name ON templates(workspace_id, name) WHERE archived_at IS NULL;
