export const DATABASE_SCHEMA_VERSION = 2;

export const DATABASE_MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS instance_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS administrators (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        totp_ciphertext TEXT,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS bootstrap_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        token_digest TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        consumed_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS auth_tokens (
        id TEXT PRIMARY KEY,
        administrator_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh', 'execution')),
        digest TEXT NOT NULL UNIQUE,
        family_id TEXT,
        parent_id TEXT,
        scopes_json TEXT NOT NULL,
        origin_policy_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        used_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (administrator_id) REFERENCES administrators(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES auth_tokens(id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS auth_tokens_digest_idx ON auth_tokens(digest);
      CREATE INDEX IF NOT EXISTS auth_tokens_family_idx ON auth_tokens(family_id);

      CREATE TABLE IF NOT EXISTS policy_rules (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        rule_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL,
        actor_json TEXT NOT NULL,
        subject_json TEXT NOT NULL,
        details_json TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        content_sha256 TEXT NOT NULL,
        signature TEXT NOT NULL,
        previous_sha256 TEXT,
        retention_class TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS audit_occurred_at_idx ON audit_events(occurred_at);

      CREATE TABLE IF NOT EXISTS audit_seals (
        seal_date TEXT PRIMARY KEY,
        first_sequence INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        terminal_sha256 TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS execution_reports (
        request_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        report_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS execution_reports_expiry_idx ON execution_reports(expires_at);

      CREATE TABLE IF NOT EXISTS webhook_outbox (
        event_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        delivered_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE auth_tokens ADD COLUMN session_id TEXT;
      ALTER TABLE auth_tokens ADD COLUMN credential_json TEXT;
      CREATE INDEX auth_tokens_session_idx ON auth_tokens(session_id);
    `,
  },
] as const;
