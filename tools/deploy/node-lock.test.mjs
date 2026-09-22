import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { URL } from "node:url";
import { withNodeDeploymentLock } from "./node.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-lock-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("only one operation can hold a deployment root", async (t) => {
  const root = await fixture(t);
  for (const operation of ["apply", "resume", "rollback"]) {
    await withNodeDeploymentLock(root, operation, async (lock) => {
      await lock.assertOwned();
      const state = JSON.parse(
        await readFile(join(root, ".deployment-lock.json")),
      );
      assert.equal(state.operation, operation);
      assert.equal(state.pid, process.pid);
      await assert.rejects(
        withNodeDeploymentLock(root, "apply", () =>
          assert.fail("competitor ran"),
        ),
        /locked/u,
      );
    });
    await assert.rejects(readFile(join(root, ".deployment-lock.json")), {
      code: "ENOENT",
    });
  }
});

test("an ordinary failure releases only its own lock", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    withNodeDeploymentLock(root, "apply", () => {
      throw new Error("synthetic failure");
    }),
    /synthetic failure/u,
  );
  assert.equal(
    await withNodeDeploymentLock(root, "rollback", () => "recovered"),
    "recovered",
  );
});

test("replacement ownership fences the operation and is not deleted", async (t) => {
  const root = await fixture(t);
  const replacement = JSON.stringify({
    schemaVersion: 1,
    owner: "another-owner",
  });
  await assert.rejects(
    withNodeDeploymentLock(root, "apply", async (lock) => {
      await writeFile(join(root, ".deployment-lock.json"), replacement);
      await assert.rejects(lock.assertOwned(), /ownership/u);
    }),
    /ownership/u,
  );
  assert.equal(
    await readFile(join(root, ".deployment-lock.json"), "utf8"),
    replacement,
  );
});

test("a malformed or old lock is not automatically stolen", async (t) => {
  const root = await fixture(t);
  const path = join(root, ".deployment-lock.json");
  for (const contents of [
    "invalid",
    JSON.stringify({ createdAt: "2000-01-01", pid: 99999999 }),
  ]) {
    await writeFile(path, contents);
    await assert.rejects(
      withNodeDeploymentLock(root, "apply", () => assert.fail()),
      /locked/u,
    );
    assert.equal(await readFile(path, "utf8"), contents);
  }
});

test("a real competing process cannot acquire the lock and a killed owner leaves it closed", async (t) => {
  const root = await fixture(t);
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {withNodeDeploymentLock} from ${JSON.stringify(new URL("./node.mjs", import.meta.url).href)};await withNodeDeploymentLock(process.argv[1],"apply",async()=>{process.stdout.write("ready\\n");await new Promise(()=>{setInterval(()=>{},1000)})});`,
      root,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: 10000 },
  );
  const closed = once(child, "close");
  try {
    const [bytes] = await once(child.stdout, "data", {
      signal: globalThis.AbortSignal.timeout(5000),
    });
    assert.equal(bytes.toString(), "ready\n");
    await assert.rejects(
      withNodeDeploymentLock(root, "resume", () => assert.fail()),
      /locked/u,
    );
  } finally {
    child.kill();
    await closed;
  }
  await assert.rejects(
    withNodeDeploymentLock(root, "rollback", () => assert.fail()),
    /locked/u,
  );
  assert.equal(
    JSON.parse(await readFile(join(root, ".deployment-lock.json"))).pid,
    child.pid,
  );
});
