import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertResumeMigrationIntegrity,
  expectedMigrationIntegrity,
} from "./supabase-resume.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-resume-fixture-"));
  const migrations = join(root, "supabase", "migrations");
  await mkdir(migrations, { recursive: true });
  await writeFile(
    join(migrations, "202609040001_schema.sql"),
    `select 1;\n-- one-fetch-self-checksum-v1: ${"a".repeat(64)}\n`,
  );
  return root;
}

test("failed first-install resume requires an exact migration ledger", async () => {
  const adapterRoot = await fixture();
  try {
    const expected = await expectedMigrationIntegrity(adapterRoot);
    assert.deepEqual(expected, [
      { version: "202609040001", checksum: "a".repeat(64) },
    ]);
    await assert.doesNotReject(
      assertResumeMigrationIntegrity({
        adapterRoot,
        rpc: async () => expected,
      }),
    );
    await assert.rejects(
      assertResumeMigrationIntegrity({
        adapterRoot,
        rpc: async () => [],
      }),
      /exact one-fetch migration ledger/u,
    );
    await assert.rejects(
      assertResumeMigrationIntegrity({
        adapterRoot,
        rpc: async () => [{ ...expected[0], unexpected: true }],
      }),
      /exact one-fetch migration ledger/u,
    );
  } finally {
    await rm(adapterRoot, { recursive: true, force: true });
  }
});
