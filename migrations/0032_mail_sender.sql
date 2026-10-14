-- Who triggered a mail (user id), for a daily cap per person over all kinds of mail.
ALTER TABLE mail_log ADD COLUMN sender_id TEXT;
CREATE INDEX mail_log_sender ON mail_log(sender_id, sent_at);
