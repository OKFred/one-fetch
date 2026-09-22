import assert from "node:assert/strict";
import test from "node:test";
import process from "node:process";
import {
  inventoryCloudflareUpdate,
  assertControlBuild,
} from "./cloudflare-update.mjs";
import { failedDeploymentState } from "./cloudflare-support.mjs";

function fixture(failAt) {
  const state = {
    schemaVersion: 1,
    deploymentId: "preview-update",
    buildId: "0.1.0",
    status: "verified",
    gatewayPaused: false,
    controlUrl: "https://preview-control.example.workers.dev",
    resources: { control: "control", gateway: "gateway", databaseId: "db-id" },
    workerVersions: { control: "old-control", gateway: "old-gateway" },
    previous: { buildId: "stale-previous" },
  };
  const records = [];
  const actions = [];
  let persisted;
  const action = (label) => {
    actions.push(label);
    if (failAt === label) throw new Error("synthetic failure");
  };
  const dependencies = {
    repositoryRoot: process.cwd(),
    readToken: async () => "synthetic-token-not-persisted",
    assertControlBuild: async () => action("check-build"),
    currentVersionId: async (name) => {
      if (actions.includes(`deploy-${name}`)) return `new-${name}`;
      return `old-${name}`;
    },
    setPaused: async () => {
      assert.equal(persisted.update.phase, "pause-intent");
      assert.equal(persisted.gatewayPaused, null);
      action("pause");
    },
    writePrivateJson: async (_path, value) => {
      action(`write-${value.update.phase}`);
      persisted = globalThis.structuredClone(value);
      records.push(persisted);
    },
    writeConfigs: async () => {
      action("configs");
      return { control: "control", gateway: "gateway" };
    },
    sha256File: async () => {
      action("digest");
      return "a".repeat(64);
    },
    runWrangler: async (args) => {
      if (args[1] === "time-travel") {
        action("bookmark");
        return { bookmark: "verified-bookmark" };
      }
      if (args[1] === "export") action("export");
      if (args[1] === "migrations" || args[0] === "deploy") {
        assert.equal(persisted.previous.databaseBackupSha256, "a".repeat(64));
        assert.equal(persisted.previous.controlVersionId, "old-control");
        assert.equal(persisted.previous.gatewayVersionId, "old-gateway");
        assert.equal(persisted.gatewayPaused, true);
        action(args[0] === "deploy" ? `deploy-${args[2]}` : "migrations");
      }
    },
  };
  const run = () =>
    inventoryCloudflareUpdate(
      { deploymentId: state.deploymentId, buildId: "0.1.1" },
      new Map([["--admin-token-file", "private-token-file"]]),
      state,
      dependencies,
    );
  return { state, records, actions, dependencies, run, last: () => persisted };
}

test("Cloudflare update records recoverable backup before schema or code changes", async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.status, "awaiting-verification");
  assert.equal(result.buildId, "0.1.1");
  assert.equal(result.previous.buildId, "0.1.0");
  assert.equal(result.previous.databaseBookmark, "verified-bookmark");
  assert.deepEqual(result.workerVersions, {
    control: "new-control",
    gateway: "new-gateway",
  });
  assert.equal(f.state.status, "verified");
  assert.equal(f.state.previous.buildId, "stale-previous");
  assert.doesNotMatch(
    JSON.stringify(f.records),
    /synthetic-token|private-token-file/u,
  );
});

for (const [failure, phase, paused, hasBackup] of [
  ["pause", "pause-intent", null, false],
  ["bookmark", "backup-intent", true, false],
  ["export", "backup-intent", true, false],
  ["digest", "backup-intent", true, false],
  ["configs", "backup-recorded", true, true],
  ["migrations", "migrations-intent", true, true],
  ["deploy-control", "control-deploy-intent", true, true],
  ["deploy-gateway", "gateway-deploy-intent", true, true],
]) {
  test(`Cloudflare interrupted ${failure} retains truthful recovery checkpoint`, async () => {
    const f = fixture(failure);
    await assert.rejects(f.run(), /synthetic failure/u);
    const failed = failedDeploymentState(f.last());
    assert.equal(failed.status, "failed");
    assert.equal(failed.buildId, "0.1.0");
    assert.equal(failed.update.targetBuildId, "0.1.1");
    assert.equal(failed.update.phase, phase);
    assert.equal(failed.gatewayPaused, paused);
    assert.equal(failed.previous !== undefined, hasBackup);
    if (!hasBackup) assert.equal(f.actions.includes("migrations"), false);
  });
}

test("Cloudflare checkpoint write failure prevents its following mutation", async () => {
  for (const [phase, forbidden] of [
    ["pause-intent", "pause"],
    ["backup-recorded", "configs"],
    ["control-deploy-intent", "deploy-control"],
    ["gateway-deploy-intent", "deploy-gateway"],
  ]) {
    const f = fixture(`write-${phase}`);
    await assert.rejects(f.run(), /synthetic failure/u);
    assert.equal(f.actions.includes(forbidden), false);
  }
});

test("Cloudflare refuses unresolved lifecycle, active-version drift and remote build mismatch", async () => {
  for (const status of [
    "failed",
    "updating",
    "provisioning",
    "awaiting-verification",
  ]) {
    const f = fixture();
    f.state.status = status;
    await assert.rejects(f.run(), /Verify or recover/u);
    assert.deepEqual(f.actions, []);
  }
  const f = fixture();
  f.dependencies.currentVersionId = async () => "out-of-band-version";
  await assert.rejects(f.run(), /differ from recorded state/u);
  assert.deepEqual(f.actions, []);
  const build = fixture("check-build");
  await assert.rejects(build.run(), /synthetic failure/u);
  assert.equal(build.records.length, 0);
});

test("Cloudflare checks active versions again after backup before code mutations", async () => {
  const f = fixture();
  const original = f.dependencies.currentVersionId;
  f.dependencies.currentVersionId = async (name) =>
    f.actions.includes("export") ? "changed-during-backup" : original(name);
  await assert.rejects(f.run(), /differ from recorded state/u);
  assert.equal(f.last().update.phase, "backup-recorded");
  assert.equal(f.actions.includes("migrations"), false);
});

test("Cloudflare build preflight rejects redirects, bounds waiting and sends no token", async () => {
  await assert.rejects(
    assertControlBuild(
      { controlUrl: "https://control.example", buildId: "0.1.0" },
      async (url, init) => {
        assert.equal(
          String(url),
          "https://control.example/api/v1/capabilities",
        );
        assert.equal(init.redirect, "error");
        assert.equal(init.headers, undefined);
        assert.ok(init.signal instanceof globalThis.AbortSignal);
        return globalThis.Response.json({ buildVersion: "wrong-version" });
      },
    ),
    /HTTP Preview contract/u,
  );
});
