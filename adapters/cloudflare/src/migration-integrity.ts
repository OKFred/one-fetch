import { CLOUDFLARE_MIGRATIONS } from "./generated/migration-manifest";

interface MigrationLedgerRow {
  sequence: unknown;
  file: unknown;
  checksum_algorithm: unknown;
  checksum: unknown;
}

export class MigrationCompatibilityError extends Error {
  constructor(
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super("storage_unavailable", options);
    this.name = "MigrationCompatibilityError";
  }
}

export async function assertMigrationCompatibility(
  database: D1Database,
): Promise<void> {
  let rows: MigrationLedgerRow[];
  try {
    const result = await database
      .withSession("first-primary")
      .prepare(
        `SELECT sequence, file, checksum_algorithm, checksum
         FROM one_fetch_migrations
         ORDER BY sequence ASC`,
      )
      .all<MigrationLedgerRow>();
    rows = result.results;
  } catch (error) {
    throw new MigrationCompatibilityError("ledger_unavailable", {
      cause: error,
    });
  }

  if (rows.length !== CLOUDFLARE_MIGRATIONS.length) {
    throw new MigrationCompatibilityError("ledger_length_mismatch");
  }
  for (const [index, expected] of CLOUDFLARE_MIGRATIONS.entries()) {
    const actual = rows[index];
    if (
      !actual ||
      actual.sequence !== expected.sequence ||
      actual.file !== expected.file ||
      actual.checksum_algorithm !== expected.checksumAlgorithm ||
      actual.checksum !== expected.checksum
    ) {
      throw new MigrationCompatibilityError("ledger_entry_mismatch");
    }
  }
}

export function logMigrationCompatibilityFailure(
  surface: "control" | "gateway" | "scheduled",
  error: unknown,
): void {
  console.error(
    JSON.stringify({
      event: "migration.compatibility.failed",
      surface,
      reason:
        error instanceof MigrationCompatibilityError
          ? error.reason
          : "unexpected",
    }),
  );
}
