import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const adapterRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = resolve(adapterRoot, "scripts", "sync-migrations.mjs");

function run(root, mode) {
  return spawnSync(process.execPath, [script, mode, "--root", root], {
    encoding: "utf8",
  });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-supabase-migrations-"));
  const migrations = join(root, "supabase", "migrations");
  const shared = join(root, "supabase", "functions", "_shared");
  const tests = join(root, "supabase", "tests");
  await Promise.all([
    mkdir(shared, { recursive: true }),
    mkdir(tests, { recursive: true }),
    cp(resolve(adapterRoot, "supabase", "migrations"), migrations, {
      recursive: true,
    }),
  ]);
  await Promise.all([
    copyFile(
      resolve(
        adapterRoot,
        "supabase/functions/_shared/migration-manifest.generated.ts",
      ),
      join(shared, "migration-manifest.generated.ts"),
    ),
    copyFile(
      resolve(adapterRoot, "supabase/tests/migration_integrity.sql"),
      join(tests, "migration_integrity.sql"),
    ),
  ]);
  return {
    root,
    migrations,
    manifest: join(shared, "migration-manifest.generated.ts"),
    test: join(tests, "migration_integrity.sql"),
  };
}

async function withFixture(runTest) {
  const paths = await fixture();
  try {
    await runTest(paths);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
}

test("current migration checksums and generated assets are exact", () => {
  const result = run(adapterRoot, "--check");
  assert.equal(result.status, 0, result.stderr);
});

test("a byte change fails before stale generated assets can be accepted", async () => {
  await withFixture(async ({ root, migrations }) => {
    const path = join(migrations, "202609040001_schema.sql");
    await writeFile(path, `${await readFile(path, "utf8")}-- tampered\n`);
    const result = run(root, "--check");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stale embedded checksum/u);
  });
});

test("a future migration appends without rewriting prior migrations", async () => {
  await withFixture(async ({ root, migrations, manifest }) => {
    const prior = new Map();
    for (const name of [
      "202609040001_schema.sql",
      "202609040009_migration_integrity.sql",
    ]) {
      prior.set(name, digest(await readFile(join(migrations, name))));
    }
    await writeFile(
      join(migrations, "202609040010_future.sql"),
      `begin;
create table one_fetch.future_probe (id bigint primary key);
-- one-fetch-self-checksum-v1: 0000000000000000000000000000000000000000000000000000000000000000
insert into one_fetch.migration_history (version, checksum)
values ('202609040010', '0000000000000000000000000000000000000000000000000000000000000000');
commit;
`,
    );

    const written = run(root, "--write");
    assert.equal(written.status, 0, written.stderr);
    const checked = run(root, "--check");
    assert.equal(checked.status, 0, checked.stderr);
    for (const [name, expected] of prior) {
      assert.equal(digest(await readFile(join(migrations, name))), expected);
    }
    const generated = await readFile(manifest, "utf8");
    const future = await readFile(join(migrations, "202609040010_future.sql"));
    assert.match(generated, /202609040010_future\.sql/u);
    assert.match(generated, /self-zeroed-sha256-v1/u);
    assert.ok(generated.includes(digest(future)));
  });
});

test("the manifest binds the complete migration filename", async () => {
  await withFixture(async ({ root, migrations }) => {
    await rename(
      join(migrations, "202609040009_migration_integrity.sql"),
      join(migrations, "202609040009_renamed.sql"),
    );
    const result = run(root, "--check");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /migration-manifest\.generated\.ts.*stale/u);
  });
});

test("a missing self-checksum marker is rejected without writing outputs", async () => {
  await withFixture(async ({ root, migrations, manifest }) => {
    const before = await readFile(manifest);
    await writeFile(
      join(migrations, "202609040010_missing_marker.sql"),
      "begin; select 1; commit;\n",
    );
    const result = run(root, "--write");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one self-zeroed-sha256-v1 marker/u);
    assert.deepEqual(await readFile(manifest), before);
  });
});
