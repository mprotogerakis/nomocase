-- Demo data: one owner with a university and a private workspace. Templates come from templates/*.json
-- (npm run db:init publishes them with scripts/templates.mjs).
INSERT INTO users (id, email, name, created_at) VALUES ('u_prof', 'prof@example.org', 'Prof. Demo', '2026-10-01T00:00:00Z');

INSERT INTO workspaces (id, name) VALUES ('ws_hs', 'Hochschule'), ('ws_priv', 'Privat');
INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('ws_hs', 'u_prof', 'owner'), ('ws_priv', 'u_prof', 'owner');
