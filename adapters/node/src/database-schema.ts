import { createHash } from "node:crypto";

import {
  NODE_DATABASE_MIGRATIONS,
  NODE_DATABASE_SCHEMA_VERSION,
} from "./generated/database-migrations.js";

export interface DatabaseMigration {
  readonly version: number;
  readonly file: string;
  readonly bytes: number;
  readonly artifactSha256: string;
  readonly sql: string;
}

type MigrationDefinition = Pick<DatabaseMigration, "sql" | "version"> &
  Partial<Pick<DatabaseMigration, "artifactSha256" | "bytes" | "file">>;

export const DATABASE_SCHEMA_VERSION = NODE_DATABASE_SCHEMA_VERSION;
export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] =
  NODE_DATABASE_MIGRATIONS;

export const assertMigrationDefinitions = (
  migrations: readonly MigrationDefinition[] = DATABASE_MIGRATIONS,
  schemaVersion: number = DATABASE_SCHEMA_VERSION,
): void => {
  if (schemaVersion < 1 || migrations.length !== schemaVersion) {
    throw new Error(
      `Migration definitions do not match schema version ${schemaVersion}`,
    );
  }

  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Migration definitions must be unique and contiguous; expected version ${expectedVersion}, received ${migration.version}`,
      );
    }
    if (!migration.sql.trim()) {
      throw new Error(`Migration ${migration.version} must contain SQL`);
    }

    const metadata = [
      migration.file,
      migration.bytes,
      migration.artifactSha256,
    ];
    if (metadata.every((value) => value === undefined)) continue;
    if (
      typeof migration.file !== "string" ||
      typeof migration.bytes !== "number" ||
      typeof migration.artifactSha256 !== "string"
    ) {
      throw new Error(`Migration ${migration.version} metadata is incomplete`);
    }
    if (
      !migration.file.startsWith(
        `${String(migration.version).padStart(4, "0")}_`,
      )
    ) {
      throw new Error(
        `Migration ${migration.version} filename is inconsistent`,
      );
    }
    const actualBytes = Buffer.byteLength(migration.sql, "utf8");
    const actualSha256 = createHash("sha256")
      .update(migration.sql, "utf8")
      .digest("hex");
    if (
      migration.bytes !== actualBytes ||
      migration.artifactSha256 !== actualSha256
    ) {
      throw new Error(
        `Migration ${migration.version} generated artifact integrity check failed`,
      );
    }
  }
};
