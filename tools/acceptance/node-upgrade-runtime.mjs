import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { assertInsideRepository } from "../release/lib.mjs";
import { removeOwnedRuntimeContainer } from "./node-artifact-runtime.mjs";
import { copyRuntimeFile } from "./node-runtime-copy.mjs";
import {
  checkedFile,
  inspectUpgradeArchive,
  parseUpgradeArguments,
} from "./node-upgrade-input.mjs";

const repository = resolve(import.meta.dirname, "../..");
const execute = promisify(execFile);
async function docker(args) {
  try {
    return (
      await execute("docker", args, {
        timeout: 180_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      })
    ).stdout.trim();
  } catch {
    throw new Error("Upgrade container command failed");
  }
}

export async function runNodeUpgrade(options) {
  const from = await inspectUpgradeArchive(
    options["from-archive"],
    options["from-metadata"],
  );
  const to = await inspectUpgradeArchive(
    options["to-archive"],
    options["to-metadata"],
  );
  assert.notEqual(from.version, to.version);
  const helper = await checkedFile(options.helper);
  assert.equal(helper.sha256, to.deploymentHelper.sha256);
  const output = assertInsideRepository(resolve(options.output));
  await mkdir(dirname(output), { recursive: true });
  const owner = randomUUID();
  const name = `one-fetch-upgrade-${owner}`;
  const receipt = {
    schemaVersion: 1,
    kind: "node-cross-version-upgrade",
    passed: false,
    runnerCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    runnerDirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
    ),
    from: {
      version: from.version,
      commit: from.source.commit,
      sha256: from.archive.sha256,
    },
    to: {
      version: to.version,
      commit: to.source.commit,
      sha256: to.archive.sha256,
    },
    helperSha256: helper.sha256,
    image: options.image,
    platform: options.platform,
    provenanceVerified: false,
    hostCredentialsCreated: false,
    startedAt: new Date().toISOString(),
    cleanup: { state: "pending", containerAbsent: false },
  };
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  let created = false;
  let phase = "container-create";
  try {
    assert.equal(
      await docker([
        "container",
        "ls",
        "--all",
        "--filter",
        `name=^/${name}$`,
        "--format",
        "{{.ID}}",
      ]),
      "",
    );
    created = true;
    const id = await docker([
      "container",
      "create",
      "--name",
      name,
      "--label",
      `one-fetch.acceptance-run=${owner}`,
      "--pull",
      "never",
      "--platform",
      options.platform,
      "--network",
      "none",
      "--user",
      "1000:1000",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--log-driver",
      "none",
      "--memory",
      "768m",
      "--pids-limit",
      "128",
      "--tmpfs",
      "/tmp:rw,uid=1000,gid=1000,mode=0700,size=256m",
      "--entrypoint",
      "node",
      options.image,
      "-e",
      "setInterval(()=>{},1000)",
    ]);
    assert.match(id, /^[a-f0-9]{64}$/u);
    receipt.containerId = id;
    await docker(["container", "start", id]);
    assert.equal(
      await docker(["container", "exec", id, "node", "--version"]),
      "v24.20.0",
    );
    assert.equal(await docker(["container", "exec", id, "id", "-u"]), "1000");
    assert.equal(
      await docker(["container", "exec", id, "node", "-p", "process.arch"]),
      options.platform === "linux/amd64" ? "x64" : "arm64",
    );
    phase = "copy-inputs";
    for (const [source, target, digest] of [
      [options["from-archive"], "old.tar.gz", from.archive.sha256],
      [options["to-archive"], "new.tar.gz", to.archive.sha256],
      [options.helper, "deployment.mjs", helper.sha256],
      [
        resolve(repository, "tools/acceptance/node-upgrade-entry.mjs"),
        "upgrade-entry.mjs",
      ],
      [
        resolve(repository, "tools/acceptance/node-upgrade-session.mjs"),
        "upgrade-session.mjs",
      ],
    ])
      await copyRuntimeFile(id, source, `/tmp/acceptance/${target}`, digest);
    phase = "cross-version-rehearsal";
    receipt.checks = JSON.parse(
      await docker([
        "container",
        "exec",
        id,
        "node",
        "/tmp/acceptance/upgrade-entry.mjs",
        from.version,
        from.archive.sha256,
        to.version,
        to.archive.sha256,
      ]),
    );
    receipt.passed = receipt.checks.passed === true;
    if (!receipt.passed)
      receipt.failure = { phase, code: "upgrade_checks_failed" };
  } catch {
    receipt.failure = { phase, code: "upgrade_acceptance_failed" };
  } finally {
    if (created) {
      try {
        receipt.cleanup = await removeOwnedRuntimeContainer(
          docker,
          name,
          owner,
        );
      } catch {
        receipt.cleanup = { state: "failed", containerAbsent: false };
        receipt.passed = false;
      }
    } else receipt.cleanup = { state: "verified", containerAbsent: true };
    receipt.finishedAt = new Date().toISOString();
    await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
    });
  }
  return receipt;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const receipt = await runNodeUpgrade(
      parseUpgradeArguments(process.argv.slice(2)),
    );
    console.log(
      JSON.stringify({
        passed: receipt.passed,
        cleanup: receipt.cleanup,
        failure: receipt.failure,
        failurePhase: receipt.checks?.failurePhase,
      }),
    );
    if (!receipt.passed) process.exitCode = 1;
  } catch {
    console.error("Upgrade input validation or receipt write failed");
    process.exitCode = 1;
  }
}
