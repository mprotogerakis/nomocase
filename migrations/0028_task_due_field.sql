-- A step remembers the date field its deadline comes from (template "due_field"), so a date entered or changed later
-- (e.g. the submission date set by the exam office after the topic was issued) becomes or moves the deadline.
ALTER TABLE tasks ADD COLUMN due_field TEXT;
UPDATE tasks SET due_field = (
  SELECT json_extract(t.value, '$.due_field')
  FROM cases c
  JOIN template_versions v ON v.template_id = c.template_id AND v.version = c.template_version
  JOIN phases ph ON ph.id = tasks.phase_id
  JOIN json_each(v.definition, '$.phases') p ON p.key = ph.position
  JOIN json_each(p.value, '$.tasks') t ON t.key = tasks.position
  WHERE c.id = tasks.case_id
) WHERE position < 1000000;
