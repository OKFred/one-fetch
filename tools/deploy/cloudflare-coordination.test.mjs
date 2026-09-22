import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createCloudflareCoordinator,
  withCloudflareCoordination,
  coordinationIdentity,
} from "./cloudflare-coordination.mjs";

const state = {
  deploymentId: "preview-lock",
  accountId: "a".repeat(32),
  resources: {
    control: "preview-lock-control",
    gateway: "preview-lock-gateway",
    database: "preview-lock-db",
    databaseId: "01234567-89ab-cdef-0123-456789abcdef",
  },
};
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const query = async (sql, params) =>
    db
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...row }));
  return { db, query, coordinator: createCloudflareCoordinator(state, query) };
}

test("D1 conditional acquire has one winner and rejects stale build copies", async (t) => {
  const { coordinator } = fixture(t);
  await coordinator.initialize("0.1.0");
  const results = await Promise.allSettled([
    coordinator.acquire("apply", "0.1.0"),
    coordinator.acquire("apply", "0.1.0"),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  const lock = results.find((x) => x.status === "fulfilled").value;
  await lock.assertOwned();
  await lock.complete("0.1.1");
  await assert.rejects(coordinator.acquire("apply", "0.1.0"), /stale/u);
  const next = await coordinator.acquire("verify", "0.1.1");
  assert.ok(next.revision > lock.revision);
  await assert.rejects(lock.complete("0.1.0"));
  await next.assertOwned();
});

test("Failures and lost acknowledgements leave remote ownership intact", async (t) => {
  const { coordinator, query } = fixture(t);
  await coordinator.initialize("0.1.0");
  let owner;
  await assert.rejects(
    withCloudflareCoordination(
      coordinator,
      {
        operation: "apply",
        expectedBuild: "0.1.0",
        recordLock: async (lock) => {
          owner = lock.owner;
        },
      },
      async () => {
        throw new Error("synthetic failure");
      },
    ),
  );
  assert.equal((await coordinator.read()).owner_id, owner);
  await assert.rejects(coordinator.acquire("cleanup", "0.1.0"));
  const broken = createCloudflareCoordinator(state, async (sql, params) => {
    const result = await query(sql, params);
    if (sql.startsWith("UPDATE")) throw new Error("response lost");
    return result;
  });
  const prior = await coordinator.read();
  await assert.rejects(
    broken.acquire("rollback", "0.1.0", {
      owner: prior.owner_id,
      revision: prior.revision,
      confirmStopped: state.deploymentId,
    }),
  );
  assert.notEqual((await coordinator.read()).owner_id, owner);
});

test("Explicit recovery requires exact owner/revision and excludes ordinary updates", async (t) => {
  const { coordinator } = fixture(t);
  await coordinator.initialize("0.1.0");
  const old = await coordinator.acquire("apply", "0.1.0");
  const recovery = {
    owner: old.owner,
    revision: old.revision,
    confirmStopped: state.deploymentId,
  };
  for (const value of [
    { ...recovery, revision: 0 },
    { ...recovery, confirmStopped: "wrong" },
    { ...recovery, owner: "invalid" },
  ])
    await assert.rejects(coordinator.acquire("rollback", "0.1.0", value));
  await assert.rejects(coordinator.acquire("apply", "0.1.0", recovery));
  const current = await coordinator.acquire("rollback", "0.1.0", recovery);
  await assert.rejects(old.assertOwned(), /ownership was lost/u);
  await assert.rejects(old.complete("0.1.1"));
  await current.complete("0.1.0");
});

test("Initialization never replaces existing coordination or foreign identity", async (t) => {
  const { coordinator, query } = fixture(t);
  await coordinator.initialize("0.1.0");
  await assert.rejects(coordinator.initialize("0.1.1"));
  const foreign = createCloudflareCoordinator(
    { ...state, accountId: "b".repeat(32) },
    query,
  );
  await assert.rejects(foreign.read());
  await assert.rejects(foreign.acquire("apply", "0.1.0"));
  assert.equal((await coordinator.read()).build_id, "0.1.0");
  for (const invalid of [
    { ...state, accountId: "../account" },
    { ...state, deploymentId: "';--" },
    { ...state, resources: { ...state.resources, control: "unowned" } },
  ])
    assert.throws(() => coordinationIdentity(invalid));
});

test("Malformed storage and unknown coordination versions fail closed", async (t) => {
  const { coordinator, db } = fixture(t);
  await coordinator.initialize("0.1.0");
  const valid = await coordinator.read();
  for (const rows of [
    [],
    [{ ...valid, extra: 1 }],
    [{ ...valid, schema_version: 2 }],
    [{ ...valid, revision: -1 }],
    [{ ...valid, owner_id: "malformed" }],
  ]) {
    const invalid = createCloudflareCoordinator(state, async () => rows);
    await assert.rejects(invalid.read());
  }
  db.exec("DROP TABLE one_fetch_deployment_coordination");
  await assert.rejects(coordinator.acquire("apply", "0.1.0"));
});

test("No TTL takeover exists, even for an ancient lock", async (t) => {
  const { coordinator, db } = fixture(t);
  await coordinator.initialize("0.1.0");
  const lock = await coordinator.acquire("apply", "0.1.0");
  db.exec(
    "UPDATE one_fetch_deployment_coordination SET updated_at = '2000-01-01T00:00:00.000Z'",
  );
  await assert.rejects(coordinator.acquire("cleanup", "0.1.0"));
  await lock.assertOwned();
});

test("Local journal failure leaves lock retained before any action", async (t) => {
  const { coordinator } = fixture(t);
  await coordinator.initialize("0.1.0");
  let ran = false;
  await assert.rejects(
    withCloudflareCoordination(
      coordinator,
      {
        operation: "apply",
        expectedBuild: "0.1.0",
        recordLock: async () => {
          throw new Error("disk full");
        },
      },
      async () => {
        ran = true;
      },
    ),
  );
  assert.equal(ran, false);
  assert.notEqual((await coordinator.read()).owner_id, null);
});
