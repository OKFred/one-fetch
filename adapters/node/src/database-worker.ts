import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import {
  assertMigrationDefinitions,
  DATABASE_MIGRATIONS,
  DATABASE_SCHEMA_VERSION,
} from "./database-schema.js";
import type {
  DatabaseRequest,
  DatabaseResponse,
  DatabaseWorkerMessage,
  RunResult,
  SqlOperation,
  SqlResult,
} from "./database-protocol.js";

interface WorkerData {
  databasePath: string;
}

class ConditionalWriteError extends Error {}

interface AppliedMigration {
  checksum: string;
  version: number;
}

if (!parentPort)
  throw new Error("Database worker must run inside a Worker thread");

const port = parentPort;

const checksum = (sql: string): string =>
  createHash("sha256").update(sql, "utf8").digest("hex");

const assertIntegrity = (database: DatabaseSync): void => {
  const result = database.prepare("PRAGMA integrity_check").get() as {
    integrity_check?: unknown;
  };
  if (result.integrity_check !== "ok") {
    throw new Error("Database integrity check failed");
  }
};

const migrate = (database: DatabaseSync): void => {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;",
  );
  const rawRows = database
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all();
  const rows = rawRows.map((row): AppliedMigration => {
    if (typeof row.version !== "number" || typeof row.checksum !== "string") {
      throw new Error("Applied migration ledger contains invalid values");
    }
    return { checksum: row.checksum, version: row.version };
  });

  for (const [index, applied] of rows.entries()) {
    const migration = DATABASE_MIGRATIONS[index];
    if (!migration || applied.version > DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `Database schema ${applied.version} is newer than supported schema ${DATABASE_SCHEMA_VERSION}`,
      );
    }
    if (applied.version !== migration.version) {
      throw new Error(
        `Applied migrations must be a contiguous prefix; expected version ${migration.version}, received ${applied.version}`,
      );
    }
    const expected = checksum(migration.sql);
    if (applied.checksum !== expected) {
      throw new Error(
        `Migration ${migration.version} checksum does not match the applied database`,
      );
    }
  }

  for (const migration of DATABASE_MIGRATIONS.slice(rows.length)) {
    const expected = checksum(migration.sql);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, expected, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
};

const openDatabase = (): DatabaseSync => {
  assertMigrationDefinitions();
  const data = workerData as WorkerData | undefined;
  if (!data || typeof data.databasePath !== "string" || !data.databasePath) {
    throw new Error("Database worker requires a database path");
  }
  if (data.databasePath !== ":memory:")
    mkdirSync(dirname(data.databasePath), { recursive: true });

  const database = new DatabaseSync(data.databasePath);
  try {
    assertIntegrity(database);
    database.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
    );
    migrate(database);
    assertIntegrity(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
};

const execute = (
  database: DatabaseSync,
  operation: SqlOperation,
): SqlResult => {
  const statement = database.prepare(operation.sql);
  const parameters = (operation.parameters ?? []) as SQLInputValue[];
  if (operation.kind === "run") {
    const result = statement.run(...parameters);
    const runResult = {
      changes: Number(result.changes),
      lastInsertRowid: BigInt(result.lastInsertRowid),
    } satisfies RunResult;
    if (
      operation.expectedChanges !== undefined &&
      runResult.changes !== operation.expectedChanges
    ) {
      throw new ConditionalWriteError(
        `Expected ${operation.expectedChanges} changed row(s), received ${runResult.changes}`,
      );
    }
    return runResult;
  }
  if (operation.kind === "get") return statement.get(...parameters);
  return statement.all(...parameters);
};

const runTransaction = (
  database: DatabaseSync,
  operations: SqlOperation[],
): SqlResult[] => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const results = operations.map((operation) => execute(database, operation));
    database.exec("COMMIT");
    return results;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

const listen = (database: DatabaseSync): void => {
  port.on("message", (request: DatabaseRequest) => {
    try {
      let result: SqlResult | SqlResult[] | undefined;
      if (request.kind === "close") {
        database.close();
      } else if (request.kind === "exec") {
        database.exec(request.sql);
      } else if (request.kind === "integrity") {
        result = database.prepare("PRAGMA integrity_check").get();
      } else if (request.kind === "operation") {
        result = execute(database, request.operation);
      } else {
        result = runTransaction(database, request.operations);
      }
      port.postMessage({
        id: request.id,
        ok: true,
        result,
      } satisfies DatabaseResponse);
      if (request.kind === "close") port.close();
    } catch (error) {
      port.postMessage({
        id: request.id,
        ok: false,
        ...(error instanceof ConditionalWriteError
          ? { code: "conditional_write_failed" as const }
          : {}),
        error:
          error instanceof Error ? error.message : "Unknown database error",
      } satisfies DatabaseResponse);
    }
  });
};

try {
  const database = openDatabase();
  listen(database);
  port.postMessage({
    kind: "startup-ready",
    schemaVersion: DATABASE_SCHEMA_VERSION,
  } satisfies DatabaseWorkerMessage);
} catch (error) {
  port.postMessage({
    error: error instanceof Error ? error.message : "Unknown database error",
    kind: "startup-fatal",
  } satisfies DatabaseWorkerMessage);
  port.close();
}
