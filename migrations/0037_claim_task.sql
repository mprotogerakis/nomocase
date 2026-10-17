-- The step that created a claim. Decisions and payments take a claim a step created (task_id set, even if the step
-- was deleted since) by its title – names are unique per template – so a claim added by hand never catches them.
-- Claims from before stay unassigned: whether a step or a person made one cannot be told reliably from the data, and
-- a wrong guess would book onto the wrong claim. Their steps answer "no claim yet"; book them at the claim instead.
ALTER TABLE financial_claims ADD COLUMN task_id TEXT;
