import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { exports as workerExports } from "cloudflare:workers";
import { ControlErrorV1Schema } from "@one-fetch/protocol";
import { describe, expect, it } from "vitest";

import { CLOUDFLARE_MIGRATIONS } from "../src/generated/migration-manifest";
import {
  assertMigrationCompatibility,
  MigrationCompatibilityError,
} from "../src/migration-integrity";

describe("Cloudflare D1 migration compatibility ledger", () => {
  it("matches the exact ordered runtime manifest", async () => {
    await expect(assertMigrationCompatibility(env.DB)).resolves.toBeUndefined();
    const rows = await env.DB.prepare(
      `SELECT sequence, file, checksum_algorithm, checksum
       FROM one_fetch_migrations ORDER BY sequence`,
    ).all();
    expect(rows.results).toEqual(
      CLOUDFLARE_MIGRATIONS.map((entry) => ({
        sequence: entry.sequence,
        file: entry.file,
        checksum_algorithm: entry.checksumAlgorithm,
        checksum: entry.checksum,
      })),
    );
  });

  it("rejects missing, extra, reordered, and changed ledger entries", async () => {
    const mutations = [
      "DELETE FROM one_fetch_migrations WHERE sequence = 4",
      `INSERT INTO one_fetch_migrations
       (sequence, file, checksum_algorithm, checksum)
       VALUES (5, '0005_unknown.sql', 'self-zeroed-sha256-v1', '${"0".repeat(64)}')`,
      "UPDATE one_fetch_migrations SET sequence = 99 WHERE sequence = 1",
      "UPDATE one_fetch_migrations SET file = '0002_wrong.sql' WHERE sequence = 2",
      `UPDATE one_fetch_migrations SET checksum = '${"f".repeat(64)}' WHERE sequence = 3`,
    ];
    for (const mutation of mutations) {
      try {
        await env.DB.prepare(mutation).run();
        await expect(
          assertMigrationCompatibility(env.DB),
        ).rejects.toBeInstanceOf(MigrationCompatibilityError);
      } finally {
        await restoreLedger();
      }
    }
  });

  it("rejects a pre-ledger database", async () => {
    await env.DB.exec(
      "ALTER TABLE one_fetch_migrations RENAME TO one_fetch_migrations_legacy",
    );
    try {
      await expect(assertMigrationCompatibility(env.DB)).rejects.toMatchObject({
        reason: "ledger_unavailable",
      });
    } finally {
      await env.DB.exec(
        "ALTER TABLE one_fetch_migrations_legacy RENAME TO one_fetch_migrations",
      );
    }
  });

  it("applies 0004 over existing state without replacing it", async () => {
    const testEnv = env as unknown as CloudflareControlEnv & {
      TEST_MIGRATIONS: D1Migration[];
    };
    const ledgerMigration = testEnv.TEST_MIGRATIONS[3];
    expect(ledgerMigration?.name).toBe("0004_migration_integrity.sql");
    await env.DB.prepare(
      `INSERT INTO instance_state (
        singleton, instance_id, config_revision, config_version,
        config_updated_at, config_json
      ) VALUES (1, 'sentinel-instance', 7, 'sentinel-version', ?, '{}')`,
    )
      .bind(new Date().toISOString())
      .run();
    await env.DB.exec("DROP TABLE one_fetch_migrations");
    await env.DB.prepare("DELETE FROM d1_migrations WHERE name = ?")
      .bind(ledgerMigration!.name)
      .run();

    await applyD1Migrations(env.DB, testEnv.TEST_MIGRATIONS);

    expect(
      await env.DB.prepare(
        "SELECT instance_id, config_revision FROM instance_state WHERE singleton = 1",
      ).first(),
    ).toEqual({ instance_id: "sentinel-instance", config_revision: 7 });
    await expect(assertMigrationCompatibility(env.DB)).resolves.toBeUndefined();
  });

  it("fails Control and reports a safe service-binding result", async () => {
    const auditBefore = await count("audit_events");
    try {
      await env.DB.prepare(
        "UPDATE one_fetch_migrations SET checksum = ? WHERE sequence = 1",
      )
        .bind("f".repeat(64))
        .run();

      const response = await SELF.fetch(
        "https://control.example/api/v1/capabilities",
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(ControlErrorV1Schema.parse(await response.json()).error.code).toBe(
        "storage_unavailable",
      );

      expect(
        JSON.parse(
          await workerExports.ControlService.authorizeExecutionJson(
            JSON.stringify({
              token: "unused-because-ledger-check-runs-first",
              requestId: "migration-failure",
              transport: "http",
              targetUrl: "https://target.example/path",
              method: "GET",
              requestBytes: 0,
            }),
          ),
        ),
      ).toMatchObject({
        allowed: false,
        code: "storage_unavailable",
        auditState: "degraded",
      });
      expect(
        JSON.parse(
          await workerExports.ControlService.checkTargetJson(
            "unused-because-ledger-check-runs-first",
            "http",
            "https://target.example/redirect",
          ),
        ),
      ).toMatchObject({
        allowed: false,
        code: "storage_unavailable",
        auditState: "degraded",
      });
      await expect(
        workerExports.ControlService.recordExecutionDecisionJson("{}"),
      ).resolves.toBe("storage_unavailable");
      await expect(
        workerExports.ControlService.releaseExecutionJson("{}"),
      ).resolves.toBe("storage_unavailable");
      await expect(
        workerExports.ControlService.renewExecutionJson(
          "unused-token-id",
          "unused-request-id",
        ),
      ).resolves.toBe("storage_unavailable");

      expect(await count("audit_events")).toBe(auditBefore);
      expect(await count("execution_reports")).toBe(0);
    } finally {
      await restoreLedger();
    }
  });
});

async function restoreLedger(): Promise<void> {
  const statements = [env.DB.prepare("DELETE FROM one_fetch_migrations")];
  for (const migration of CLOUDFLARE_MIGRATIONS) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO one_fetch_migrations
           (sequence, file, checksum_algorithm, checksum)
           VALUES (?, ?, ?, ?)`,
      ).bind(
        migration.sequence,
        migration.file,
        migration.checksumAlgorithm,
        migration.checksum,
      ),
    );
  }
  await env.DB.batch(statements);
}

async function count(
  table: "audit_events" | "execution_reports",
): Promise<number> {
  return (
    (
      await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
        count: number;
      }>()
    )?.count ?? 0
  );
}
