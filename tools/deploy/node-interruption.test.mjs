import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { bundleNodeDeploymentHelper } from "../release/bundle-node-helper.mjs";
import {
  archiveFixture,
  fakeControl,
  initializeDatabase,
} from "./node-test-fixtures.mjs";

const sourceUrl = new URL("./node.mjs", import.meta.url);
const childFile = fileURLToPath(
  new URL("./node-interruption-child.mjs", import.meta.url),
);
const cases = [
  {
    operation: "apply",
    barrier: "pause-requested",
    phase: "pause-requested",
    version: "0.1.0",
    paused: false,
    status: "unknown",
  },
  {
    operation: "apply",
    barrier: "control-response-lost",
    phase: "pause-requested",
    version: "0.1.0",
    paused: true,
    status: "unknown",
  },
  {
    operation: "apply",
    barrier: "backup-verified",
    phase: "backup-verified",
    version: "0.1.0",
    paused: true,
    status: "confirmed-paused",
  },
  {
    operation: "apply",
    barrier: "activation-requested",
    phase: "activation-requested",
    version: "0.1.0",
    paused: true,
    status: "confirmed-paused",
  },
  {
    operation: "apply",
    barrier: "pointer-written",
    phase: "activation-requested",
    version: "0.1.1",
    paused: true,
    status: "confirmed-paused",
  },
  {
    operation: "apply",
    barrier: "restart-required",
    phase: "restart-required",
    version: "0.1.1",
    paused: true,
    status: "confirmed-paused",
  },
  {
    operation: "resume",
    barrier: "control-response-lost",
    phase: "resume-requested",
    version: "0.1.1",
    paused: false,
    status: "unknown",
  },
  {
    operation: "rollback",
    barrier: "pointer-written",
    phase: "activation-requested",
    version: "0.1.0",
    paused: true,
    status: "confirmed-paused",
  },
];

async function fixture(t, bundled) {
  const temporary = await mkdtemp(join(tmpdir(), "one-fetch-interruption-"));
  const root = join(temporary, "installation");
  const control = await fakeControl();
  t.after(async () => {
    await control.close();
    // Only the mkdtemp-owned synthetic installation is removed, never a live root.
    await rm(temporary, { recursive: true, force: true });
  });
  let helperUrl = sourceUrl.href;
  if (bundled) {
    const bundledPath = join(temporary, "standalone-helper.mjs");
    await bundleNodeDeploymentHelper(fileURLToPath(sourceUrl), bundledPath);
    helperUrl = pathToFileURL(bundledPath).href;
  }
  const helper = await import(helperUrl);
  await helper.applyNodeDeployment({
    root,
    ...(await archiveFixture(temporary, "0.1.0")),
    expectedVersion: "none",
  });
  await mkdir(join(root, "data"));
  const database = join(root, "data/one-fetch.sqlite");
  initializeDatabase(database);
  control.observeConfiguration((config) => {
    const db = new DatabaseSync(database);
    try {
      db.prepare(
        "UPDATE instance_config SET value_json = ? WHERE key = 'configuration'",
      ).run(JSON.stringify(config));
    } finally {
      db.close();
    }
  });
  const adminTokenFile = join(temporary, "private-synthetic-token");
  await writeFile(adminTokenFile, control.token, { mode: 0o600 });
  const options = {
    root,
    ...(await archiveFixture(temporary, "0.1.1")),
    database,
    adminTokenFile,
    controlUrl: control.controlUrl,
    expectedVersion: "0.1.0",
  };
  return { helperUrl, helper, control, options };
}

for (const bundled of [false, true]) {
  for (const scenario of cases) {
    test(
      `${bundled ? "standalone" : "source"} helper killed during ${scenario.operation}/${scenario.barrier} leaves honest journal and closed lock`,
      { timeout: 20_000 },
      async (t) => {
        const f = await fixture(t, bundled);
        if (scenario.operation !== "apply") {
          await f.helper.applyNodeDeployment(f.options);
          f.control.setBuildVersion("0.1.1");
          if (scenario.operation === "rollback")
            await f.helper.verifyNodeDeployment({ ...f.options, resume: true });
        }
        const options = {
          ...f.options,
          expectedVersion:
            scenario.operation === "rollback" ? "0.1.1" : "0.1.0",
          resume: scenario.operation === "resume",
        };
        const child = fork(childFile, { silent: true, windowsHide: true });
        const closed = once(child, "exit");
        t.after(async () => {
          child.kill("SIGKILL");
          await closed;
        });
        const reached = once(child, "message");
        child.send({
          helperUrl: f.helperUrl,
          operation: scenario.operation,
          barrier: scenario.barrier,
          options,
        });
        const message = await Promise.race([
          reached,
          closed.then(() => {
            throw new Error("Child exited before barrier");
          }),
        ]);
        assert.deepEqual(message[0], { barrier: scenario.barrier });
        child.kill("SIGKILL");
        const [exitCode] = await closed;
        assert.notEqual(exitCode, 0);

        const { root } = options;
        const read = async (path) =>
          JSON.parse(await readFile(join(root, path), "utf8"));
        const lock = await read(".deployment-lock.json");
        assert.equal(lock.pid, child.pid);
        assert.equal(lock.operation, scenario.operation);
        const journal = await read(`journal/${lock.owner}.json`);
        assert.equal(journal.phase, scenario.phase);
        assert.equal(journal.operationId, lock.owner);
        assert.equal(journal.gatewayStatus, scenario.status);
        assert.equal(
          journal.state,
          scenario.phase === "restart-required"
            ? "restart-required"
            : "in-progress",
        );
        assert.ok(journal.revision > 0);
        assert.deepEqual(journal.recovery, {
          automaticDatabaseRestore: false,
          automaticResume: false,
          automaticLockRemoval: false,
        });
        assert.equal((await read("current.json")).version, scenario.version);
        assert.equal(f.control.isPaused(), scenario.paused);
        if (journal.backup?.sha256) {
          const bytes = await readFile(join(root, journal.backup.path));
          assert.equal(
            createHash("sha256").update(bytes).digest("hex"),
            journal.backup.sha256,
          );
        }
        for (const retry of [
          () => f.helper.applyNodeDeployment(options),
          () => f.helper.verifyNodeDeployment({ ...options, resume: true }),
          () => f.helper.rollbackNodeDeployment(options),
        ])
          await assert.rejects(retry(), /locked/u);
        assert.equal(f.control.isPaused(), scenario.paused);
        for (const name of await readdir(join(root, "journal"))) {
          const text = await readFile(join(root, "journal", name), "utf8");
          assert.equal(text.includes(f.control.token), false);
          assert.equal(text.includes(f.control.controlUrl), false);
          assert.equal(text.includes(options.adminTokenFile), false);
        }
      },
    );
  }
}
