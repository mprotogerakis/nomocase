-- Optional money step of a template task (JSON): {"claim": title, "direction": ...} | {"decision": claim title} | {"payment": claim title}.
-- Completing such a task with an amount creates the claim, records the decision or books the payment.
ALTER TABLE tasks ADD COLUMN money TEXT;
