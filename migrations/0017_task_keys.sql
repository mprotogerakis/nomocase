-- Stable step keys from the template, so rules and evaluations refer to steps by key instead of by title.
-- Backfill: template steps sit at (phase position, task position) of the template version the case was created from.
-- Steps added later by hand have no key; rules may give the steps they create a key (several steps can share it).
ALTER TABLE tasks ADD COLUMN key TEXT;
UPDATE tasks SET key = (
  SELECT json_extract(t.value, '$.key')
  FROM cases c
  JOIN template_versions v ON v.template_id = c.template_id AND v.version = c.template_version
  JOIN phases ph ON ph.id = tasks.phase_id
  JOIN json_each(v.definition, '$.phases') p ON p.key = ph.position
  JOIN json_each(p.value, '$.tasks') t ON t.key = tasks.position
  WHERE c.id = tasks.case_id
) WHERE position < 1000000;
CREATE INDEX tasks_case_key ON tasks(case_id, key);
