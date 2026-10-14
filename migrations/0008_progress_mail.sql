-- Progress mails: bundled news from a person's cases, at most one mail per 20 minutes.
ALTER TABLE users ADD COLUMN email_progress INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN progress_cursor TEXT;   -- events up to here have been considered
ALTER TABLE users ADD COLUMN progress_mail_at TEXT;  -- last progress mail, for the rate limit

-- Count of sent mails, to stay under the mail provider's daily quota. No recipients, no content.
CREATE TABLE mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bulk INTEGER NOT NULL,              -- 1 = digest/progress (capped), 0 = invitation, login link, notice
  sent_at TEXT NOT NULL
);
CREATE INDEX mail_log_sent ON mail_log(sent_at);
