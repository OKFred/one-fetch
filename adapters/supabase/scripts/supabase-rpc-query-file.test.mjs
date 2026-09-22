import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureRpcBackup,
  ownedRpcNames,
  RPC_CATALOG_QUERY,
} from "./supabase-rpc-backup.mjs";
import { rpcFixture } from "./rpc-backup-fixtures.mjs";

test("multiline RPC query uses an exact file, not a Windows-shim SQL argument", async () => {
  const root = await mkdtemp(join(tmpdir(), "one-fetch rpc query-"));
  const names = await ownedRpcNames("none");
  try {
    const result = await captureRpcBackup({
      databaseLink: { workdir: "verified-project" },
      projectRef: "abcdefghijklmnopqrst",
      path: join(root, "backup.rpc.sql"),
      expectedCurrentBuild: "none",
      runPnpm: async (args, options) => {
        assert.equal(options.capture, true);
        assert.ok(args.includes("--linked"));
        assert.ok(args.includes("abcdefghijklmnopqrst"));
        assert.ok(args.includes("verified-project"));
        assert.ok(args.includes("--file"));
        assert.equal(
          args.some((arg) => /[\r\n]/u.test(arg)),
          false,
        );
        assert.equal(args.includes(RPC_CATALOG_QUERY), false);
        const query = await readFile(args[args.indexOf("--file") + 1], "utf8");
        assert.equal(query, RPC_CATALOG_QUERY);
        return JSON.stringify({ rows: names.map((name) => rpcFixture(name)) });
      },
    });
    assert.equal(result.count, names.length);
    assert.deepEqual(await readdir(root), ["backup.rpc.sql"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("query files are removed on command failure and invalid catalog output", async () => {
  const root = await mkdtemp(join(tmpdir(), "one-fetch rpc failure-"));
  try {
    for (const runPnpm of [
      () => {
        throw new Error("synthetic transport failure");
      },
      () => JSON.stringify({ rows: [{}] }),
    ]) {
      await assert.rejects(
        captureRpcBackup({
          databaseLink: { workdir: "verified-project" },
          projectRef: "abcdefghijklmnopqrst",
          path: join(root, "backup.rpc.sql"),
          runPnpm,
        }),
      );
      assert.deepEqual(await readdir(root), []);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing query files are neither overwritten nor removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "one-fetch rpc collision-"));
  const path = join(root, "backup.rpc.sql");
  try {
    await writeFile(`${path}.query.sql`, "existing file", { flag: "wx" });
    await assert.rejects(
      captureRpcBackup({
        databaseLink: { workdir: "verified-project" },
        projectRef: "abcdefghijklmnopqrst",
        path,
        runPnpm: () => assert.fail("must fail before querying"),
      }),
      { code: "EEXIST" },
    );
    assert.equal(await readFile(`${path}.query.sql`, "utf8"), "existing file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
