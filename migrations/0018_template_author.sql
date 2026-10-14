-- Who saved a template version: NULL for versions published from templates/*.json (scripts/templates.mjs).
-- The script refuses to overwrite a version saved through the UI unless forced.
ALTER TABLE template_versions ADD COLUMN created_by TEXT;
