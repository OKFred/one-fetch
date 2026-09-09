import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  archiveFilename,
  assertInsideRepository,
  gitWorktreeStatus,
  parseArguments,
  releaseAssetUrl,
  repositoryRoot,
  requireReleaseChannel,
  requireVersion,
} from "./lib.mjs";
import { requireSuccessfulWorkflowRuns } from "./github-checks.mjs";

test("release versions and CLI arguments are strict", () => {
  assert.equal(requireVersion("1.0.0-rc.1"), "1.0.0-rc.1");
  assert.throws(() => requireVersion("../1.0.0"), /Invalid release version/u);
  assert.deepEqual(
    Object.fromEntries(
      parseArguments(["--version", "0.1.0", "--require-sbom"]),
    ),
    { version: "0.1.0", "require-sbom": true },
  );
  assert.throws(() => parseArguments(["value"]), /Unexpected argument/u);
});

test("stable releases reject preview and prerelease versions", () => {
  assert.deepEqual(requireReleaseChannel("1.0.0", "stable"), {
    channel: "stable",
    version: "1.0.0",
  });
  assert.throws(
    () => requireReleaseChannel("0.1.0", "stable"),
    /0\.x Preview/u,
  );
  assert.throws(
    () => requireReleaseChannel("1.0.0-rc.1", "stable"),
    /prerelease/u,
  );
  assert.throws(
    () => requireReleaseChannel("1.0.0+build.1", "stable"),
    /Invalid release version/u,
  );
});

test("worktree status includes untracked files", async () => {
  const filename = `.one-fetch-release-untracked-${process.pid}-${Date.now()}`;
  const path = join(repositoryRoot, filename);
  try {
    await writeFile(path, "release gate probe\n", "utf8");
    assert.match(gitWorktreeStatus(), new RegExp(filename, "u"));
  } finally {
    await rm(path, { force: true });
  }
});

test("release output cannot escape the repository", () => {
  assert.equal(
    assertInsideRepository(join(repositoryRoot, "artifacts", "release")),
    join(repositoryRoot, "artifacts", "release"),
  );
  assert.throws(
    () => assertInsideRepository(join(repositoryRoot, "..", "outside")),
    /outside repository/u,
  );
});

test("release archive names and URLs are immutable", () => {
  const filename = archiveFilename("@one-fetch/client", "0.1.0");
  assert.equal(filename, "one-fetch-client-0.1.0.tgz");
  assert.equal(
    releaseAssetUrl("OKFred/one-fetch", "0.1.0", filename),
    "https://github.com/OKFred/one-fetch/releases/download/v0.1.0/one-fetch-client-0.1.0.tgz",
  );
});

test("release review requires successful CI and CodeQL on the same commit", () => {
  const commit = "a".repeat(40);
  const runs = [
    {
      conclusion: "failure",
      created_at: "2026-09-04T00:00:00Z",
      head_sha: commit,
      id: 1,
      name: "CI",
      run_attempt: 1,
      status: "completed",
    },
    {
      conclusion: "success",
      created_at: "2026-09-04T00:01:00Z",
      head_sha: commit,
      html_url: "https://example.test/ci",
      id: 2,
      name: "CI",
      run_attempt: 2,
      status: "completed",
    },
    {
      conclusion: "success",
      created_at: "2026-09-04T00:02:00Z",
      head_sha: commit,
      html_url: "https://example.test/codeql",
      id: 3,
      name: "CodeQL",
      status: "completed",
    },
  ];
  assert.deepEqual(requireSuccessfulWorkflowRuns(runs, commit), [
    { id: 2, name: "CI", url: "https://example.test/ci" },
    { id: 3, name: "CodeQL", url: "https://example.test/codeql" },
  ]);
  assert.throws(
    () => requireSuccessfulWorkflowRuns(runs.slice(0, 2), commit),
    /CodeQL has not run/u,
  );
  assert.throws(
    () =>
      requireSuccessfulWorkflowRuns(
        runs.map((run) =>
          run.name === "CodeQL" ? { ...run, conclusion: "failure" } : run,
        ),
        commit,
      ),
    /CodeQL is completed\/failure/u,
  );
});
