-- one-fetch-self-checksum-v1: dc056fcbf79947cf69a6e3306ad71b1d7753a7c6069825b9b1ab245be5886587
CREATE TABLE one_fetch_migrations (
  sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
  file TEXT NOT NULL UNIQUE,
  checksum_algorithm TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO one_fetch_migrations (sequence, file, checksum_algorithm, checksum)
VALUES (1, '0001_initial.sql', 'sha256', 'aef30579612af618e0aaec9103b5af329a7358b9dd724d7d1cf5be8596a35775');

INSERT INTO one_fetch_migrations (sequence, file, checksum_algorithm, checksum)
VALUES (2, '0002_auth_integrity.sql', 'sha256', '490726308bc453559b15ab811fcfcebed5442f3946cf2e380641d4177cb98e9f');

INSERT INTO one_fetch_migrations (sequence, file, checksum_algorithm, checksum)
VALUES (3, '0003_execution_terminal.sql', 'sha256', 'f7c5b66ba8bda0eb3908a6d2d4849252e442ab9e9d7032023d53b77cfea98234');

INSERT INTO one_fetch_migrations (sequence, file, checksum_algorithm, checksum)
VALUES (4, '0004_migration_integrity.sql', 'self-zeroed-sha256-v1', 'dc056fcbf79947cf69a6e3306ad71b1d7753a7c6069825b9b1ab245be5886587');
