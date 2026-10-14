-- What kind of mail was sent, so self-service login links get their own daily cap.
ALTER TABLE mail_log ADD COLUMN kind TEXT;
