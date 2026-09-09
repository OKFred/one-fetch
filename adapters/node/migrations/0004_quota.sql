
      CREATE TABLE quota_daily_usage (
        day TEXT NOT NULL,
        token_id TEXT NOT NULL,
        bytes_used INTEGER NOT NULL CHECK (bytes_used >= 0),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (day, token_id)
      ) STRICT;
      CREATE INDEX quota_daily_usage_updated_idx
        ON quota_daily_usage(updated_at);

      CREATE TABLE quota_rate_state (
        quota_key TEXT PRIMARY KEY,
        tokens REAL NOT NULL CHECK (tokens >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
      ) STRICT;
    