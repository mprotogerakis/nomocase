-- Mails that carry a link (invitations, login links) go through an outbox: the row is written in the same transaction
-- as the link, delivering and retrying it are tracked separately. The text (with the link) is kept only until the mail
-- is handed over or given up. Every attempt sends the row's id as Idempotency-Key, so a mail the provider accepted but
-- whose answer got lost is not sent twice when it is tried again.
CREATE TABLE mail_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('invitation', 'workspace_invitation', 'login_link')),
  ref TEXT NOT NULL,                -- token_hash of the link the mail carries (in the table of its kind)
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT,                        -- NULL once sent or given up
  reply_to TEXT,
  sender_id TEXT,                   -- whose action caused it (daily cap per person)
  mail_kind TEXT,                   -- mail_log.kind, e.g. login_request
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX mail_outbox_due ON mail_outbox(status, next_attempt_at);
CREATE INDEX mail_outbox_ref ON mail_outbox(ref);
CREATE INDEX mail_outbox_sender ON mail_outbox(sender_id, created_at);
ALTER TABLE mail_log ADD COLUMN outbox_id TEXT; -- the outbox mail an attempt belonged to
