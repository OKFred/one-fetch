import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createUpgradeSession } from "./upgrade-session.mjs";

const [fromVersion, fromSha256, toVersion, toSha256] = process.argv.slice(2);
for (const version of [fromVersion, toVersion])
  assert.match(version, /^0\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u);
for (const digest of [fromSha256, toSha256])
  assert.match(digest, /^[a-f0-9]{64}$/u);
assert.notEqual(fromVersion, toVersion);
const root = "/tmp/installed";
const database = root + "/data/one-fetch.sqlite";
const adminTokenFile = "/tmp/acceptance/admin-token";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const config = {
  databasePath: database,
  instanceId: "upgrade-synthetic",
  controlHost: "127.0.0.1",
  controlPort: 8787,
  controlAllowedOrigins: [],
  gatewayHost: "127.0.0.1",
  gatewayPort: 8788,
  publicControlUrl: "http://127.0.0.1:8787",
  publicGatewayUrl: "http://127.0.0.1:8788",
  instancePepper: randomBytes(32).toString("base64url"),
  protocolSigningKey: randomBytes(32).toString("base64url"),
  auditSigningPrivateKey: privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64"),
  requestBodyLimitBytes: 20 * 1024 * 1024,
  responseBodyLimitBytes: 20 * 1024 * 1024,
};
const report = {
  schemaVersion: 1,
  passed: false,
  databaseRestoredInPlace: false,
  processKillTested: false,
  schemaChangeTested: false,
  cliLauncherTested: false,
};
let phase = "load-packaged-helper";
let runtime;
let session;
let tokenWritten = false;
const readPointer = async () =>
  JSON.parse(await readFile(join(root, "current.json"), "utf8"));
async function start(version) {
  const directory = join(root, "versions", version);
  const { startOneFetchNode } = await import(
    pathToFileURL(join(directory, "dist/server.js"))
  );
  runtime = await startOneFetchNode(config);
  return directory;
}
try {
  const { applyNodeDeployment, verifyNodeDeployment, rollbackNodeDeployment } =
    await import("/tmp/acceptance/deployment.mjs");
  const options = {
    root,
    database,
    controlUrl: config.publicControlUrl,
    adminTokenFile,
  };
  phase = "published-first-install";
  await applyNodeDeployment({
    root,
    archive: "/tmp/acceptance/old.tar.gz",
    sha256: fromSha256,
    expectedVersion: "none",
  });
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  const directory = await start(fromVersion);
  session = await createUpgradeSession(
    runtime,
    directory,
    config,
    publicKey.export({ format: "der", type: "spki" }),
  );
  await writeFile(adminTokenFile, session.adminToken, {
    flag: "wx",
    mode: 0o600,
  });
  tokenWritten = true;
  await session.assertPreserved(fromVersion, false, false);
  const originalEvents = await session.audit();
  report.publishedBaselineVerified = true;
  phase = "pre-pause-rejections";
  const update = {
    ...options,
    archive: "/tmp/acceptance/new.tar.gz",
    sha256: toSha256,
    expectedVersion: fromVersion,
  };
  await assert.rejects(
    applyNodeDeployment({ ...update, expectedVersion: "0.99.99" }),
    /Expected current/u,
  );
  await assert.rejects(
    applyNodeDeployment({ ...update, sha256: "0".repeat(64) }),
    /SHA-256/u,
  );
  assert.equal((await session.request("/api/v1/config")).gatewayPaused, false);
  assert.equal((await readPointer()).version, fromVersion);
  report.invalidUpdateLeavesTrafficUnchanged = true;

  phase = "protected-update";
  const applied = await applyNodeDeployment(update);
  assert.equal(applied.state, "restart-required");
  assert.equal(applied.gatewayPaused, true);
  assert.equal(applied.recovery.automaticDatabaseRestore, false);
  assert.equal((await readPointer()).version, toVersion);
  const backupPath = join(root, applied.backup.path);
  assert.equal(
    createHash("sha256")
      .update(await readFile(backupPath))
      .digest("hex"),
    applied.backup.sha256,
  );
  report.backupSha256 = applied.backup.sha256;
  await session.assertPreserved(fromVersion, true, false);
  phase = "old-runtime-resume-rejected";
  await assert.rejects(
    verifyNodeDeployment({ ...options, resume: true }),
    /Running Control build/u,
  );
  assert.equal((await session.request("/api/v1/config")).gatewayPaused, true);
  report.staleRuntimeResumeRejected = true;

  phase = "restart-new-runtime";
  await runtime.close();
  runtime = undefined;
  await start(toVersion);
  assert.equal(runtime.bootstrapToken, undefined);
  await session.assertPreserved(toVersion, true);
  await verifyNodeDeployment(options);
  await verifyNodeDeployment({ ...options, resume: true });
  await session.assertPreserved(toVersion, false);
  report.realCrossVersionUpdateVerified = true;

  phase = "code-rollback";
  const rolled = await rollbackNodeDeployment({
    ...options,
    expectedVersion: toVersion,
  });
  assert.equal(rolled.version, fromVersion);
  assert.equal(rolled.databaseRestored, false);
  await assert.rejects(
    verifyNodeDeployment({ ...options, resume: true }),
    /Running Control build/u,
  );
  await runtime.close();
  runtime = undefined;
  await start(fromVersion);
  assert.equal(runtime.bootstrapToken, undefined);
  await session.assertPreserved(fromVersion, true, false);
  await verifyNodeDeployment({ ...options, resume: true });
  await session.assertPreserved(fromVersion, false, false);
  report.codeRollbackWithoutDatabaseRestoreVerified = true;
  phase = "audit-preservation";
  const finalEvents = await session.audit();
  const recorded = new Set(finalEvents.map((event) => JSON.stringify(event)));
  for (const event of originalEvents)
    assert.ok(recorded.has(JSON.stringify(event)));
  report.originalAuditEventsPreserved = originalEvents.length;
  report.finalAuditSignaturesVerified = finalEvents.length;
  report.accountPolicyAndRevocationPreserved = true;
  report.passed = true;
} catch {
  report.failurePhase = phase;
} finally {
  try {
    await runtime?.close();
    await session?.close();
    if (tokenWritten) await unlink(adminTokenFile);
    session?.assertNoSecrets(report);
  } catch {
    report.passed = false;
    report.failurePhase = "runtime-cleanup";
  }
}
process.stdout.write(JSON.stringify(report) + "\n");
