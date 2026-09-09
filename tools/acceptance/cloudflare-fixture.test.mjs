import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupCloudflareFixture,
  deployCloudflareFixture,
  validateFixtureName,
} from "./cloudflare-fixture.mjs";

test("fixture lifecycle uses one exact random Worker name", async () => {
  const name = validateFixtureName("one-fetch-fixture-a1b2c3d4");
  let present = false;
  const calls = [];
  const dependencies = {
    workerExists: () => Promise.resolve(present),
    runWrangler: (arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === "deploy") present = true;
      if (arguments_[0] === "delete") present = false;
      return Promise.resolve(
        "https://one-fetch-fixture-a1b2c3d4.example.workers.dev",
      );
    },
    fetch: () =>
      Promise.resolve(new globalThis.Response("fixture", { status: 200 })),
  };
  const deployed = await deployCloudflareFixture(name, dependencies);
  assert.equal(deployed.name, name);
  await assert.rejects(
    cleanupCloudflareFixture(name, "different", dependencies),
    /confirmation mismatch/u,
  );
  const cleanup = await cleanupCloudflareFixture(name, name, dependencies);
  assert.equal(cleanup.absent, true);
  assert.deepEqual(calls.at(-1), ["delete", name, "--force"]);
});

test("fixture names cannot target arbitrary Workers", () => {
  assert.throws(
    () => validateFixtureName("one-fetch-control"),
    /Fixture name/u,
  );
});
