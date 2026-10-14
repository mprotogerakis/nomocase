-- Rule engine (spec section 9). Rules live in the case definition (copied from the template).
-- One row per executed rule and event: the primary key makes every rule run at most once per event,
-- and the table is the trail of everything the automation did.
CREATE TABLE automation_runs (
  event_id INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'error')),
  detail TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (event_id, rule_id)
);
CREATE INDEX automation_runs_case ON automation_runs(case_id);

-- Events up to here have been looked at. Starts at "now": old events never trigger rules.
CREATE TABLE rule_cursor (id INTEGER PRIMARY KEY CHECK (id = 1), last_event_id INTEGER NOT NULL);
INSERT INTO rule_cursor (id, last_event_id) SELECT 1, COALESCE(MAX(id), 0) FROM events;

-- Existing finance cases keep what used to be built in, now as editable rules.
UPDATE cases SET definition = json_set(definition, '$.rules', json('[
  {"id": "kuerzung", "name": "Kürzung prüfen", "trigger": "decision.added",
   "conditions": [{"field": "claim.direction", "operator": "equals", "value": "receivable"}, {"field": "claim.cut", "operator": "greater_than", "value": 0}],
   "actions": [{"type": "create_task", "title": "Kürzung prüfen: {claim.title}", "task_type": "review", "assign_to_role": "owner",
     "description": "Anerkannt {claim.recognized} von {claim.amount}, Differenz {claim.cut}. „In Ordnung“, wenn Sie die Kürzung akzeptieren; „Beanstanden“, wenn Sie Widerspruch einlegen."}]},
  {"id": "bezahlt", "name": "Zahlungsaufgabe abhaken, wenn alles bezahlt ist", "trigger": "transaction.booked",
   "conditions": [{"field": "claim.direction", "operator": "equals", "value": "payable"}, {"field": "case.payables_open", "operator": "equals", "value": 0}],
   "actions": [{"type": "complete_tasks", "task_type": "payment"}]}
]'))
WHERE json_extract(definition, '$.finance') = 1 AND json_extract(definition, '$.rules') IS NULL;
