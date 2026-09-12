import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLogicalBackup } from "./supabase-backup.mjs";
import { inspectEmptyBaseline } from "./supabase-empty-baseline.mjs";

const projectRef = "abcdefghijklmnopqrst";
const databaseLink = { workdir: "isolated-project" };

test("catalog check uses the verified project and accepts only known schema rows", async () => {
  const calls = [];
  const runPnpm = (args, options) => {
    calls.push({ args, options });
    return JSON.stringify({ rows: [] });
  };
  const proof = await inspectEmptyBaseline({
    runPnpm,
    databaseLink,
    projectRef,
  });
  assert.equal(proof.projectRef, projectRef);
  assert.deepEqual(proof.schemas, []);
  assert.match(proof.querySha256, /^[a-f0-9]{64}$/u);
  assert(calls[0].args.includes("--linked"));
  assert(calls[0].args.includes(projectRef));
  assert(calls[0].args.includes(databaseLink.workdir));
  assert.equal(calls[0].options.capture, true);
  for (const rows of [
    [{ nspname: "one_fetch" }],
    [{ nspname: "supabase_migrations" }],
  ]) {
    assert.equal(
      await inspectEmptyBaseline({
        databaseLink,
        projectRef,
        runPnpm: () => JSON.stringify({ rows }),
      }),
      undefined,
    );
  }
});

test("missing, malformed, duplicate and failed catalog results fail closed", async () => {
  for (const source of [
    "null",
    "{}",
    "[]",
    "invalid",
    '{"rows":[null]}',
    '{"rows":[{"nspname":"public"}]}',
    '{"rows":[{"nspname":"one_fetch","extra":true}]}',
    '{"rows":[{"nspname":"one_fetch"},{"nspname":"one_fetch"}]}',
  ]) {
    await assert.rejects(
      inspectEmptyBaseline({ databaseLink, projectRef, runPnpm: () => source }),
    );
  }
  await assert.rejects(
    inspectEmptyBaseline({
      databaseLink,
      projectRef,
      runPnpm: () => {
        throw new Error("catalog unavailable");
      },
    }),
    /catalog unavailable/u,
  );
  await assert.rejects(
    inspectEmptyBaseline({
      databaseLink,
      projectRef: "other",
      runPnpm: () => {
        assert.fail("must reject before querying");
      },
    }),
  );
});

test("confirmed absent schemas produce hashed empty baseline files, not fake dump output", async () => {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-empty-baseline-"));
  try {
    const recorder = {
      path: join(root, "state.json"),
      state: { runId: randomUUID() },
    };
    const backup = await createLogicalBackup({
      recorder,
      databaseLink,
      projectRef,
      allowEmptyBaseline: true,
      runPnpm: (args) => {
        assert(args.includes("query"));
        return JSON.stringify({ rows: [] });
      },
    });
    assert.deepEqual(backup.emptyBaseline.schemas, []);
    for (const part of [backup.schema, backup.data]) {
      const bytes = await readFile(part.path);
      assert.equal(part.bytes, bytes.length);
      assert.equal(
        part.sha256,
        createHash("sha256").update(bytes).digest("hex"),
      );
      assert.match(part.source, /not a backup of other Supabase schemas/u);
    }
    await assert.rejects(
      createLogicalBackup({
        recorder,
        databaseLink,
        projectRef,
        runPnpm: (args) => {
          assert(args.includes("dump"));
          throw new Error("real backup failure");
        },
      }),
      /real backup failure/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
