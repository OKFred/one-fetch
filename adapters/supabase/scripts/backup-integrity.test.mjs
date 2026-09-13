import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backupDigest, verifyBackupIntegrity } from "./backup-integrity.mjs";

async function fixture(run) {
  const directory = await mkdtemp(
    join(tmpdir(), "one-fetch-backup-integrity-"),
  );
  try {
    const backup = {
      format: "supabase-logical-v2",
      schemas: ["one_fetch", "supabase_migrations"],
    };
    for (const kind of ["schema", "rpc", "data"]) {
      const source = `-- synthetic ${kind}\n`;
      const path = join(directory, `before.${kind}.sql`);
      await writeFile(path, source, { flag: "wx", mode: 0o600 });
      backup[kind] = {
        path,
        bytes: source.length,
        sha256: createHash("sha256").update(source).digest("hex"),
        ...(kind === "rpc" ? { count: 39 } : {}),
      };
    }
    backup.sha256 = backupDigest(backup);
    await run(backup, join(directory, "state.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("v2 verifies all three parts without claiming a functional restore", () =>
  fixture(async (backup, state) => {
    assert.deepEqual(await verifyBackupIntegrity(backup, state), {
      format: "supabase-logical-v2",
      parts: 3,
      rpcCount: 39,
      integrityVerified: true,
      restoreVerified: false,
    });
  }));

for (const kind of ["schema", "rpc", "data"]) {
  test(`v2 rejects truncated and same-size corrupted ${kind}`, () =>
    fixture(async (backup, state) => {
      await writeFile(backup[kind].path, "x");
      await assert.rejects(
        verifyBackupIntegrity(backup, state),
        /size mismatch/u,
      );
      await writeFile(backup[kind].path, "x".repeat(backup[kind].bytes));
      await assert.rejects(
        verifyBackupIntegrity(backup, state),
        /digest mismatch/u,
      );
    }));
}

test("v1, unknown schema, missing parts and changed RPC count fail closed", () =>
  fixture(async (backup, state) => {
    for (const patch of [
      { format: "supabase-logical-v1" },
      { rpc: undefined },
      { schemas: ["public"] },
      { rpc: { ...backup.rpc, count: 40 } },
    ]) {
      await assert.rejects(
        verifyBackupIntegrity({ ...backup, ...patch }, state),
      );
    }
  }));

test("backup paths cannot escape the state directory or alias another part", () =>
  fixture(async (backup, state) => {
    await assert.rejects(
      verifyBackupIntegrity(backup, join(tmpdir(), "state.json")),
      /beside/u,
    );
    await assert.rejects(
      verifyBackupIntegrity(
        { ...backup, rpc: { ...backup.rpc, path: backup.schema.path } },
        state,
      ),
      /distinct/u,
    );
  }));
