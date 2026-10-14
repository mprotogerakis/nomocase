-- Templates still used by cases are archived instead of deleted: hidden from "new case", running cases keep their copy.
ALTER TABLE templates ADD COLUMN archived_at TEXT;
