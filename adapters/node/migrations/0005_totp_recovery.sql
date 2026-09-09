
      ALTER TABLE administrators ADD COLUMN pending_totp_ciphertext TEXT;
      CREATE TABLE recovery_codes (
        id TEXT PRIMARY KEY,
        administrator_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        used_at TEXT,
        FOREIGN KEY (administrator_id) REFERENCES administrators(id) ON DELETE CASCADE,
        UNIQUE (administrator_id, digest)
      ) STRICT;
      CREATE INDEX recovery_codes_admin_idx
        ON recovery_codes(administrator_id, used_at);
    