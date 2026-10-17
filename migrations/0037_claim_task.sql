-- The step that created a claim. Decisions and payments take a claim a step created (task_id set, even if the step
-- was deleted since) by its title – names are unique per template – so a claim added by hand never catches them.
ALTER TABLE financial_claims ADD COLUMN task_id TEXT;
-- Claims from before: only where it is unambiguous (the only claim of that title in the case, and a step creates it).
-- Otherwise the claim stays unassigned: no booking lands on the wrong one (it can still be booked at the claim).
UPDATE financial_claims SET task_id = (SELECT t.id FROM tasks t WHERE t.case_id = financial_claims.case_id
  AND json_extract(t.money, '$.claim') = financial_claims.title ORDER BY t.position LIMIT 1)
WHERE (SELECT COUNT(*) FROM financial_claims o WHERE o.case_id = financial_claims.case_id AND o.title = financial_claims.title) = 1;
