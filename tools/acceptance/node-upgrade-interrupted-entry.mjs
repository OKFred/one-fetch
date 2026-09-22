import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createUpgradeSession } from "./upgrade-session.mjs";
import { interruptPackagedHelper } from "./upgrade-interruptions.mjs";

const [fromVersion, fromSha256, toVersion, toSha256] = process.argv.slice(2);
for (const version of [fromVersion, toVersion])
  assert.match(version, /^0\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u);
for (const digest of [fromSha256, toSha256])
  assert.match(digest, /^[a-f0-9]{64}$/u);
assert.notEqual(fromVersion, toVersion);
const root = "/tmp/installed";
const database = join(root, "data/one-fetch.sqlite");
const adminTokenFile = "/tmp/acceptance/admin-token";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const config = {
  databasePath: database,
  instanceId: "interruption-synthetic",
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
const options = {
  root,
  database,
  adminTokenFile,
  controlUrl: config.publicControlUrl,
};
const update = {
  ...options,
  archive: "/tmp/acceptance/new.tar.gz",
  sha256: toSha256,
  expectedVersion: fromVersion,
};
const report = {
  schemaVersion: 1,
  passed: false,
  helperProcessKillTested: true,
  serverProcessKillTested: false,
  powerLossTested: false,
  databaseRestoredInPlace: false,
  schemaChangeTested: false,
  cliLauncherTested: false,
  scenarios: [],
};
let runtime;
let session;
let tokenWritten = false;
let phase = "load-helper";
async function start(version) {
  const directory = join(root, "versions", version);
  const { startOneFetchNode } = await import(
    pathToFileURL(join(directory, "dist/server.js"))
  );
  runtime = await startOneFetchNode(config);
  return directory;
}
async function restart(version) {
  await runtime.close();
  runtime = undefined;
  await start(version);
  assert.equal(runtime.bootstrapToken, undefined);
}
try {
  const helper = await import("/tmp/acceptance/deployment.mjs");
  phase = "published-install";
  await helper.applyNodeDeployment({
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
  const originalAudit = await session.audit();
  const interrupt = async (operation, barrier, request, expected) => {
    phase = `${operation}/${barrier}`;
    report.scenarios.push(
      await interruptPackagedHelper({
        operation,
        barrier,
        options: request,
        helper,
        session,
        expected,
      }),
    );
  };
  for (const checkpoint of [
    {
      barrier: "control-response-lost",
      phase: "pause-requested",
      gatewayStatus: "unknown",
      backup: false,
    },
    {
      barrier: "backup-verified",
      phase: "backup-verified",
      gatewayStatus: "confirmed-paused",
      backup: true,
    },
  ]) {
    await interrupt("apply", checkpoint.barrier, update, {
      ...checkpoint,
      pointerVersion: fromVersion,
      runningVersion: fromVersion,
      paused: true,
      signedDenial: false,
    });
    phase = "explicit-old-runtime-recovery";
    await helper.verifyNodeDeployment({ ...options, resume: true });
    await session.assertPreserved(fromVersion, false, false);
  }
  await interrupt("apply", "pointer-written", update, {
    phase: "activation-requested",
    gatewayStatus: "confirmed-paused",
    backup: true,
    pointerVersion: toVersion,
    runningVersion: fromVersion,
    paused: true,
    signedDenial: false,
  });
  phase = "stale-runtime-rejected";
  await assert.rejects(
    helper.verifyNodeDeployment({ ...options, resume: true }),
    /Running Control build/u,
  );
  await restart(toVersion);
  await session.assertPreserved(toVersion, true);
  await interrupt(
    "resume",
    "control-response-lost",
    { ...options, resume: true },
    {
      phase: "resume-requested",
      gatewayStatus: "unknown",
      backup: false,
      pointerVersion: toVersion,
      runningVersion: toVersion,
      paused: false,
      signedDenial: true,
    },
  );
  phase = "explicit-new-runtime-recovery";
  await helper.verifyNodeDeployment({ ...options, resume: true });
  await session.assertPreserved(toVersion, false);
  await interrupt(
    "rollback",
    "pointer-written",
    { ...options, expectedVersion: toVersion },
    {
      phase: "activation-requested",
      gatewayStatus: "confirmed-paused",
      backup: false,
      pointerVersion: fromVersion,
      runningVersion: toVersion,
      paused: true,
      signedDenial: true,
    },
  );
  phase = "explicit-rollback-recovery";
  await assert.rejects(
    helper.verifyNodeDeployment({ ...options, resume: true }),
    /Running Control build/u,
  );
  await restart(fromVersion);
  await helper.verifyNodeDeployment({ ...options, resume: true });
  await session.assertPreserved(fromVersion, false, false);
  const events = await session.audit();
  const preserved = new Set(events.map((event) => JSON.stringify(event)));
  for (const event of originalAudit)
    assert.ok(preserved.has(JSON.stringify(event)));
  for (const file of await readdir(join(root, "journal")))
    session.assertNoSecrets(
      JSON.parse(await readFile(join(root, "journal", file), "utf8")),
    );
  report.originalAuditEventsPreserved = originalAudit.length;
  report.finalAuditSignaturesVerified = events.length;
  report.accountPolicyAndRevocationPreserved = true;
  report.staleRuntimeResumeRejected = true;
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
