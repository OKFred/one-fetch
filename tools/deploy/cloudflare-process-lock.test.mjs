import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createCloudflareCoordinator } from "./cloudflare-coordination.mjs";

test(
  "Independent helper processes contend on shared SQL; process death retains ownership",
  { timeout: 20_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "one-fetch-cf-lock-test-"));
    const path = join(directory, "coordination.sqlite");
    const state = {
      deploymentId: "process-lock",
      accountId: "a".repeat(32),
      resources: {
        control: "process-lock-control",
        gateway: "process-lock-gateway",
        database: "process-lock-db",
        databaseId: "01234567-89ab-cdef-0123-456789abcdef",
      },
    };
    const db = new DatabaseSync(path);
    const children = [];
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close");
          child.kill("SIGKILL");
          await closed;
        }
      }
      db.close();
      await rm(directory, { recursive: true, force: true });
    });
    db.exec("PRAGMA busy_timeout = 5000");
    const coordinator = createCloudflareCoordinator(
      state,
      async (sql, params) =>
        db
          .prepare(sql)
          .all(...params)
          .map((row) => ({ ...row })),
    );
    await coordinator.initialize("0.1.0");
    for (let index = 0; index < 2; index++) {
      const child = fork(
        new globalThis.URL(
          "./fixtures/cloudflare-lock-child.mjs",
          import.meta.url,
        ),
        [path, JSON.stringify(state)],
        { stdio: ["ignore", "ignore", "ignore", "ipc"] },
      );
      children.push(child);
      const [ready] = await once(child, "message");
      assert.equal(ready.ready, true);
    }
    const replies = children.map((child) => once(child, "message"));
    for (const child of children) child.send("start");
    const results = (await Promise.all(replies)).map(([reply]) => reply);
    assert.equal(results.filter((result) => result.acquired).length, 1);
    const winner = results.findIndex((result) => result.acquired);
    const closed = once(children[winner], "close");
    children[winner].kill("SIGKILL");
    await closed;
    const retained = await coordinator.read();
    assert.equal(retained.owner_id, results[winner].owner);
    await assert.rejects(coordinator.acquire("apply", "0.1.0"));
    // Stop the other participant before the operator-confirmed recovery.
    const loserClosed = once(children[1 - winner], "close");
    children[1 - winner].kill("SIGKILL");
    await loserClosed;
    const recovered = await coordinator.acquire("rollback", "0.1.0", {
      owner: retained.owner_id,
      revision: retained.revision,
      confirmStopped: state.deploymentId,
    });
    await recovered.complete("0.1.0");
    assert.equal((await coordinator.read()).owner_id, null);
  },
);
