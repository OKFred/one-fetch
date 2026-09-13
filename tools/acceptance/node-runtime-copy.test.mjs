import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import {
  assertRuntimeCopyTarget,
  copyRuntimeFile,
  stageRuntimeFiles,
} from "./node-runtime-copy.mjs";

const id = "a".repeat(64);
test("container copies are confined to the private acceptance directory", () => {
  assert.doesNotThrow(() =>
    assertRuntimeCopyTarget(id, "/tmp/acceptance/file.mjs"),
  );
  for (const target of [
    "/etc/passwd",
    "/tmp/acceptance/../secret",
    "/tmp/acceptance/./file",
    "/tmp/acceptance//file",
    "/tmp/acceptance/",
    "/tmp/acceptance/file;command",
  ])
    assert.throws(() => assertRuntimeCopyTarget(id, target));
  assert.throws(() => assertRuntimeCopyTarget("other", "/tmp/acceptance/file"));
});

test("copy refuses a changed reviewed file before starting Docker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-copy-test-"));
  try {
    const file = join(directory, "artifact");
    await writeFile(file, "synthetic artifact");
    await assert.rejects(
      copyRuntimeFile(id, file, "/tmp/acceptance/artifact", "0".repeat(64)),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const [mode, expectedCount] of [
  ["oci", 2],
  ["archive", 4],
  ["installed", 7],
]) {
  test(`${mode} copies only its fixed synthetic or verified runtime inputs`, async () => {
    const calls = [];
    const input = {
      archive: { path: "/review/archive", sha256: "b".repeat(64) },
      deploy: { path: "/review/deploy", sha256: "c".repeat(64) },
    };
    const result = await stageRuntimeFiles(
      id,
      { mode },
      input,
      process.cwd(),
      async (...args) => {
        calls.push(args);
        assertRuntimeCopyTarget(args[0], args[2]);
        return { target: args[2], sha256: args[3] };
      },
    );
    assert.equal(result.length, expectedCount);
    if (mode !== "oci")
      assert.ok(
        calls.some(
          (args) =>
            args[1] === input.archive.path && args[3] === input.archive.sha256,
        ),
      );
    if (mode === "installed")
      assert.ok(
        calls.some(
          (args) =>
            args[1] === input.deploy.path && args[3] === input.deploy.sha256,
        ),
      );
    assert.ok(calls.every((args) => !args[2].includes("ready")));
  });
}
