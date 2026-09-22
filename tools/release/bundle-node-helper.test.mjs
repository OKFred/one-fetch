import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { archiveFixture } from "../deploy/node-test-fixtures.mjs";
import { bundleNodeDeploymentHelper } from "./bundle-node-helper.mjs";

test("bundled Node helper is reproducible and runs outside the checkout", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "one-fetch-helper-bundle-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL("../deploy/node.mjs", import.meta.url));
  const first = join(temporary, "helper-first.mjs");
  const second = join(temporary, "helper-second.mjs");
  await bundleNodeDeploymentHelper(entry, first);
  await bundleNodeDeploymentHelper(entry, second);
  assert.deepEqual(await readFile(first), await readFile(second));
  const helper = await import(pathToFileURL(first).href);
  assert.equal(typeof helper.applyNodeDeployment, "function");
  assert.equal(typeof helper.verifyNodeDeployment, "function");
  assert.equal(typeof helper.rollbackNodeDeployment, "function");
  const archive = await archiveFixture(temporary, "0.1.1");
  const run = (mode) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          first,
          "--mode",
          mode,
          "--root",
          join(temporary, "installation"),
          "--archive",
          archive.archive,
          "--sha256",
          archive.sha256,
          "--expected-version",
          "none",
        ],
        {
          cwd: temporary,
          encoding: "utf8",
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
  assert.equal(run("plan").action, "install");
  assert.equal(run("apply").state, "restart-required");
});
