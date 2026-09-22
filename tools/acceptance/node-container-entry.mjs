import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import process from "node:process";

// Loaded only after the runner has verified every copied file's digest.
const mode = process.argv[1];
assert.ok(mode === "archive" || mode === "installed");
if (mode === "installed") {
  await import("/tmp/acceptance/install-entry.mjs");
} else {
  await mkdir("/tmp/runtime", { mode: 0o700 });
  execFileSync(
    "tar",
    [
      "--no-same-owner",
      "-xzf",
      "/tmp/acceptance/artifact.tar.gz",
      "-C",
      "/tmp/runtime",
    ],
    { stdio: "ignore" },
  );
  process.chdir("/tmp/runtime/one-fetch");
  await import("/tmp/runtime/one-fetch/dist/cli.js");
}
