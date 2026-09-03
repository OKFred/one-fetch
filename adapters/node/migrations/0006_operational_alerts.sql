
      CREATE TABLE operational_alerts (
        alert_id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
        request_id TEXT,
        report_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX operational_alerts_state_idx
        ON operational_alerts(state, updated_at);
    