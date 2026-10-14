-- Subcases (spec section 16): a case can contain further cases, each with its own template and participants.
ALTER TABLE cases ADD COLUMN parent_case_id TEXT REFERENCES cases(id);
CREATE INDEX cases_parent ON cases(parent_case_id);
