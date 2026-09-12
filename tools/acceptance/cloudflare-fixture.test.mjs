import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import test from "node:test";

import ts from "typescript";

import {
  cleanupCloudflareFixture,
  deployCloudflareFixture,
  parseFixtureArguments,
  validateFixtureName,
} from "./cloudflare-fixture.mjs";

test("fixture lifecycle uses one exact random Worker name", async () => {
  const name = validateFixtureName("one-fetch-fixture-a1b2c3d4");
  let present = false;
  let probes = 0;
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
    fetch: () => {
      probes += 1;
      return Promise.resolve(
        new globalThis.Response(probes === 1 ? "pending" : "fixture", {
          status: probes === 1 ? 404 : 200,
        }),
      );
    },
    wait: () => Promise.resolve(),
  };
  const deployed = await deployCloudflareFixture(name, dependencies);
  assert.equal(deployed.name, name);
  assert.equal(probes, 2);
  assert.equal(calls[0][1], "--config");
  assert.equal(basename(calls[0][2]), "wrangler.fixture.jsonc");
  assert.deepEqual(calls[0].slice(3), ["--name", name]);
  await assert.rejects(
    cleanupCloudflareFixture(name, "different", dependencies),
    /confirmation mismatch/u,
  );
  const cleanup = await cleanupCloudflareFixture(name, name, dependencies);
  assert.equal(cleanup.absent, true);
  assert.deepEqual(calls.at(-1), ["delete", name, "--force"]);
});

test("fixture config disables persistent logs and has no fallback Worker name", async () => {
  const parsed = ts.parseConfigFileTextToJson(
    "wrangler.fixture.jsonc",
    await readFile(
      new globalThis.URL("./wrangler.fixture.jsonc", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(parsed.error, undefined);
  const config = parsed.config;
  assert.equal(config.name, undefined);
  assert.equal(config.main, "cloudflare-target.mjs");
  assert.equal(config.compatibility_date, "2026-09-04");
  assert.deepEqual(config.compatibility_flags, ["enable_request_signal"]);
  assert.deepEqual(config.observability, { enabled: false });
  assert.equal(config.logpush, false);
  assert.deepEqual(config.tail_consumers, []);
  assert.equal(config.workers_dev, true);
});

test("fixture names cannot target arbitrary Workers", () => {
  assert.throws(
    () => validateFixtureName("one-fetch-control"),
    /Fixture name/u,
  );
});

test("pnpm's argument separator is accepted", () => {
  assert.deepEqual(
    parseFixtureArguments([
      "--",
      "cleanup",
      "--name",
      "one-fetch-fixture-a1b2c3d4",
      "--confirm-name",
      "one-fetch-fixture-a1b2c3d4",
    ]),
    {
      command: "cleanup",
      name: "one-fetch-fixture-a1b2c3d4",
      confirmation: "one-fetch-fixture-a1b2c3d4",
    },
  );
});
