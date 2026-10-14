-- How the forms of a workspace look: accent colour (#rrggbb) and logo (a small PNG/JPEG as data URL).
ALTER TABLE workspaces ADD COLUMN accent TEXT;
ALTER TABLE workspaces ADD COLUMN logo TEXT;
