import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import {
  DATABASE_MIGRATIONS,
  DATABASE_SCHEMA_VERSION,
} from "./database-schema.js";
import type {
  DatabaseRequest,
  DatabaseResponse,
  RunResult,
  SqlOperation,
  SqlResult,
} from "./database-protocol.js";

interface WorkerData {
  databasePath: string;
}

const data = workerData as WorkerData;
if (data.databasePath !== ":memory:")
  mkdirSync(dirname(data.databasePath), { recursive: true });

const database = new DatabaseSync(data.databasePath);
database.exec(
  "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
);

const checksum = (sql: string): string =>
  createHash("sha256").update(sql, "utf8").digest("hex");

const migrate = (): void => {
  database.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;",
  );
  const rows = database
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all() as {
    version: number;
    checksum: string;
  }[];
  const newest = rows.at(-1)?.version ?? 0;
  if (newest > DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `Database schema ${newest} is newer than supported schema ${DATABASE_SCHEMA_VERSION}`,
    );
  }

  for (const migration of DATABASE_MIGRATIONS) {
    const expected = checksum(migration.sql);
    const applied = rows.find((row) => row.version === migration.version);
    if (applied) {
      if (applied.checksum !== expected) {
        throw new Error(
          `Migration ${migration.version} checksum does not match the applied database`,
        );
      }
      continue;
    }

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

const execute = (operation: SqlOperation): SqlResult => {
  const statement = database.prepare(operation.sql);
  const parameters = (operation.parameters ?? []) as SQLInputValue[];
  if (operation.kind === "run") {
    const result = statement.run(...parameters);
    return {
      changes: Number(result.changes),
      lastInsertRowid: BigInt(result.lastInsertRowid),
    } satisfies RunResult;
  }
  if (operation.kind === "get")
    return statement.get(...parameters) as SqlResult;
  return statement.all(...parameters) as SqlResult;
};

const runTransaction = (operations: SqlOperation[]): SqlResult[] => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const results = operations.map(execute);
    database.exec("COMMIT");
    return results;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

migrate();

if (!parentPort)
  throw new Error("Database worker must run inside a Worker thread");

parentPort.on("message", (request: DatabaseRequest) => {
  try {
    let result: SqlResult | SqlResult[] | undefined;
    if (request.kind === "close") {
      database.close();
    } else if (request.kind === "exec") {
      database.exec(request.sql);
    } else if (request.kind === "integrity") {
      result = database.prepare("PRAGMA integrity_check").get() as SqlResult;
    } else if (request.kind === "operation") {
      result = execute(request.operation);
    } else {
      result = runTransaction(request.operations);
    }
    parentPort?.postMessage({
      id: request.id,
      ok: true,
      result,
    } satisfies DatabaseResponse);
    if (request.kind === "close") parentPort?.close();
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : "Unknown database error",
    } satisfies DatabaseResponse);
  }
});
