import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  applyNodeDeployment,
  assertDeploymentRuntime,
  assertSafeArchiveEntries,
  createNodeDeploymentPlan,
  rollbackNodeDeployment,
  safeDeploymentRoot,
  verifyNodeDeployment,
} from "./node.mjs";

import {
  archiveFixture,
  fakeControl,
  initializeDatabase,
} from "./node-test-fixtures.mjs";

test("Node deployment boundaries reject unsafe runtimes, roots, and archives", () => {
  assert.doesNotThrow(() => assertDeploymentRuntime("24.20.0"));
  assert.doesNotThrow(() => assertDeploymentRuntime("26.9.0"));
  assert.throws(() => assertDeploymentRuntime("24.19.9"), /24\.20\.0/u);
  assert.throws(() => assertDeploymentRuntime("27.0.0"), /<27/u);
  assert.throws(() => safeDeploymentRoot("/"), /dedicated/u);
  assert.throws(
    () => assertSafeArchiveEntries(["one-fetch/../secret"]),
    /Unsafe/u,
  );
  assert.throws(
    () => assertSafeArchiveEntries(["one-fetch/file"], "lrwxr-xr-x link"),
    /symbolic/u,
  );
});

test("Node install, guarded update, verification, and binary rollback are executable", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "one-fetch-node-deploy-"));
  const root = join(temporary, "installation");
  const control = await fakeControl();
  try {
    const first = await archiveFixture(temporary, "0.1.0");
    const firstPlan = await createNodeDeploymentPlan({
      root,
      archive: first.archive,
      sha256: first.sha256,
      expectedVersion: "none",
    });
    assert.equal(firstPlan.action, "install");
    await applyNodeDeployment({
      root,
      archive: first.archive,
      sha256: first.sha256,
      expectedVersion: "none",
    });
    const database = join(root, "data", "one-fetch.sqlite");
    await mkdir(join(root, "data"), { recursive: true });
    initializeDatabase(database);
    control.observeConfiguration((value) => {
      const connection = new DatabaseSync(database);
      try {
        connection
          .prepare("UPDATE instance_config SET value_json = ? WHERE key = ?")
          .run(JSON.stringify(value), "configuration");
      } finally {
        connection.close();
      }
    });

    const tokenFile = join(temporary, "admin-token");
    await writeFile(tokenFile, control.token, { mode: 0o600 });
    const second = await archiveFixture(temporary, "0.1.1");
    const updated = await applyNodeDeployment({
      root,
      archive: second.archive,
      sha256: second.sha256,
      expectedVersion: "0.1.0",
      database,
      controlUrl: control.controlUrl,
      adminTokenFile: tokenFile,
    });
    assert.equal(updated.state, "restart-required");
    assert.equal(updated.previousVersion, "0.1.0");
    assert.equal(control.isPaused(), true);
    const backupDirectory = join(root, "backups");
    assert.equal((await readdir(backupDirectory)).length, 1);

    control.setBuildVersion("0.1.1");
    const verified = await verifyNodeDeployment({
      root,
      database,
      controlUrl: control.controlUrl,
      adminTokenFile: tokenFile,
      resume: true,
    });
    assert.equal(verified.runningBuildVersion, "0.1.1");
    assert.equal(control.isPaused(), false);

    const rolledBack = await rollbackNodeDeployment({
      root,
      database,
      controlUrl: control.controlUrl,
      adminTokenFile: tokenFile,
      expectedVersion: "0.1.1",
    });
    assert.equal(rolledBack.version, "0.1.0");
    assert.equal(rolledBack.databaseRestored, false);
    assert.equal(control.isPaused(), true);
    control.setBuildVersion("0.1.0");
    const undoneRollback = await rollbackNodeDeployment({
      root,
      database,
      controlUrl: control.controlUrl,
      adminTokenFile: tokenFile,
      expectedVersion: "0.1.0",
    });
    assert.equal(undoneRollback.version, "0.1.1");
  } finally {
    await control.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
