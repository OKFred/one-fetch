import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { verifyNodeDeployment } from "./node.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-node-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "versions", "0.1.0");
  const database = join(root, "data", "one-fetch.sqlite");
  const identity = {
    instanceId: "synthetic-instance",
    controlGatewayPairId: "synthetic-pair",
    version: "config-1",
  };
  const capabilities = {
    protocolVersion: 1,
    provider: "node",
    buildVersion: "0.1.0",
    instanceId: identity.instanceId,
    controlGatewayPairId: identity.controlGatewayPairId,
    configVersion: identity.version,
  };
  const json = (path, value) => writeFile(path, JSON.stringify(value));
  await mkdir(join(directory, "migrations"), { recursive: true });
  await mkdir(join(root, "data"));
  await json(join(root, "current.json"), {
    schemaVersion: 1,
    version: "0.1.0",
    directory: "versions/0.1.0",
    archiveSha256: "a".repeat(64),
  });
  await json(join(directory, "BUILD-METADATA.json"), {
    schemaVersion: 1,
    version: "0.1.0",
    entrypoint: "dist/cli.js",
    databaseSchemaVersion: 2,
  });
  const migrations = [];
  for (let version = 1; version <= 2; version++) {
    const sql = `-- synthetic migration ${version}\n`;
    const file = `${String(version).padStart(4, "0")}_fixture.sql`;
    await writeFile(join(directory, "migrations", file), sql);
    migrations.push({
      version,
      file,
      bytes: Buffer.byteLength(sql),
      artifactSha256: createHash("sha256").update(sql).digest("hex"),
    });
  }
  await json(join(directory, "migration-manifest.json"), {
    schemaVersion: 1,
    hashAlgorithm: "sha256",
    migrationsDirectory: "migrations",
    migrations,
  });
  const mutate = (callback) => {
    const db = new DatabaseSync(database);
    try {
      return callback(db);
    } finally {
      db.close();
    }
  };
  mutate((db) => {
    db.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT; CREATE TABLE instance_config(key TEXT PRIMARY KEY, value_json TEXT NOT NULL) STRICT;",
    );
    for (const migration of migrations)
      db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(
        migration.version,
        migration.artifactSha256,
        new Date().toISOString(),
      );
    db.prepare("INSERT INTO instance_config VALUES (?, ?)").run(
      "configuration",
      JSON.stringify(identity),
    );
  });
  const adminTokenFile = join(root, "synthetic-admin-token");
  await writeFile(adminTokenFile, "synthetic-admin-token-not-a-real-secret", {
    mode: 0o600,
  });
  const options = {
    root,
    database,
    controlUrl: "http://127.0.0.1:9999",
    adminTokenFile,
    resume: true,
  };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ pathname: new globalThis.URL(url).pathname, init });
    if (String(url).endsWith("/capabilities"))
      return globalThis.Response.json(capabilities);
    if (init.method === "PUT")
      return globalThis.Response.json({
        ...identity,
        version: "config-2",
        gatewayPaused: false,
      });
    return globalThis.Response.json({ ...identity, gatewayPaused: true });
  });
  return {
    root,
    directory,
    database,
    identity,
    capabilities,
    options,
    calls,
    mutate,
  };
}

test("offline checks are not reported as a verified running deployment", async (t) => {
  const f = await fixture(t);
  const result = await verifyNodeDeployment({ root: f.root });
  assert.equal(result.state, "offline-verified");
  assert.equal(result.runtimeVerified, false);
  assert.equal(result.databaseSchemaVersion, 2);
  assert.equal(f.calls.length, 0);
});

test("a matching runtime and complete local ledger can be explicitly resumed", async (t) => {
  const f = await fixture(t);
  const result = await verifyNodeDeployment(f.options);
  assert.equal(result.state, "verified");
  assert.equal(result.runtimeVerified, true);
  assert.equal(result.gatewayResumed, true);
  assert.equal(f.calls.filter(({ init }) => init.method === "PUT").length, 1);
});

const mutations = {
  "missing database": (f) => rm(f.database),
  "ledger gap": (f) =>
    f.mutate((db) =>
      db.exec("DELETE FROM schema_migrations WHERE version = 1"),
    ),
  "newer schema": (f) =>
    f.mutate((db) =>
      db
        .prepare("INSERT INTO schema_migrations VALUES (3, ?, ?)")
        .run("a".repeat(64), new Date().toISOString()),
    ),
  "changed checksum": (f) =>
    f.mutate((db) =>
      db
        .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
        .run("a".repeat(64)),
    ),
  "changed SQL artifact": (f) =>
    writeFile(
      join(f.directory, "migrations", "0001_fixture.sql"),
      "-- changed\n",
    ),
  "missing manifest": (f) => rm(join(f.directory, "migration-manifest.json")),
  "missing identity": (f) =>
    f.mutate((db) => db.exec("DELETE FROM instance_config")),
  "invalid identity JSON": (f) =>
    f.mutate((db) =>
      db
        .prepare("UPDATE instance_config SET value_json = ?")
        .run("private-canary-invalid-json"),
    ),
  "missing pair": (f) =>
    f.mutate((db) =>
      db
        .prepare("UPDATE instance_config SET value_json = ?")
        .run(
          JSON.stringify({
            instanceId: f.identity.instanceId,
            version: "config-1",
          }),
        ),
    ),
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`verification refuses ${name} without resuming or repairing storage`, async (t) => {
    const f = await fixture(t);
    await mutate(f);
    const before = await readFile(f.database).catch(() => undefined);
    await assert.rejects(
      verifyNodeDeployment(f.options),
      (error) => !error.message.includes("private-canary"),
    );
    assert.equal(
      f.calls.some(({ init }) => init.method === "PUT"),
      false,
    );
    assert.deepEqual(await readFile(f.database).catch(() => undefined), before);
  });
}

for (const [field, value] of Object.entries({
  instanceId: "other-instance",
  controlGatewayPairId: "other-pair",
  configVersion: "other-config",
  buildVersion: "0.1.1",
  protocolVersion: 2,
  provider: "supabase",
})) {
  test(`verification refuses mismatched ${field} before resume`, async (t) => {
    const f = await fixture(t);
    f.capabilities[field] = value;
    await assert.rejects(verifyNodeDeployment(f.options));
    assert.equal(
      f.calls.some(({ init }) => init.method === "PUT"),
      false,
    );
  });
}
