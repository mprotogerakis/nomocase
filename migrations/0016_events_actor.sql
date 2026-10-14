-- "zuletzt aktiv" on the Personen page: latest own event per person without scanning the whole log.
CREATE INDEX events_actor ON events(actor_id, created_at);
