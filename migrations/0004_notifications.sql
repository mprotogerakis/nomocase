-- Email notifications: opt-out per user, and a log so each task is announced once per stage.

ALTER TABLE users ADD COLUMN email_reminders INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN last_digest_at TEXT;

-- stage: new | week | soon | overdue. No FK on task_id: tasks may be deleted.
CREATE TABLE notifications (
  user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (user_id, task_id, stage)
);
