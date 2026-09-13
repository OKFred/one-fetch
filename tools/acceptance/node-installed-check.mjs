import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  webcrypto,
} from "node:crypto";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync, backup } from "node:sqlite";
import { pathToFileURL } from "node:url";

const root = "/tmp/installed";
const database = "/var/lib/one-fetch/one-fetch.sqlite";
const controlUrl = "http://127.0.0.1:8787";
const report = {
  schemaVersion: 1,
  passed: false,
  databaseRestoredInPlace: false,
};
let phase = "load-installed-helper";
let restoredServer;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function request(url, token) {
  const response = await globalThis.fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function rejectVerification(verify, options) {
  let rejected = false;
  try {
    await verify(options);
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
}

try {
  const { verifyNodeDeployment } = await import(
    pathToFileURL("/deployment.mjs").href
  );
  const pointerBytes = await readFile(join(root, "current.json"));
  const pointer = JSON.parse(pointerBytes);
  assert.match(
    pointer.directory,
    /^versions\/0\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u,
  );
  const installed = join(root, pointer.directory);
  phase = "offline-verification";
  const offline = await verifyNodeDeployment({ root, database });
  assert.equal(offline.state, "offline-verified");
  assert.equal(offline.runtimeVerified, false);
  report.offlineVerified = true;
  phase = "runtime-identity";
  const online = await verifyNodeDeployment({ root, database, controlUrl });
  assert.equal(online.state, "verified");
  assert.equal(online.runtimeVerified, true);
  report.runningIdentityVerified = true;
  report.databaseSchemaVersion = online.databaseSchemaVersion;
  phase = "missing-database";
  await rejectVerification(verifyNodeDeployment, {
    root,
    database: "/tmp/missing-database.sqlite",
    controlUrl,
  });
  report.missingDatabaseRejected = true;

  phase = "isolated-online-backup";
  const recovery = "/var/lib/one-fetch/recovery";
  await mkdir(recovery, { mode: 0o700 });
  const snapshot = join(recovery, "snapshot.sqlite");
  const source = new DatabaseSync(database, { readOnly: true });
  try {
    await backup(source, snapshot);
  } finally {
    source.close();
  }
  await chmod(snapshot, 0o600);
  report.backupSha256 = createHash("sha256")
    .update(await readFile(snapshot))
    .digest("hex");
  const restored = join(recovery, "restored.sqlite");
  await copyFile(snapshot, restored);
  await chmod(restored, 0o600);
  assert.equal(
    (await verifyNodeDeployment({ root, database: restored })).state,
    "offline-verified",
  );

  phase = "corrupt-ledger";
  const corrupt = join(recovery, "corrupt.sqlite");
  await copyFile(snapshot, corrupt);
  const changed = new DatabaseSync(corrupt);
  try {
    changed
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 1")
      .run("0".repeat(64));
  } finally {
    changed.close();
  }
  await rejectVerification(verifyNodeDeployment, { root, database: corrupt });
  report.corruptLedgerRejected = true;

  phase = "mismatched-instance";
  const foreign = join(recovery, "foreign.sqlite");
  await copyFile(snapshot, foreign);
  const different = new DatabaseSync(foreign);
  try {
    const stored = JSON.parse(
      different
        .prepare("SELECT value_json FROM instance_config WHERE key = ?")
        .get("configuration").value_json,
    );
    different
      .prepare("UPDATE instance_config SET value_json = ? WHERE key = ?")
      .run(
        JSON.stringify({
          ...stored,
          controlGatewayPairId: "different-synthetic-pair",
        }),
        "configuration",
      );
  } finally {
    different.close();
  }
  await rejectVerification(verifyNodeDeployment, {
    root,
    database: foreign,
    controlUrl,
  });
  report.differentInstanceRejected = true;

  phase = "restored-runtime-startup";
  const { startOneFetchNode } = await import(
    pathToFileURL(join(installed, "dist/server.js")).href
  );
  const { loadConfig } = await import(
    pathToFileURL(join(installed, "dist/config.js")).href
  );
  const { classifyOneFetchResponse, verifyAuditEvent } = await import(
    pathToFileURL(join(installed, "node_modules/@one-fetch/core/dist/index.js"))
      .href
  );
  const protocol = await import(
    pathToFileURL(
      join(installed, "node_modules/@one-fetch/protocol/dist/index.js"),
    ).href
  );
  const controlPort = await freePort();
  let gatewayPort = await freePort();
  while (gatewayPort === controlPort) gatewayPort = await freePort();
  const restoredControl = `http://127.0.0.1:${controlPort}`;
  const restoredGateway = `http://127.0.0.1:${gatewayPort}`;
  restoredServer = await startOneFetchNode({
    ...loadConfig(),
    databasePath: restored,
    controlHost: "127.0.0.1",
    gatewayHost: "127.0.0.1",
    controlPort,
    gatewayPort,
    publicControlUrl: restoredControl,
    publicGatewayUrl: restoredGateway,
  });
  assert.equal(restoredServer.bootstrapToken, undefined);
  assert.equal(
    (
      await verifyNodeDeployment({
        root,
        database: restored,
        controlUrl: restoredControl,
      })
    ).state,
    "verified",
  );
  report.isolatedRestoredRuntimeVerified = true;

  phase = "restored-session-and-policy";
  const admin = process.env.ONE_FETCH_ACCEPTANCE_ADMIN_TOKEN;
  const token = process.env.ONE_FETCH_ACCEPTANCE_EXECUTION_TOKEN;
  assert.ok(admin && token);
  const sessions = await request(
    restoredControl + protocol.CONTROL_ROUTES_V1.sessions,
    admin,
  );
  assert.ok(sessions.sessions.length > 0);
  assert.deepEqual(
    await request(restoredControl + "/api/v1/config", admin),
    await request(controlUrl + "/api/v1/config", admin),
  );
  report.originalSessionAndPolicyPreserved = true;

  phase = "restored-revoked-token";
  const metadata = {
    protocolVersion: 1,
    requestId: "restored-denial",
    nonce: randomBytes(16).toString("hex"),
    transport: "http",
    targetOrigin: "http://127.0.0.1:52132",
    targetHeaders: [],
    fetchOptions: { redirect: "follow", timeoutMs: 60_000 },
    body: { sizeBytes: 0 },
    hop: 0,
  };
  const denied = await globalThis.fetch(restoredGateway + "/status/200", {
    headers: {
      [protocol.ONE_FETCH_TOKEN_HEADER]: token,
      [protocol.ONE_FETCH_REQUEST_HEADER]:
        protocol.encodeRequestMetadata(metadata),
    },
    signal: globalThis.AbortSignal.timeout(10_000),
  });
  assert.equal(denied.status, 401);
  const classified = await classifyOneFetchResponse(
    denied.headers.get(protocol.ONE_FETCH_RESPONSE_HEADER),
    { nonce: metadata.nonce, requestId: metadata.requestId, token },
  );
  assert.equal(classified.source, "relay");
  assert.equal(classified.error.code, "unauthorized");
  await denied.arrayBuffer();
  report.revokedExecutionTokenStillDenied = true;

  phase = "restored-audit-signatures";
  const key = createPublicKey(
    createPrivateKey({
      key: Buffer.from(
        process.env.ONE_FETCH_AUDIT_SIGNING_PRIVATE_KEY,
        "base64",
      ),
      format: "der",
      type: "pkcs8",
    }),
  );
  const publicKey = await webcrypto.subtle.importKey(
    "spki",
    key.export({ format: "der", type: "spki" }),
    "Ed25519",
    false,
    ["verify"],
  );
  const events = [];
  let cursor;
  do {
    const page = await request(
      restoredControl +
        "/api/v1/audit?limit=100" +
        (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      admin,
    );
    events.push(...page.events);
    cursor = page.nextCursor;
    assert.ok(events.length < 1000);
  } while (cursor);
  assert.ok(events.length > 10);
  for (const event of events)
    assert.equal(await verifyAuditEvent(event, publicKey), true);
  for (const secret of [admin, token])
    assert.equal(JSON.stringify(events).includes(secret), false);
  report.restoredAuditSignaturesVerified = events.length;
  assert.deepEqual(await readFile(join(root, "current.json")), pointerBytes);
  report.installationPointerUnchanged = true;
  report.passed = true;
} catch {
  report.failurePhase = phase;
} finally {
  try {
    await restoredServer?.close();
  } catch {
    report.passed = false;
    report.failurePhase = "restored-runtime-close";
  }
}
process.stdout.write(JSON.stringify(report) + "\n");
