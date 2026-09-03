import { z } from "zod";

import { type Database, parseStorageResult } from "./database.ts";
import { SUPABASE_MIGRATION_HISTORY } from "./migration-manifest.generated.ts";

const MigrationEntrySchema = z
  .object({
    version: z.string().regex(/^\d{12}$/u),
    checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

const MigrationHistorySchema = z.array(MigrationEntrySchema);

export class MigrationCompatibilityError extends Error {
  constructor() {
    super("Storage migration history is incompatible with this build");
    this.name = "MigrationCompatibilityError";
  }
}

export async function assertMigrationCompatibility(
  database: Database,
): Promise<void> {
  const actual = parseStorageResult(
    "of_get_migration_integrity",
    MigrationHistorySchema,
    await database.rpc<unknown>("of_get_migration_integrity"),
  );
  if (
    actual.length !== SUPABASE_MIGRATION_HISTORY.length ||
    SUPABASE_MIGRATION_HISTORY.some(
      (expected, index) =>
        actual[index]?.version !== expected.version ||
        actual[index]?.checksum !== expected.checksum,
    )
  ) {
    throw new MigrationCompatibilityError();
  }
}

export function createMigrationCompatibilityGuard(
  database: Database,
  ttlMs = 1_000,
): () => Promise<void> {
  let validUntil = 0;
  let pending: Promise<void> | undefined;
  return async () => {
    if (Date.now() < validUntil) return;
    pending ??= assertMigrationCompatibility(database).then(() => {
      validUntil = Date.now() + ttlMs;
    });
    try {
      await pending;
    } finally {
      pending = undefined;
    }
  };
}
