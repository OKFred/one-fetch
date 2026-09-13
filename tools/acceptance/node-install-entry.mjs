import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import process from "node:process";

// Container-only launcher. The archive and standalone helper are verified,
// copied files; all installation state is in the container's tmpfs.
const sha256 = process.argv[2];
assert.match(sha256 ?? "", /^[a-f0-9]{64}$/u);
const helper = "/tmp/acceptance/deployment.mjs";
const root = "/tmp/installed";
execFileSync(
  process.execPath,
  [
    helper,
    "--mode",
    "apply",
    "--root",
    root,
    "--archive",
    "/tmp/acceptance/artifact.tar.gz",
    "--sha256",
    sha256,
    "--expected-version",
    "none",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
const child = spawn(
  process.execPath,
  [helper, "--mode", "launch", "--root", root],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
child.once("error", () => {
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
