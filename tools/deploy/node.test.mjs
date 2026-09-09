import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
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

async function archiveFixture(parent, version, databaseSchemaVersion = 1) {
  const source = join(parent, `source-${version}`);
  const root = join(source, "one-fetch");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(
    join(root, "BUILD-METADATA.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      version,
      entrypoint: "dist/cli.js",
      databaseSchemaVersion,
    })}\n`,
  );
  await writeFile(join(root, "dist", "cli.js"), "export {};\n");
  const archive = join(parent, `one-fetch-node-${version}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", source, "one-fetch"]);
  const sha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  return { archive, sha256 };
}

function initializeDatabase(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec(
      "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;",
    );
    database
      .prepare(
        "INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (1, ?, ?)",
      )
      .run("a".repeat(64), new Date().toISOString());
  } finally {
    database.close();
  }
}

async function fakeControl() {
  let paused = false;
  let revision = 1;
  let buildVersion = "0.1.0";
  const token = "admin-test-token-that-is-long-enough";
  const server = createServer(async (request, response) => {
    const url = new globalThis.URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/v1/capabilities") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ buildVersion }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    if (url.pathname === "/api/v1/config" && request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          version: `config-${revision}`,
          gatewayPaused: paused,
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/config/gateway-paused" &&
      request.method === "PUT"
    ) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      paused = JSON.parse(
        globalThis.Buffer.concat(chunks).toString("utf8"),
      ).paused;
      revision += 1;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          version: `config-${revision}`,
          gatewayPaused: paused,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    controlUrl: `http://127.0.0.1:${address.port}`,
    token,
    setBuildVersion(value) {
      buildVersion = value;
    },
    isPaused: () => paused,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

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
  } finally {
    await control.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
