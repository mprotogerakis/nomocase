-- The step that created a claim: decisions and payments find their claim through it, not through its title (a claim
-- added by hand with the same title must not catch them). Claims from before are matched once by title, as until now.
ALTER TABLE financial_claims ADD COLUMN task_id TEXT;
UPDATE financial_claims SET task_id = (SELECT t.id FROM tasks t WHERE t.case_id = financial_claims.case_id
  AND json_extract(t.money, '$.claim') = financial_claims.title ORDER BY t.position LIMIT 1);
