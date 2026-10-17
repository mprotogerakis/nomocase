-- Rules start subcases from a template named in the rule: within a workspace, an active template name names one
-- template. (Archived ones may share a name; restoring such one is refused while the name is taken.)
CREATE UNIQUE INDEX templates_name ON templates(workspace_id, name) WHERE archived_at IS NULL;
