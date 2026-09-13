import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import {
  applyNodeDeployment,
  rollbackNodeDeployment,
  verifyNodeDeployment,
  withNodeDeploymentLock,
} from "./node.mjs";
import {
  archiveFixture,
  fakeControl,
  initializeDatabase,
} from "./node-test-fixtures.mjs";

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "one-fetch-update-guard-"));
  const root = join(temporary, "installation");
  const control = await fakeControl();
  t.after(async () => {
    await control.close();
    await rm(temporary, { recursive: true, force: true });
  });
  const first = await archiveFixture(temporary, "0.1.0");
  await applyNodeDeployment({ root, ...first, expectedVersion: "none" });
  await mkdir(join(root, "data"));
  const database = join(root, "data/one-fetch.sqlite");
  initializeDatabase(database);
  const mutateDatabase = (work) => {
    const db = new DatabaseSync(database);
    try {
      work(db);
    } finally {
      db.close();
    }
  };
  control.observeConfiguration((config) =>
    mutateDatabase((db) =>
      db
        .prepare(
          "UPDATE instance_config SET value_json = ? WHERE key = 'configuration'",
        )
        .run(JSON.stringify(config)),
    ),
  );
  const adminTokenFile = join(temporary, "synthetic-token");
  await writeFile(adminTokenFile, control.token, { mode: 0o600 });
  const second = await archiveFixture(temporary, "0.1.1");
  const options = {
    root,
    ...second,
    database,
    adminTokenFile,
    controlUrl: control.controlUrl,
    expectedVersion: "0.1.0",
  };
  const pointer = join(root, "current.json");
  const original = await readFile(pointer, "utf8");
  const calls = [];
  const fetch = globalThis.fetch;
  let afterResponse = async (_url, _init, response) => response;
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ path: new URL(url).pathname, method: init.method ?? "GET" });
    return afterResponse(String(url), init, await fetch(url, init));
  });
  return {
    temporary,
    root,
    control,
    pointer,
    original,
    options,
    calls,
    mutateDatabase,
    intercept: (fn) => {
      afterResponse = fn;
    },
  };
}

test("all mutating commands respect the same held root lock", async (t) => {
  const f = await fixture(t);
  await withNodeDeploymentLock(f.root, "apply", async () => {
    for (const operation of [
      () => applyNodeDeployment(f.options),
      () => verifyNodeDeployment({ ...f.options, resume: true }),
      () => rollbackNodeDeployment(f.options),
    ])
      await assert.rejects(operation(), /locked/u);
  });
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(f.pointer, "utf8"), f.original);
});

test("a new archive cannot rewrite an already-applied migration", async (t) => {
  const f = await fixture(t);
  const replacement = await archiveFixture(
    f.temporary,
    "0.1.2",
    1,
    "-- different recorded migration\n",
  );
  await assert.rejects(
    applyNodeDeployment({ ...f.options, ...replacement }),
    /rewrite/u,
  );
  assert.equal(f.control.isPaused(), true);
  assert.equal(await readFile(f.pointer, "utf8"), f.original);
  // Retain the rejected, owned candidate for diagnosis; never select it.
  assert.ok((await readdir(join(f.root, "versions"))).includes("0.1.2"));
});

test("two real first-install processes have exactly one winner", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "one-fetch-install-race-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "installation");
  const archive = await archiveFixture(temporary, "0.1.0");
  const child = () =>
    spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./node.mjs", import.meta.url)),
        "--mode",
        "apply",
        "--root",
        root,
        "--archive",
        archive.archive,
        "--sha256",
        archive.sha256,
        "--expected-version",
        "none",
      ],
      { stdio: "ignore", windowsHide: true, timeout: 10000 },
    );
  const first = child();
  const second = child();
  const outcomes = await Promise.all([
    once(first, "close"),
    once(second, "close"),
  ]);
  assert.deepEqual(outcomes.map(([code]) => code).sort(), [0, 1]);
  assert.equal(
    JSON.parse(await readFile(join(root, "current.json"))).archiveSha256,
    archive.sha256,
  );
  assert.deepEqual(await readdir(join(root, "versions")), ["0.1.0"]);
  await assert.rejects(readFile(join(root, ".deployment-lock.json")), {
    code: "ENOENT",
  });
});

for (const kind of [
  "expected-version",
  "missing-database",
  "changed-ledger",
  "foreign-control",
  "config-identity",
  "config-revision",
  "changed-pointer",
]) {
  test(`update rejects ${kind} before pause or activation`, async (t) => {
    const f = await fixture(t);
    let expectedPointer = f.original;
    if (kind === "expected-version") f.options.expectedVersion = "0.0.9";
    if (kind === "missing-database") await rm(f.options.database);
    if (kind === "changed-ledger")
      f.mutateDatabase((db) => db.exec("DELETE FROM schema_migrations"));
    f.intercept(async (url, _init, response) => {
      if (kind === "foreign-control" && url.endsWith("/capabilities"))
        return globalThis.Response.json({
          ...(await response.json()),
          instanceId: "other-instance",
        });
      if (kind.startsWith("config-") && url.endsWith("/config"))
        return globalThis.Response.json({
          ...(await response.json()),
          ...(kind === "config-revision"
            ? { version: "changed" }
            : { instanceId: "other-instance" }),
        });
      if (kind === "changed-pointer" && url.endsWith("/capabilities")) {
        expectedPointer = JSON.stringify({
          ...JSON.parse(f.original),
          archiveSha256: "b".repeat(64),
        });
        await writeFile(f.pointer, expectedPointer);
      }
      return response;
    });
    await assert.rejects(applyNodeDeployment(f.options));
    assert.equal(
      f.calls.some((call) => call.method === "PUT"),
      false,
    );
    assert.equal(await readFile(f.pointer, "utf8"), expectedPointer);
    assert.deepEqual(await readdir(join(f.root, "versions")), ["0.1.0"]);
  });
}

for (const kind of ["pointer", "lock", "ledger", "backup-identity"]) {
  test(`a changed ${kind} after pause leaves the old build selected and Gateway paused`, async (t) => {
    const f = await fixture(t);
    let expectedPointer = f.original;
    f.intercept(async (_url, init, response) => {
      if (init.method !== "PUT") return response;
      if (kind === "pointer") {
        expectedPointer = JSON.stringify({
          ...JSON.parse(f.original),
          archiveSha256: "d".repeat(64),
        });
        await writeFile(f.pointer, expectedPointer);
      }
      if (kind === "lock")
        await writeFile(
          join(f.root, ".deployment-lock.json"),
          JSON.stringify({ schemaVersion: 1, owner: "replacement-owner" }),
        );
      if (kind === "ledger")
        f.mutateDatabase((db) =>
          db.exec("UPDATE schema_migrations SET checksum = 'corrupt'"),
        );
      if (kind === "backup-identity")
        f.mutateDatabase((db) =>
          db.prepare("UPDATE instance_config SET value_json = ?").run(
            JSON.stringify({
              instanceId: "other-instance",
              controlGatewayPairId: "other-pair",
              version: "other-config",
            }),
          ),
        );
      return response;
    });
    await assert.rejects(applyNodeDeployment(f.options));
    assert.equal(f.control.isPaused(), true);
    assert.equal(await readFile(f.pointer, "utf8"), expectedPointer);
    assert.deepEqual(await readdir(join(f.root, "versions")), ["0.1.0"]);
    if (kind === "lock")
      assert.equal(
        JSON.parse(await readFile(join(f.root, ".deployment-lock.json"))).owner,
        "replacement-owner",
      );
  });
}

test("rollback validates the retained migration bytes before any pause write", async (t) => {
  const f = await fixture(t);
  await applyNodeDeployment(f.options);
  f.control.setBuildVersion("0.1.1");
  await verifyNodeDeployment({ ...f.options, resume: true });
  f.calls.length = 0;
  const snapshot = await readFile(f.pointer, "utf8");
  await writeFile(
    join(f.root, "versions/0.1.0/migrations/0001_fixture.sql"),
    "changed retained SQL",
  );
  await assert.rejects(
    rollbackNodeDeployment({ ...f.options, expectedVersion: "0.1.1" }),
  );
  assert.equal(
    f.calls.some((call) => call.method === "PUT"),
    false,
  );
  assert.equal(f.control.isPaused(), false);
  assert.equal(await readFile(f.pointer, "utf8"), snapshot);
});
