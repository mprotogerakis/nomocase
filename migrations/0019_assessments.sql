-- Assessments become a template concept: a step names a scale of its case definition (`assess`) and stores the value
-- given (`score`). Replaces the hard-coded grade flag of 0014. Steps graded so far keep working: they get the scale
-- they were graded on (1,0–4,0 in steps of 0,1, otherwise 5,0; mean cut after one decimal) copied into their case.
ALTER TABLE tasks ADD COLUMN assess TEXT;
ALTER TABLE tasks ADD COLUMN score REAL;
UPDATE tasks SET assess = 'note' WHERE grade = 1;
UPDATE tasks SET score = (
  SELECT CAST(REPLACE(json_extract(e.payload, '$.grade'), ',', '.') AS REAL) FROM events e
  WHERE e.case_id = tasks.case_id AND json_extract(e.payload, '$.task_id') = tasks.id AND json_extract(e.payload, '$.grade') IS NOT NULL
  ORDER BY e.id DESC LIMIT 1
) WHERE grade = 1 AND status = 'done';
UPDATE cases SET definition = json_set(definition,
  '$.scales', json('{"note": {"label": "Note", "range": [1.0, 4.0], "step": 0.1, "extra": [5.0], "pass": {"max": 4.0}, "hint": "1,0 bis 4,0 in Schritten von 0,1, sonst 5,0"}}'),
  '$.aggregates', json_array(json_object('key', 'modulnote', 'label', 'Modulnote', 'scale', 'note',
    'from', json((SELECT json_group_array(key) FROM tasks t WHERE t.case_id = cases.id AND t.grade = 1)),
    'method', 'mean', 'round', 'truncate', 'fail_value', 5.0, 'field', 'grade',
    'note', 'Mittel der Einzelnoten, nur die erste Nachkommastelle zählt')))
WHERE id IN (SELECT case_id FROM tasks WHERE grade = 1);
ALTER TABLE tasks DROP COLUMN grade;
