-- Batch requests of digest and progress mails between storing them and the provider's answer. A row is one request:
-- its Idempotency-Key (id) and exactly the mails it carries. No answer (timeout, lost connection, 5xx) or a run that
-- stops: the cron sends the same request with the same key again, and the provider sends nothing twice. Deleted once
-- the answer is in (the mails' texts carry case data).
-- mails: JSON [{ to, subject, text, log (mail_log id), undo (how to take back its marks if it is not sent) }]
CREATE TABLE bulk_outbox (
  id TEXT PRIMARY KEY,
  mails TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
