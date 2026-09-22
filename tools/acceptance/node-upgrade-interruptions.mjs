import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const fixtureRoot = "/tmp/installed";
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

// Only for the disposable, network-isolated acceptance container. This is an
// explicit operator recovery simulation, NOT a production force-unlock API.
export async function interruptPackagedHelper({
  operation,
  barrier,
  options,
  helper,
  session,
  expected,
}) {
  assert.equal(process.platform, "linux");
  assert.equal(process.getuid(), 1000);
  assert.equal(resolve(options.root), fixtureRoot);
  assert.equal(options.adminTokenFile, "/tmp/acceptance/admin-token");
  const child = fork(
    fileURLToPath(new URL("./interruption-child.mjs", import.meta.url)),
    {
      silent: true,
      env: { PATH: process.env.PATH, HOME: "/tmp" },
    },
  );
  const closed = once(child, "exit");
  try {
    const reached = once(child, "message", {
      signal: globalThis.AbortSignal.timeout(30_000),
    });
    child.send({
      helperUrl: "file:///tmp/acceptance/deployment.mjs",
      operation,
      barrier,
      options,
    });
    const [message] = await Promise.race([
      reached,
      closed.then(() => {
        throw new Error("Helper exited before checkpoint");
      }),
    ]);
    assert.deepEqual(message, { barrier });
    child.kill("SIGKILL");
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");

    const lockPath = join(fixtureRoot, ".deployment-lock.json");
    const original = await readFile(lockPath, "utf8");
    const lock = JSON.parse(original);
    assert.equal(lock.schemaVersion, 1);
    assert.equal(lock.pid, child.pid);
    assert.equal(lock.operation, operation);
    assert.match(lock.owner, /^[a-f0-9-]{36}$/u);
    const journal = await readJson(
      join(fixtureRoot, "journal", `${lock.owner}.json`),
    );
    assert.equal(journal.operationId, lock.owner);
    assert.equal(journal.phase, expected.phase);
    assert.equal(journal.state, "in-progress");
    assert.equal(journal.gatewayStatus, expected.gatewayStatus);
    assert.equal(
      (await readJson(join(fixtureRoot, "current.json"))).version,
      expected.pointerVersion,
    );
    const config = await session.request("/api/v1/config");
    assert.equal(config.gatewayPaused, expected.paused);
    if (expected.backup) {
      assert.match(
        journal.backup.path,
        /^backups\/[A-Za-z0-9.-]+\/one-fetch\.sqlite$/u,
      );
      const bytes = await readFile(join(fixtureRoot, journal.backup.path));
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        journal.backup.sha256,
      );
    }
    for (const mutate of [
      () => helper.applyNodeDeployment(options),
      () => helper.verifyNodeDeployment({ ...options, resume: true }),
      () => helper.rollbackNodeDeployment(options),
    ])
      await assert.rejects(mutate(), /locked/u);
    assert.equal(
      (await session.request("/api/v1/config")).version,
      config.version,
    );
    await session.assertPreserved(
      expected.runningVersion,
      expected.paused,
      expected.signedDenial,
    );
    session.assertNoSecrets(journal);

    // The only helper child is confirmed exited above; no other deployment job
    // exists in this fixture. Preserve the exact lock before explicit recovery.
    assert.equal((await lstat(lockPath)).isSymbolicLink(), false);
    assert.equal(await readFile(lockPath, "utf8"), original);
    const evidenceDirectory = join(fixtureRoot, "interruption-evidence");
    await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
    const evidence = join(evidenceDirectory, `${lock.owner}.json`);
    await assert.rejects(lstat(evidence), { code: "ENOENT" });
    await rename(lockPath, evidence);
    assert.equal(await readFile(evidence, "utf8"), original);
    await assert.rejects(lstat(lockPath), { code: "ENOENT" });
    return {
      operation,
      barrier,
      journalPhase: journal.phase,
      passed: true,
      processExitConfirmed: true,
      mutationRetriesBlocked: true,
      orphanEvidencePreserved: true,
      operatorRecoverySimulated: true,
      backupDigestVerified: Boolean(expected.backup),
    };
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await closed;
  }
}
