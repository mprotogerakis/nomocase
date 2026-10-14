-- Each case gets an unguessable mail address (v-<inbox>@INBOX_DOMAIN). Mails sent or CC'd to it are kept as documents.
ALTER TABLE cases ADD COLUMN inbox TEXT;
UPDATE cases SET inbox = lower(hex(randomblob(5))) WHERE inbox IS NULL;
CREATE UNIQUE INDEX cases_inbox ON cases(inbox);
-- The same mail arriving twice (e.g. To and CC, or a forwarded copy) is stored once per case.
CREATE TABLE inbound_mail (
  case_id TEXT NOT NULL REFERENCES cases(id),
  message_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  sender TEXT,
  received_at TEXT NOT NULL,
  PRIMARY KEY (case_id, message_id)
);
