-- Rules start subcases from a template named in the rule: within a workspace, an active template name names one
-- template. (Archived ones may share a name; restoring such one is refused while the name is taken.)
-- Earlier versions allowed several active templates of one name. The one a rule picked until now stays active (the
-- highest version; on a tie the newest); the others are archived – nothing is renamed, running cases keep their copy.
UPDATE templates SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE archived_at IS NULL AND EXISTS (SELECT 1 FROM templates o WHERE o.workspace_id = templates.workspace_id
  AND o.name = templates.name AND o.archived_at IS NULL AND o.id <> templates.id
  AND ((SELECT MAX(version) FROM template_versions WHERE template_id = o.id), o.rowid)
    > ((SELECT MAX(version) FROM template_versions WHERE template_id = templates.id), templates.rowid));
CREATE UNIQUE INDEX templates_name ON templates(workspace_id, name) WHERE archived_at IS NULL;
