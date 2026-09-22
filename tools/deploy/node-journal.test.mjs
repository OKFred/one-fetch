import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withNodeDeploymentLock } from "./node-files.mjs";
import { withNodeDeploymentJournal } from "./node-journal.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("journal failure prevents side effects and does not persist secret exception text", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    withNodeDeploymentLock(root, "apply", (lock) =>
      withNodeDeploymentJournal(lock, async (journal) => {
        await journal.advance("pause-requested");
        throw new Error("synthetic-secret-do-not-persist");
      }),
    ),
    /synthetic-secret/u,
  );
  const files = await readdir(join(root, "journal"));
  assert.equal(files.length, 1);
  const raw = await readFile(join(root, "journal", files[0]), "utf8");
  const record = JSON.parse(raw);
  assert.equal(record.state, "failed-needs-inspection");
  assert.equal(record.phase, "pause-requested");
  assert.equal(record.gatewayStatus, "unknown");
  assert.equal(record.revision, 3);
  assert.equal(raw.includes("synthetic-secret"), false);
  await assert.rejects(readFile(join(root, ".deployment-lock.json")), {
    code: "ENOENT",
  });
});

test("unwritable journal fails closed before invoking deployment work", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "journal"), "blocked-path");
  let started = false;
  await assert.rejects(
    withNodeDeploymentLock(root, "apply", (lock) =>
      withNodeDeploymentJournal(lock, async () => {
        started = true;
      }),
    ),
  );
  assert.equal(started, false);
});

test("lost ownership preserves previous journal and never deletes another owner's lock", async (t) => {
  const root = await fixture(t);
  let journalPath;
  await assert.rejects(
    withNodeDeploymentLock(root, "apply", (lock) =>
      withNodeDeploymentJournal(lock, async (journal) => {
        journalPath = join(root, "journal", `${lock.owner}.json`);
        await journal.advance("pause-requested");
        await writeFile(
          join(root, ".deployment-lock.json"),
          JSON.stringify({ schemaVersion: 1, owner: "replacement" }),
        );
        await journal.advance("pause-confirmed", {
          gatewayStatus: "confirmed-paused",
        });
      }),
    ),
    /ownership/u,
  );
  const record = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(record.phase, "pause-requested");
  assert.equal(record.state, "in-progress");
  assert.equal(
    JSON.parse(await readFile(join(root, ".deployment-lock.json"), "utf8"))
      .owner,
    "replacement",
  );
});
