import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deploymentFunctionSlugs } from "./deploy-support.mjs";
import { hashRecoveryTree, tryRecovery } from "./supabase-recovery.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-recovery-"));
  try {
    await mkdir(join(root, "supabase"));
    await writeFile(
      join(root, "supabase", "config.toml"),
      "# synthetic recovery\n",
    );
    const events = [];
    const priorBuild = "0.1.0+supabase.g111111111111";
    const context = {
      options: {
        expectedCurrentBuild: priorBuild,
        projectRef: "abcdefghijklmnopqrst",
      },
      databaseLink: { workdir: root },
      runPnpm(args, options) {
        events.push(options.label);
      },
      renewRecoveryLease() {
        events.push("renew");
      },
      inspectCurrent() {
        events.push("inspect");
        return { buildId: priorBuild };
      },
      confirmPaused() {
        events.push("pause");
      },
      functionList() {
        return new Map();
      },
    };
    await run({
      root,
      events,
      priorBuild,
      context,
      recovery: { root, sha256: await hashRecoveryTree(root) },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("recovery digest frames filenames and bytes without concatenation ambiguity", () =>
  fixture(async ({ root }) => {
    await writeFile(join(root, "a"), "foo/bbar");
    const before = await hashRecoveryTree(root);
    await writeFile(join(root, "a"), "foo");
    await writeFile(join(root, "b"), "bar");
    assert.notEqual(await hashRecoveryTree(root), before);
  }));

test("rollback checks captured bytes, renews leases and verifies the old runtime", () =>
  fixture(async ({ context, recovery, events, priorBuild }) => {
    const result = await tryRecovery(
      context,
      ["one-fetch-control"],
      recovery,
      false,
    );
    assert.equal(result.functionRollbackSucceeded, true);
    assert.equal(result.recoveredBuildId, priorBuild);
    assert.equal(result.gatewayPauseVerified, true);
    assert.deepEqual(events, [
      "renew",
      "restore prior one-fetch-control",
      "renew",
      "restore prior one-fetch-gateway",
      "inspect",
      "pause",
    ]);
  }));

test("changed recovery bytes prevent any remote mutation", () =>
  fixture(async ({ context, recovery, events, root }) => {
    await writeFile(join(root, "supabase", "config.toml"), "# changed\n");
    const result = await tryRecovery(
      context,
      ["one-fetch-control"],
      recovery,
      false,
    );
    assert.equal(result.functionRollbackSucceeded, false);
    assert.match(result.functionRollbackError, /checksum/u);
    assert.deepEqual(events, []);
  }));

test("lease loss prevents restoring a Function over another deployment", () =>
  fixture(async ({ context, recovery, events }) => {
    context.renewRecoveryLease = () => {
      throw new Error("lease lost");
    };
    const result = await tryRecovery(
      context,
      ["one-fetch-control"],
      recovery,
      false,
    );
    assert.equal(result.functionRollbackSucceeded, false);
    assert.deepEqual(events, []);
  }));

for (const failure of ["cli", "stale-build", "unhealthy", "pause"]) {
  test(`rollback does not claim success after ${failure}`, () =>
    fixture(async ({ context, recovery }) => {
      if (failure === "cli")
        context.runPnpm = () => {
          throw new Error("synthetic CLI failure");
        };
      if (failure === "stale-build")
        context.inspectCurrent = () => ({
          buildId: "0.1.0+supabase.g222222222222",
        });
      if (failure === "unhealthy")
        context.inspectCurrent = () => {
          throw new Error("unhealthy pair");
        };
      if (failure === "pause")
        context.confirmPaused = () => {
          throw new Error("pause not confirmed");
        };
      const result = await tryRecovery(
        context,
        ["one-fetch-control"],
        recovery,
        false,
      );
      assert.equal(result.functionRollbackAttempted, true);
      assert.equal(result.functionRollbackSucceeded, false);
      assert.equal(typeof result.functionRollbackError, "string");
    }));
}

test("first-install cleanup verifies remote absence, including an ambiguous failed command", () =>
  fixture(async ({ context, recovery, events }) => {
    context.options.expectedCurrentBuild = "none";
    const result = await tryRecovery(
      context,
      deploymentFunctionSlugs,
      recovery,
      false,
    );
    assert.equal(result.functionAbsenceVerified, true);
    assert.equal(result.functionRollbackSucceeded, true);
    assert.deepEqual(events, [
      "renew",
      "remove partial one-fetch-gateway",
      "renew",
      "remove partial one-fetch-control",
    ]);
  }));

test("CLI deletion success is insufficient when a Function remains", () =>
  fixture(async ({ context, recovery }) => {
    context.options.expectedCurrentBuild = "none";
    context.functionList = () => new Map([["one-fetch-control", {}]]);
    const result = await tryRecovery(
      context,
      ["one-fetch-control"],
      recovery,
      false,
    );
    assert.equal(result.functionRollbackSucceeded, false);
  }));

test("no rollback after a completed deployment or before any deploy attempt", () =>
  fixture(async ({ context, recovery, events }) => {
    for (const [attempted, completed] of [
      [[], false],
      [["one-fetch-control"], true],
    ]) {
      const result = await tryRecovery(context, attempted, recovery, completed);
      assert.equal(result.functionRollbackAttempted, false);
    }
    assert.deepEqual(events, []);
  }));
