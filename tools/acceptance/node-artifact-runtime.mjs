import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile, execFileSync } from "node:child_process";
import console from "node:console";
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  webcrypto,
} from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { assertInsideRepository } from "../release/lib.mjs";
import {
  assertRuntimeImage,
  loopbackPublishedOrigin,
  parseRuntimeArguments,
  verifyRuntimeInput,
} from "./node-artifact-input.mjs";
import {
  acceptNodeRuntime,
  assertNoRuntimeSecrets,
} from "./node-runtime-session.mjs";

const execute = promisify(execFile);
const ownerLabel = "one-fetch.acceptance-run";
const repository = resolve(import.meta.dirname, "../..");

async function docker(args, environment = {}) {
  try {
    const result = await execute("docker", args, {
      env: { ...process.env, ...environment },
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch {
    // Child errors contain argv and sometimes stdout; never serialize them.
    throw new Error(`Docker ${args[0]} command failed`);
  }
}

async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return address.port;
}

export async function removeOwnedRuntimeContainer(run, name, owner) {
  const list = () =>
    run([
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--filter",
      `name=^/${name}$`,
      "--format",
      "{{.ID}}",
    ]);
  const id = (await list()).trim();
  if (!id) return { state: "verified", containerAbsent: true };
  if (!/^[a-f0-9]{64}$/u.test(id))
    throw new Error("Ambiguous cleanup container identity");
  const labels = JSON.parse(
    await run([
      "container",
      "inspect",
      "--format",
      "{{json .Config.Labels}}",
      id,
    ]),
  );
  if (labels?.[ownerLabel] !== owner)
    throw new Error("Cleanup container ownership mismatch");
  await run(["container", "rm", "--force", "--volumes", id]);
  if ((await list()).trim())
    throw new Error("Container removal was not confirmed");
  return { state: "verified", containerAbsent: true };
}

async function waitForHealth(url) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if (
        (
          await globalThis.fetch(url + "/api/v1/health", {
            signal: globalThis.AbortSignal.timeout(1000),
          })
        ).ok
      )
        return;
    } catch {
      /* startup is bounded below */
    }
    await new Promise((accept) => globalThis.setTimeout(accept, 250));
  }
  throw new Error("Runtime startup deadline exceeded");
}

export async function runNodeArtifactRuntime(options) {
  const input = await verifyRuntimeInput(options);
  const output = assertInsideRepository(resolve(options.output));
  await mkdir(dirname(output), { recursive: true });
  const owner = randomUUID();
  const name = `one-fetch-artifact-${randomBytes(6).toString("hex")}`;
  const receipt = {
    schemaVersion: 1,
    kind: "node-artifact-runtime",
    runnerCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    runnerDirty:
      execFileSync("git", ["status", "--porcelain"], {
        cwd: repository,
        encoding: "utf8",
      }).trim().length > 0,
    artifactCommit: options.commit,
    version: options.version,
    platform: options.platform,
    mode: options.mode,
    image: options.image,
    archiveSha256: input.archive.sha256,
    ociSha256: input.oci.sha256,
    deploymentHelperSha256: input.deploy.sha256,
    manifestSha256: input.manifestSha256,
    startedAt: new Date().toISOString(),
    passed: false,
    cleanup: { state: "pending", containerAbsent: false },
    hostCredentialFilesCreated: false,
    secretsPassedViaContainerEnvironment: true,
    provenanceVerified: false,
  };
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  const keyPair = generateKeyPairSync("ed25519");
  const auditKey = keyPair.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  const secretValues = {
    ONE_FETCH_AUDIT_SIGNING_PRIVATE_KEY: auditKey,
    ONE_FETCH_INSTANCE_PEPPER: randomBytes(32).toString("base64url"),
    ONE_FETCH_PROTOCOL_SIGNING_KEY: randomBytes(32).toString("base64url"),
  };
  let phase = "image-identity";
  let creationAttempted = false;
  let acceptance;
  try {
    const labels = JSON.parse(
      await docker([
        "image",
        "inspect",
        "--platform",
        options.platform,
        "--format",
        "{{json .Config.Labels}}",
        options.image,
      ]),
    );
    const user = await docker([
      "image",
      "inspect",
      "--platform",
      options.platform,
      "--format",
      "{{.Config.User}}",
      options.image,
    ]);
    assertRuntimeImage(labels, options, user);
    const controlPort = await freePort();
    let gatewayPort = await freePort();
    while (gatewayPort === controlPort) gatewayPort = await freePort();
    const controlUrl = `http://127.0.0.1:${controlPort}`;
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const environment = {
      ...secretValues,
      ONE_FETCH_INSTANCE_ID: name,
      ONE_FETCH_PUBLIC_CONTROL_URL: controlUrl,
      ONE_FETCH_PUBLIC_GATEWAY_URL: gatewayUrl,
      ONE_FETCH_CONTROL_ALLOWED_ORIGINS: controlUrl,
      ONE_FETCH_BOOTSTRAP_TOKEN_FILE: "/var/lib/one-fetch/bootstrap-token",
    };
    const args = [
      "container",
      "create",
      "--name",
      name,
      "--label",
      `${ownerLabel}=${owner}`,
      "--pull",
      "never",
      "--platform",
      options.platform,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--log-driver",
      "none",
      "--memory",
      "512m",
      "--pids-limit",
      "128",
      "--tmpfs",
      "/var/lib/one-fetch:rw,uid=1000,gid=1000,mode=0700,size=64m",
      "--tmpfs",
      "/tmp:rw,uid=1000,gid=1000,mode=0700,size=64m",
      "--publish",
      `127.0.0.1:${controlPort}:8787`,
      "--publish",
      `127.0.0.1:${gatewayPort}:8788`,
      "--mount",
      `type=bind,source=${resolve(repository, "tools/acceptance/target-server.mjs")},target=/fixture/tools/acceptance/target-server.mjs,readonly`,
      "--mount",
      `type=bind,source=${resolve(repository, "packages/conformance/dist/target.js")},target=/fixture/packages/conformance/dist/target.js,readonly`,
      ...Object.keys(environment).flatMap((key) => ["--env", key]),
    ];
    if (options.mode === "archive")
      args.push(
        "--mount",
        `type=bind,source=${input.archive.path},target=/artifact.tar.gz,readonly`,
        "--entrypoint",
        "/bin/sh",
      );
    if (options.mode === "installed") {
      for (const [source, target] of [
        [input.archive.path, "/artifact.tar.gz"],
        [input.deploy.path, "/deployment.mjs"],
        [
          resolve(repository, "tools/acceptance/node-install-entry.mjs"),
          "/install-entry.mjs",
        ],
        [
          resolve(repository, "tools/acceptance/node-installed-check.mjs"),
          "/installed-check.mjs",
        ],
      ])
        args.push(
          "--mount",
          `type=bind,source=${source},target=${target},readonly`,
        );
      args.push("--entrypoint", "node");
    }
    args.push(options.image);
    if (options.mode === "installed")
      args.push("/install-entry.mjs", input.archive.sha256);
    if (options.mode === "archive")
      args.push(
        "-c",
        "mkdir /tmp/runtime && tar --no-same-owner -xzf /artifact.tar.gz -C /tmp/runtime && cd /tmp/runtime/one-fetch && exec node dist/cli.js",
      );
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
    phase = "create";
    creationAttempted = true;
    const id = await docker(args, environment);
    assert.match(id, /^[a-f0-9]{64}$/u);
    receipt.containerId = id;
    phase = "startup";
    await docker(["container", "start", id]);
    assert.equal(
      loopbackPublishedOrigin(
        await docker(["container", "port", id, "8787/tcp"]),
      ),
      controlUrl,
    );
    assert.equal(
      loopbackPublishedOrigin(
        await docker(["container", "port", id, "8788/tcp"]),
      ),
      gatewayUrl,
    );
    await waitForHealth(controlUrl);
    const version = await docker([
      "container",
      "exec",
      id,
      "node",
      "--version",
    ]);
    const uid = await docker(["container", "exec", id, "id", "-u"]);
    assert.equal(version, "v24.20.0");
    assert.equal(uid, "1000");
    const architecture = await docker([
      "container",
      "exec",
      id,
      "node",
      "-p",
      "process.arch",
    ]);
    assert.equal(
      architecture,
      options.platform === "linux/amd64" ? "x64" : "arm64",
    );
    receipt.runtime = {
      nodeVersion: version,
      architecture,
      uid,
      readOnlyRoot: true,
      loopbackOnly: true,
    };
    await docker([
      "container",
      "exec",
      "--detach",
      id,
      "node",
      "/fixture/tools/acceptance/target-server.mjs",
      "--host",
      "127.0.0.1",
      "--port",
      "52132",
    ]);
    const bootstrapToken = await docker([
      "container",
      "exec",
      id,
      "node",
      "-e",
      "process.stdout.write(require('node:fs').readFileSync('/var/lib/one-fetch/bootstrap-token'))",
    ]);
    const auditPublicKey = await webcrypto.subtle.importKey(
      "spki",
      Buffer.from(keyPair.publicKey.export({ format: "der", type: "spki" })),
      "Ed25519",
      false,
      ["verify"],
    );
    phase = "conformance";
    acceptance = await acceptNodeRuntime({
      controlUrl,
      gatewayUrl,
      targetUrl: "http://127.0.0.1:52132",
      bootstrapToken,
      commit: options.commit,
      version: options.version,
      auditPublicKey,
      secrets: Object.values(secretValues),
      onStep: (step) => {
        phase = `conformance:${step}`;
      },
      onSuite: (report) => {
        acceptance = {
          report,
          authenticationVerified: true,
          revocationVerified: false,
          verifiedAuditEvents: 0,
        };
      },
      ...(options.mode !== "installed"
        ? {}
        : {
            onVerified: async (credentials) => {
              phase = "installed-verification-and-restore";
              const checked = JSON.parse(
                await docker(
                  [
                    "container",
                    "exec",
                    "--env",
                    "ONE_FETCH_ACCEPTANCE_ADMIN_TOKEN",
                    "--env",
                    "ONE_FETCH_ACCEPTANCE_EXECUTION_TOKEN",
                    id,
                    "node",
                    "/installed-check.mjs",
                  ],
                  {
                    ONE_FETCH_ACCEPTANCE_ADMIN_TOKEN: credentials.adminToken,
                    ONE_FETCH_ACCEPTANCE_EXECUTION_TOKEN:
                      credentials.executionToken,
                  },
                ),
              );
              receipt.installedChecks = checked;
              assert.equal(checked.passed, true);
              return checked;
            },
          }),
    });
    receipt.passed = acceptance.report.suite.passed;
    if (!receipt.passed)
      receipt.failure = { phase, code: "conformance_failed" };
  } catch {
    receipt.failure = { phase, code: "runtime_acceptance_failed" };
  } finally {
    if (creationAttempted) {
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
    if (acceptance) {
      acceptance.report.cleanup = {
        state: receipt.cleanup.containerAbsent ? "verified" : "pending",
        resources: [
          { kind: "local-docker-container", id: receipt.containerId },
        ],
      };
      receipt.acceptance = acceptance;
    }
    receipt.finishedAt = new Date().toISOString();
    assertNoRuntimeSecrets(receipt, Object.values(secretValues));
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
    const result = await runNodeArtifactRuntime(
      parseRuntimeArguments(process.argv.slice(2)),
    );
    console.log(
      JSON.stringify({
        mode: result.mode,
        platform: result.platform,
        passed: result.passed,
        cleanup: result.cleanup,
        ...(result.failure ? { failure: result.failure } : {}),
      }),
    );
    if (!result.passed) process.exitCode = 1;
  } catch {
    console.error("Node artifact acceptance input or receipt failed");
    process.exitCode = 1;
  }
}
