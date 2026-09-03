PRAGMA foreign_keys = ON;

CREATE TABLE instance_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  instance_id TEXT NOT NULL UNIQUE,
  initialized_at TEXT,
  config_revision INTEGER NOT NULL DEFAULT 1,
  config_version TEXT NOT NULL,
  config_updated_at TEXT NOT NULL,
  config_json TEXT NOT NULL,
  gateway_paused INTEGER NOT NULL DEFAULT 0 CHECK (gateway_paused IN (0, 1)),
  audit_degraded INTEGER NOT NULL DEFAULT 0 CHECK (audit_degraded IN (0, 1))
);

CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  pending_totp_secret TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE auth_login_state (
  username TEXT PRIMARY KEY COLLATE NOCASE,
  failure_count INTEGER NOT NULL,
  window_started_at TEXT NOT NULL,
  locked_until TEXT
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  fingerprint_hash TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX auth_sessions_admin_idx ON auth_sessions(admin_id, revoked_at);
CREATE INDEX auth_sessions_family_idx ON auth_sessions(family_id, revoked_at);

CREATE TABLE refresh_token_history (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,
  replaced_at TEXT NOT NULL
);

CREATE TABLE access_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX access_tokens_session_idx ON access_tokens(session_id, revoked_at);

CREATE TABLE execution_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  scope_json TEXT NOT NULL,
  quota_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES admins(id),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT
);

CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  category TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  severity TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  correlation_json TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  key_id TEXT NOT NULL
);

CREATE INDEX audit_events_time_idx ON audit_events(occurred_at DESC, event_id DESC);
CREATE INDEX audit_events_category_idx ON audit_events(category, occurred_at DESC);

CREATE TABLE execution_reports (
  report_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  token_id TEXT NOT NULL REFERENCES execution_tokens(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  report_json TEXT NOT NULL
);

CREATE UNIQUE INDEX execution_reports_request_idx ON execution_reports(request_id, token_id);
CREATE INDEX execution_reports_expiry_idx ON execution_reports(expires_at);

CREATE TABLE webhook_outbox (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX webhook_outbox_due_idx ON webhook_outbox(delivered_at, next_attempt_at);
