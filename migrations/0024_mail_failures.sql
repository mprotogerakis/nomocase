-- Every send attempt is logged, failed ones too, with the provider's answer (still no recipients, no content):
-- otherwise "mails don't arrive" cannot be told apart from "no mail was due".
ALTER TABLE mail_log ADD COLUMN ok INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mail_log ADD COLUMN status INTEGER;
ALTER TABLE mail_log ADD COLUMN error TEXT;
