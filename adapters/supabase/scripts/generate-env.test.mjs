import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const script = fileURLToPath(new URL("./generate-env.mjs", import.meta.url));

test("local Function env uses the explicit Supabase base path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-env-"));
  const output = join(directory, "functions.env");
  try {
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--out",
        output,
        "--base-url",
        "http://127.0.0.1:54321/functions/v1/",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const generated = await readFile(output, "utf8");
    assert.match(
      generated,
      /^ONE_FETCH_CONTROL_BASE_URL=http:\/\/127\.0\.0\.1:54321\/functions\/v1\/one-fetch-control$/mu,
    );
    assert.match(
      generated,
      /^ONE_FETCH_GATEWAY_BASE_URL=http:\/\/127\.0\.0\.1:54321\/functions\/v1\/one-fetch-gateway$/mu,
    );
    assert.doesNotMatch(generated, /ONE_FETCH_BUILD_VERSION/u);
  } finally {
    assert.ok(directory.startsWith(join(tmpdir(), "one-fetch-env-")));
    await rm(directory, { recursive: true, force: true });
  }
});

test("env generation rejects ambiguous remote and local destinations", () => {
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--out",
      "ignored.env",
      "--base-url",
      "http://127.0.0.1:54321/functions/v1",
      "--project-ref",
      "abcdefghijklmnopqrst",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/u);
});

test("env generation rejects unsafe Function and admin URLs", () => {
  for (const argumentsList of [
    [
      "--base-url",
      "http://127.0.0.1:54321/not-functions",
      "--admin-origin",
      "http://localhost:5173",
    ],
    [
      "--base-url",
      "http://127.0.0.1:54321/functions/v1",
      "--admin-origin",
      "https://admin.example/settings",
    ],
  ]) {
    const result = spawnSync(
      process.execPath,
      [script, "--out", "ignored.env", ...argumentsList],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /(Function base URL|admin origin)/u);
  }
});
