import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createCloudflareCoordinator } from "./cloudflare-coordination.mjs";
import {
  cloudflareAccount,
  deploymentCoordinator,
  guardedCloudflareOperation,
  recoveryOptions,
} from "./cloudflare-guard.mjs";
import { adoptCloudflareCoordination } from "./cloudflare-adopt.mjs";

const state = {
  schemaVersion: 1,
  deploymentId: "guard-test",
  buildId: "0.1.0",
  status: "verified",
  accountId: "a".repeat(32),
  resources: {
    control: "guard-test-control",
    gateway: "guard-test-gateway",
    database: "guard-test-db",
    databaseId: "01234567-89ab-cdef-0123-456789abcdef",
  },
  workerVersions: {
    control: "01234567-89ab-cdef-0123-456789abcdef",
    gateway: "01234567-89ab-cdef-0123-456789abcdef",
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
  const coordinator = createCloudflareCoordinator(state, query);
  const writes = [],
    commands = [];
  const context = {
    accountId: state.accountId,
    run: async (...args) => {
      commands.push(args);
    },
  };
  const dependencies = {
    coordinator: async () => coordinator,
    writePrivateJson: async (...args) => {
      writes.push(args);
    },
    repositoryRoot: "/synthetic",
  };
  return { db, query, coordinator, writes, commands, context, dependencies };
}

test("Account selection requires membership and pins every Wrangler call", async () => {
  const calls = [];
  const run = async (args, options) => {
    calls.push({ args, options });
    return {
      loggedIn: true,
      accounts: [{ id: state.accountId }, { id: "b".repeat(32) }],
    };
  };
  await assert.rejects(cloudflareAccount(new Map(), undefined, run));
  await assert.rejects(
    cloudflareAccount(new Map([["--account-id", "b".repeat(32)]]), state, run),
  );
  const context = await cloudflareAccount(new Map(), state, run);
  await context.run(["deploy"], { json: true });
  assert.equal(calls.at(-1).options.accountId, state.accountId);
  assert.equal(context.values.get("--account-id"), state.accountId);
});

test("Remote identity mismatch never reads coordination or issues writes", async () => {
  let queried = false;
  await assert.rejects(
    deploymentCoordinator(
      state,
      {
        run: async () => [
          { uuid: state.resources.databaseId, name: "foreign" },
        ],
      },
      {
        createQuery: async () => {
          queried = true;
        },
      },
    ),
    /identity/u,
  );
  assert.equal(queried, false);
});

test("Guard excludes a losing helper before journal writes or remote mutation", async (t) => {
  const f = fixture(t);
  await f.coordinator.initialize(state.buildId);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let acquired;
  const ready = new Promise((resolve) => {
    acquired = resolve;
  });
  const first = guardedCloudflareOperation(
    state,
    new Map(),
    f.context,
    "apply",
    async (guard) => {
      acquired();
      await held;
      await guard.run(["deploy"]);
      return { buildId: "0.1.1" };
    },
    f.dependencies,
  );
  await ready;
  await assert.rejects(
    guardedCloudflareOperation(
      state,
      new Map(),
      f.context,
      "cleanup",
      async () => {
        throw new Error("must not run");
      },
      f.dependencies,
    ),
  );
  assert.equal(f.writes.length, 1);
  assert.equal(f.commands.length, 0);
  release();
  await first;
  assert.equal(f.commands.length, 1);
  assert.equal((await f.coordinator.read()).owner_id, null);
  assert.equal((await f.coordinator.read()).build_id, "0.1.1");
  await assert.rejects(
    guardedCloudflareOperation(
      state,
      new Map(),
      f.context,
      "apply",
      async () => {},
      f.dependencies,
    ),
  );
});

test("Failed operation retains lock and recovery checks every remote action", async (t) => {
  const f = fixture(t);
  await f.coordinator.initialize(state.buildId);
  await assert.rejects(
    guardedCloudflareOperation(
      state,
      new Map(),
      f.context,
      "apply",
      async () => {
        throw new Error("lost response");
      },
      f.dependencies,
    ),
  );
  const old = await f.coordinator.read();
  const values = new Map([
    ["--recover-owner", old.owner_id],
    ["--recover-revision", String(old.revision)],
    ["--confirm-stopped", state.deploymentId],
  ]);
  await guardedCloudflareOperation(
    state,
    values,
    f.context,
    "rollback",
    async (guard) => {
      f.db.exec(
        "UPDATE one_fetch_deployment_coordination SET revision = revision + 1",
      );
      await assert.rejects(guard.run(["rollback"]), /ownership/u);
      await assert.rejects(guard.write("state.json", {}), /ownership/u);
      throw new Error("stop");
    },
    f.dependencies,
  ).catch((error) => assert.equal(error.message, "stop"));
  assert.equal(f.commands.length, 0);
  assert.equal(f.writes.length, 2); // owner journals only
  assert.throws(() =>
    recoveryOptions(new Map([["--recover-owner", old.owner_id]]), state),
  );
});

test("Database cleanup never attempts to release the deleted lock", async (t) => {
  const f = fixture(t);
  await f.coordinator.initialize(state.buildId);
  const result = await guardedCloudflareOperation(
    state,
    new Map(),
    f.context,
    "cleanup",
    async () => {
      f.db.exec("DROP TABLE one_fetch_deployment_coordination");
      return { cleanupVerified: true };
    },
    f.dependencies,
  );
  assert.equal(result.cleanupVerified, true);
});

function adoptionFixture(t) {
  const f = fixture(t);
  const events = [];
  const values = new Map([
    ["--deployment-id", state.deploymentId],
    ["--expected-build", state.buildId],
    ["--account-id", state.accountId],
    ["--confirm-stopped", state.deploymentId],
    ["--admin-token-file", "synthetic"],
  ]);
  const dependencies = {
    repositoryRoot: "/synthetic",
    readState: async () => globalThis.structuredClone(state),
    account: async () => ({
      accountId: state.accountId,
      current: async (name) =>
        state.workerVersions[name.endsWith("control") ? "control" : "gateway"],
      run: async (args) => {
        events.push(args.slice(0, 2).join(" "));
        return [
          { uuid: state.resources.databaseId, name: state.resources.database },
        ];
      },
    }),
    createQuery: async () => async (sql, params) => {
      events.push(sql.split(" ")[0]);
      return f.query(sql, params);
    },
    checkBuild: async () => {},
    readToken: async () => "synthetic-token",
    pause: async () => {
      events.push("pause");
    },
    write: async (_path, value) => {
      events.push(`checkpoint:${value.adoption.phase}`);
    },
    digest: async () => "a".repeat(64),
  };
  return { ...f, events, values, dependencies };
}

test("Legacy adoption confirms quiescence, pauses and backs up before initialization", async (t) => {
  const f = adoptionFixture(t);
  await assert.rejects(
    adoptCloudflareCoordination(
      new Map([...f.values].filter(([key]) => key !== "--confirm-stopped")),
      f.dependencies,
    ),
    /confirm-stopped/u,
  );
  assert.deepEqual(f.events, []);
  const result = await adoptCloudflareCoordination(f.values, f.dependencies);
  assert.equal(result.gatewayPaused, true);
  assert.equal(result.coordination.owner_id, null);
  assert.ok(f.events.indexOf("pause") < f.events.indexOf("d1 export"));
  assert.ok(f.events.indexOf("d1 export") < f.events.indexOf("CREATE"));
  f.events.length = 0;
  await assert.rejects(
    adoptCloudflareCoordination(f.values, f.dependencies),
    /already exists/u,
  );
  assert.equal(f.events.includes("pause"), false);
});

test("Failed adoption backup never creates coordination", async (t) => {
  const f = adoptionFixture(t);
  f.dependencies.digest = async () => {
    throw new Error("backup failure");
  };
  await assert.rejects(
    adoptCloudflareCoordination(f.values, f.dependencies),
    /backup failure/u,
  );
  assert.equal(f.events.includes("CREATE"), false);
  assert.ok(f.events.includes("checkpoint:paused"));
});
