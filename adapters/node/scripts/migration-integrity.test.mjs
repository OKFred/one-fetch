import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
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
  buildMigrationArtifacts,
  renderMigrationManifest,
  renderRuntimeMigrations,
  verifyMigrationArtifacts,
  writeMigrationArtifacts,
} from "./migration-integrity.mjs";

const temporaryRoots = [];
const legacyArtifacts = [
  [1, 3610, "5da4b822723172e7c5d35b7c2f302224d2e7d24a7d71ef949082f74471612fb3"],
  [2, 197, "4bc6c3cf124d9bf83380a418648a9250a58f498c1d12a7127f963487b4b0f78c"],
  [3, 71, "d1e8d70c19372103dc0016570cbbf30a1f66dec5d48f870fce1098429db13213"],
  [4, 542, "c6dcb15f82cc519225eec69e65a14509b0f9a106b75e7b7da0997d771392c5d2"],
  [5, 514, "2ffab6963b937a07d0ba60ac88372f7a8a16abef907fc0e1df5ba4ccabcde57b"],
  [6, 481, "27a9a1ffc8590cbd7c45fa987e0494b20b88df40773b4dadb4cd58c2d0cc6991"],
  [7, 93, "3d5e3a368b864625408360cbe8b54def73b34b94935cd56d751328753cad07ad"],
];

async function createFixture(files = ["SELECT 1;\n", "SELECT 2;\n"]) {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-node-migrations-"));
  temporaryRoots.push(root);
  const migrationsDirectory = join(root, "migrations");
  const manifestPath = join(root, "migration-manifest.json");
  const runtimeManifestPath = join(root, "generated", "database-migrations.ts");
  await mkdir(migrationsDirectory);
  for (const [index, sql] of files.entries()) {
    await writeFile(
      join(
        migrationsDirectory,
        `${String(index + 1).padStart(4, "0")}_migration_${index + 1}.sql`,
      ),
      sql,
    );
  }
  return { migrationsDirectory, manifestPath, runtimeManifestPath };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

test("checked-in artifacts preserve all seven legacy SQL byte digests", async () => {
  const { manifest, migrations } = await buildMigrationArtifacts();
  assert.deepEqual(
    migrations.map(({ version, bytes, artifactSha256 }) => [
      version,
      bytes,
      artifactSha256,
    ]),
    legacyArtifacts,
  );
  assert.equal(manifest.migrations.length, 7);
  assert.equal(Buffer.byteLength(migrations[0].sql, "utf8"), 3610);
});

test("first generation writes canonical audit and runtime artifacts", async () => {
  const fixture = await createFixture();
  const manifest = await writeMigrationArtifacts(fixture);
  const built = await buildMigrationArtifacts(fixture);

  assert.equal(
    await readFile(fixture.manifestPath, "utf8"),
    renderMigrationManifest(manifest),
  );
  assert.equal(
    await readFile(fixture.runtimeManifestPath, "utf8"),
    renderRuntimeMigrations(built.migrations),
  );
  assert.equal(built.migrations[0].sql, "SELECT 1;\n");
  await assert.doesNotReject(verifyMigrationArtifacts(fixture));
});

test("check and write modes reject a recorded migration rewrite without changing outputs", async () => {
  const fixture = await createFixture();
  await writeMigrationArtifacts(fixture);
  const manifestBefore = await readFile(fixture.manifestPath);
  const runtimeBefore = await readFile(fixture.runtimeManifestPath);
  await appendFile(
    join(fixture.migrationsDirectory, "0001_migration_1.sql"),
    "-- changed\n",
  );

  await assert.rejects(verifyMigrationArtifacts(fixture), /missing or stale/u);
  await assert.rejects(
    writeMigrationArtifacts(fixture),
    /Recorded Node migration is immutable/u,
  );
  assert.deepEqual(await readFile(fixture.manifestPath), manifestBefore);
  assert.deepEqual(await readFile(fixture.runtimeManifestPath), runtimeBefore);
});

test("deletion, rename, numbering gaps, and UTF-8 BOM fail closed", async () => {
  const deleted = await createFixture();
  await writeMigrationArtifacts(deleted);
  await rm(join(deleted.migrationsDirectory, "0002_migration_2.sql"));
  await assert.rejects(
    writeMigrationArtifacts(deleted),
    /must not be deleted|contiguous/u,
  );

  const renamed = await createFixture();
  await writeMigrationArtifacts(renamed);
  await rename(
    join(renamed.migrationsDirectory, "0002_migration_2.sql"),
    join(renamed.migrationsDirectory, "0002_renamed.sql"),
  );
  await assert.rejects(writeMigrationArtifacts(renamed), /immutable/u);

  const gap = await createFixture(["SELECT 1;\n"]);
  await writeFile(join(gap.migrationsDirectory, "0003_gap.sql"), "SELECT 3;\n");
  await assert.rejects(
    writeMigrationArtifacts(gap),
    /versions must be contiguous/u,
  );

  const bom = await createFixture([
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("SELECT 1;\n"),
    ]),
  ]);
  await assert.rejects(
    writeMigrationArtifacts(bom),
    /must not contain a UTF-8 BOM/u,
  );
});

test("a future migration appends without rewriting prior SQL artifacts", async () => {
  const fixture = await createFixture();
  const first = await writeMigrationArtifacts(fixture);
  const oldSql = await Promise.all(
    first.migrations.map(({ file }) =>
      readFile(join(fixture.migrationsDirectory, file)),
    ),
  );
  await writeFile(
    join(fixture.migrationsDirectory, "0003_future.sql"),
    "SELECT 3;\n",
  );

  const second = await writeMigrationArtifacts(fixture);
  assert.equal(second.migrations.length, 3);
  for (const [index, bytes] of oldSql.entries()) {
    assert.deepEqual(
      await readFile(
        join(fixture.migrationsDirectory, second.migrations[index].file),
      ),
      bytes,
    );
  }
  await assert.doesNotReject(verifyMigrationArtifacts(fixture));
});
