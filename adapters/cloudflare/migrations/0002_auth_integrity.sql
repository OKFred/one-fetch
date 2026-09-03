ALTER TABLE admins ADD COLUMN pending_totp_expires_at TEXT;

CREATE TABLE auth_unknown_login_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  failure_count INTEGER NOT NULL,
  window_started_at TEXT NOT NULL,
  locked_until TEXT
);

CREATE UNIQUE INDEX admins_singleton_idx ON admins ((1));
