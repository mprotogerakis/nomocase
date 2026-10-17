-- How a step takes files (template "files"): { multiple: true } for several files, { accept: ["pdf", …] } for file kinds.
ALTER TABLE tasks ADD COLUMN files TEXT;
