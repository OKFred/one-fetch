
      ALTER TABLE auth_tokens ADD COLUMN session_id TEXT;
      ALTER TABLE auth_tokens ADD COLUMN credential_json TEXT;
      CREATE INDEX auth_tokens_session_idx ON auth_tokens(session_id);
    