import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertMigrationDefinitions,
  DATABASE_MIGRATIONS,
  DATABASE_SCHEMA_VERSION,
} from "./database-schema.js";
import { DatabaseClient } from "./database.js";

const temporaryDirectories: string[] = [];

const temporaryDatabase = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-database-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "database.sqlite");
};

const migrationChecksum = (version: number): string => {
  const migration = DATABASE_MIGRATIONS.find(
    (candidate) => candidate.version === version,
  );
  if (!migration) throw new Error(`Unknown test migration ${version}`);
  return createHash("sha256").update(migration.sql, "utf8").digest("hex");
};

const writeLedger = (
  databasePath: string,
  rows: { checksum?: string; version: number }[],
): void => {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;",
    );
    const insert = database.prepare(
      "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(
        row.version,
        row.checksum ?? migrationChecksum(row.version),
        new Date().toISOString(),
      );
    }
  } finally {
    database.close();
  }
};

const withDeadline = async <Value>(
  promise: Promise<Value>,
  milliseconds = 2_000,
): Promise<Value> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Database operation did not settle in time")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
  );
});

describe("Node database startup and lifecycle", () => {
  it("migrates a fresh database and reopens the exact applied prefix", async () => {
    const databasePath = await temporaryDatabase();
    const first = new DatabaseClient(databasePath);
    await first.ready();
    const initialRows = await first.all<{
      applied_at: string;
      checksum: string;
      version: number;
    }>(
      "SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version",
    );
    expect(initialRows.map(({ version }) => version)).toEqual(
      DATABASE_MIGRATIONS.map(({ version }) => version),
    );
    expect(
      initialRows.map(({ version, checksum }) => ({ version, checksum })),
    ).toEqual(
      DATABASE_MIGRATIONS.map(({ version, artifactSha256 }) => ({
        version,
        checksum: artifactSha256,
      })),
    );
    expect(
      initialRows.every(
        ({ applied_at }) => !Number.isNaN(Date.parse(applied_at)),
      ),
    ).toBe(true);
    await Promise.all([first.close(), first.close()]);
    await expect(first.get("SELECT 1")).rejects.toThrow(
      "Database client is closed",
    );

    const reopened = new DatabaseClient(databasePath);
    await reopened.ready();
    const reopenedRows = await reopened.all<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(reopenedRows.map(({ version }) => version)).toEqual(
      DATABASE_MIGRATIONS.map(({ version }) => version),
    );
    await reopened.close();
  });

  it.each([
    {
      expected: "expected version 1, received 7",
      name: "a sparse newest-only ledger",
      rows: [{ version: 7 }],
    },
    {
      expected: "expected version 2, received 3",
      name: "a missing middle migration",
      rows: [{ version: 1 }, { version: 3 }],
    },
    {
      expected: "newer than supported schema",
      name: "an unknown higher migration",
      rows: [{ checksum: "0".repeat(64), version: 8 }],
    },
    {
      expected: "checksum does not match",
      name: "a changed applied migration",
      rows: [{ checksum: "0".repeat(64), version: 1 }],
    },
  ])("fails closed for $name", async ({ expected, rows }) => {
    const databasePath = await temporaryDatabase();
    writeLedger(databasePath, rows);
    const database = new DatabaseClient(databasePath);

    await expect(withDeadline(database.ready())).rejects.toThrow(expected);
    await expect(withDeadline(database.get("SELECT 1"))).rejects.toThrow(
      expected,
    );
    await withDeadline(Promise.all([database.close(), database.close()]));
  });

  it("retains startup failure when fatal arrives before ready is called", async () => {
    const databasePath = await temporaryDatabase();
    writeLedger(databasePath, [{ checksum: "invalid", version: 1 }]);
    const database = new DatabaseClient(databasePath);

    const fatal = await withDeadline(database.fatal);
    expect(fatal.message).toContain("checksum does not match");
    await expect(withDeadline(database.ready())).rejects.toThrow(
      "checksum does not match",
    );
    await withDeadline(database.close());
  });

  it("checks integrity before changing journal mode or applying migrations", async () => {
    const databasePath = await temporaryDatabase();
    const corrupt = new DatabaseSync(databasePath);
    try {
      corrupt.enableDefensive(false);
      corrupt.exec(`
        CREATE TABLE sentinel(value INTEGER);
        PRAGMA writable_schema = ON;
        UPDATE sqlite_schema
          SET sql = 'CREATE TABLE sentinel('
          WHERE type = 'table' AND name = 'sentinel';
        PRAGMA writable_schema = OFF;
      `);
    } finally {
      corrupt.close();
    }
    const before = await readFile(databasePath);
    const database = new DatabaseClient(databasePath);

    await expect(withDeadline(database.ready())).rejects.toThrow();
    await withDeadline(database.close());
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("rejects in-flight and future work after an operational worker crash", async () => {
    const workerSource = `
      import { parentPort } from "node:worker_threads";
      parentPort.postMessage({
        kind: "startup-ready",
        schemaVersion: ${DATABASE_SCHEMA_VERSION}
      });
      parentPort.once("message", () => {
        throw new Error("synthetic database worker crash");
      });
    `;
    const workerEntry = new URL(
      `data:text/javascript,${encodeURIComponent(workerSource)}`,
    );
    const database = new DatabaseClient(":memory:", workerEntry);
    await database.ready();

    await expect(withDeadline(database.get("SELECT 1"))).rejects.toThrow(
      "synthetic database worker crash",
    );
    const fatal = await withDeadline(database.fatal);
    expect(fatal.message).toContain("synthetic database worker crash");
    await expect(withDeadline(database.get("SELECT 1"))).rejects.toThrow(
      "synthetic database worker crash",
    );
    await withDeadline(Promise.all([database.close(), database.close()]));
  });

  it("rejects invalid code migration definitions before database startup", () => {
    expect(() =>
      assertMigrationDefinitions(
        [
          { sql: "SELECT 1", version: 1 },
          { sql: "SELECT 2", version: 1 },
        ],
        2,
      ),
    ).toThrow("unique and contiguous");
    expect(() =>
      assertMigrationDefinitions([{ sql: "SELECT 1", version: 1 }], 2),
    ).toThrow("do not match schema version");
    expect(() =>
      assertMigrationDefinitions(
        [
          {
            version: 1,
            file: "0001_tampered.sql",
            bytes: 8,
            artifactSha256: "0".repeat(64),
            sql: "SELECT 1",
          },
        ],
        1,
      ),
    ).toThrow("generated artifact integrity check failed");
  });
});
