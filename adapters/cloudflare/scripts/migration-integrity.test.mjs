import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  renderMigrationManifest,
  renderRuntimeMigrationManifest,
  verifyMigrationManifest,
  writeMigrationManifest,
} from "./migration-integrity.mjs";

const ZERO = "0".repeat(64);
const temporaryRoots = [];

function digest(content) {
  return createHash("sha256").update(content).digest("hex");
}

function ledgerInsert(sequence, file, algorithm, checksum) {
  return `INSERT INTO one_fetch_migrations (sequence, file, checksum_algorithm, checksum)\nVALUES (${sequence}, '${file}', '${algorithm}', '${checksum}');\n`;
}

function bootstrapMigration(legacyContent) {
  return `-- one-fetch-self-checksum-v1: ${ZERO}\nCREATE TABLE one_fetch_migrations (\n  sequence INTEGER PRIMARY KEY,\n  file TEXT NOT NULL UNIQUE,\n  checksum_algorithm TEXT NOT NULL,\n  checksum TEXT NOT NULL,\n  applied_at TEXT NOT NULL\n);\n\n${ledgerInsert(1, "0001_first.sql", "sha256", digest(legacyContent))}\n${ledgerInsert(2, "0002_migration_integrity.sql", "self-zeroed-sha256-v1", ZERO)}`;
}

function appendedMigration(sequence, file) {
  return `-- one-fetch-self-checksum-v1: ${ZERO}\nSELECT ${sequence};\n\n${ledgerInsert(sequence, file, "self-zeroed-sha256-v1", ZERO)}`;
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-d1-integrity-"));
  temporaryRoots.push(root);
  const migrationsDirectory = join(root, "migrations");
  const manifestPath = join(root, "migration-manifest.json");
  const runtimeManifestPath = join(root, "migration-manifest.ts");
  await mkdir(migrationsDirectory);
  const legacy = "SELECT 1;\n";
  await writeFile(join(migrationsDirectory, "0001_first.sql"), legacy);
  await writeFile(
    join(migrationsDirectory, "0002_migration_integrity.sql"),
    bootstrapMigration(legacy),
  );
  return { root, manifestPath, migrationsDirectory, runtimeManifestPath };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

test("generation finalizes self checksums and writes canonical outputs", async () => {
  const fixture = await createFixture();
  const legacyBefore = await readFile(
    join(fixture.migrationsDirectory, "0001_first.sql"),
  );

  const manifest = await writeMigrationManifest(fixture);

  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.migrations[0].checksum, digest(legacyBefore));
  assert.notEqual(manifest.migrations[1].checksum, ZERO);
  assert.equal(
    await readFile(fixture.manifestPath, "utf8"),
    renderMigrationManifest(manifest),
  );
  assert.equal(
    await readFile(fixture.runtimeManifestPath, "utf8"),
    renderRuntimeMigrationManifest(manifest),
  );
  assert.deepEqual(
    await readFile(join(fixture.migrationsDirectory, "0001_first.sql")),
    legacyBefore,
  );
  await assert.doesNotReject(verifyMigrationManifest(fixture));
});

test("write mode refuses to rewrite a recorded migration", async () => {
  const fixture = await createFixture();
  await writeMigrationManifest(fixture);
  await appendFile(
    join(fixture.migrationsDirectory, "0001_first.sql"),
    "-- changed\n",
  );

  await assert.rejects(
    writeMigrationManifest(fixture),
    /Embedded migration checksum is stale|Applied migration is immutable/u,
  );
});

test("check mode rejects a one-byte migration change", async () => {
  const fixture = await createFixture();
  await writeMigrationManifest(fixture);
  const bootstrap = join(
    fixture.migrationsDirectory,
    "0002_migration_integrity.sql",
  );
  await appendFile(bootstrap, " ");

  await assert.rejects(
    verifyMigrationManifest(fixture),
    /Embedded migration checksum is stale/u,
  );
});

test("generation rejects a UTF-8 BOM without writing outputs", async () => {
  const fixture = await createFixture();
  const legacyPath = join(fixture.migrationsDirectory, "0001_first.sql");
  await writeFile(
    legacyPath,
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      await readFile(legacyPath),
    ]),
  );

  await assert.rejects(writeMigrationManifest(fixture), /UTF-8 BOM/u);
  await assert.rejects(readFile(fixture.manifestPath), /ENOENT/u);
  await assert.rejects(readFile(fixture.runtimeManifestPath), /ENOENT/u);
});

test("a future migration appends without rewriting old migrations", async () => {
  const fixture = await createFixture();
  const first = await writeMigrationManifest(fixture);
  const oldBytes = await Promise.all(
    first.migrations.map(({ file }) =>
      readFile(join(fixture.migrationsDirectory, file)),
    ),
  );
  const file = "0003_future.sql";
  await writeFile(
    join(fixture.migrationsDirectory, file),
    appendedMigration(3, file),
  );

  const second = await writeMigrationManifest(fixture);

  assert.equal(second.migrations.length, 3);
  assert.notEqual(second.migrations[2].checksum, ZERO);
  for (const [index, bytes] of oldBytes.entries()) {
    assert.deepEqual(
      await readFile(
        join(fixture.migrationsDirectory, first.migrations[index].file),
      ),
      bytes,
    );
  }
});

test("renames, missing markers, and stale runtime output fail closed", async () => {
  const renamed = await createFixture();
  await assert.rejects(
    rename(
      join(renamed.migrationsDirectory, "0001_first.sql"),
      join(renamed.migrationsDirectory, "0001_renamed.sql"),
    ).then(() => writeMigrationManifest(renamed)),
    /Missing migration ledger row/u,
  );

  const missingMarker = await createFixture();
  const bootstrap = join(
    missingMarker.migrationsDirectory,
    "0002_migration_integrity.sql",
  );
  await writeFile(
    bootstrap,
    (await readFile(bootstrap, "utf8")).replace(
      `-- one-fetch-self-checksum-v1: ${ZERO}\n`,
      "",
    ),
  );
  await assert.rejects(
    writeMigrationManifest(missingMarker),
    /checksum marker boundary is invalid/u,
  );
  await assert.rejects(readFile(missingMarker.manifestPath), /ENOENT/u);

  const staleRuntime = await createFixture();
  await writeMigrationManifest(staleRuntime);
  await writeFile(staleRuntime.runtimeManifestPath, "// stale\n");
  await assert.rejects(
    verifyMigrationManifest(staleRuntime),
    /Runtime migration manifest is stale/u,
  );
});
