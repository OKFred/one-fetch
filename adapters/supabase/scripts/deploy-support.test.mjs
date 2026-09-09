import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { URL } from "node:url";

import {
  assertExpectedCurrentBuild,
  assertFunctionBaseline,
  assertFunctionTransition,
  assertHostedDeployment,
  buildId,
  parseEnv,
  parseFunctionList,
  readDeploymentEnvironment,
} from "./deploy-support.mjs";
import { pnpmInvocation, runDeployment } from "./deploy-release.mjs";
import { verifyDeployment } from "./verify-deployment.mjs";

const commit = "a".repeat(40);
const projectRef = "abcdefghijklmnopqrst";
const instanceId = "00000000-0000-4000-8000-000000000001";
const auditKeys = generateKeyPairSync("ed25519");

function environment() {
  return new Map([
    ["ONE_FETCH_INSTANCE_ID", instanceId],
    [
      "ONE_FETCH_CONTROL_BASE_URL",
      `https://${projectRef}.supabase.co/functions/v1/one-fetch-control`,
    ],
    [
      "ONE_FETCH_GATEWAY_BASE_URL",
      `https://${projectRef}.supabase.co/functions/v1/one-fetch-gateway`,
    ],
  ]);
}

function functionRecord(slug, version) {
  return {
    id: `00000000-0000-4000-8000-00000000000${
      slug === "one-fetch-control" ? "2" : "3"
    }`,
    slug,
    name: slug,
    status: "ACTIVE",
    version,
    created_at: 1_725_408_000_000,
    updated_at: 1_725_408_001_000 + version,
    verify_jwt: false,
    entrypoint_path: `supabase/functions/${slug}/.one-fetch-bundle/index.js`,
    ezbr_sha256: (slug === "one-fetch-control" ? "a" : "b").repeat(64),
  };
}

function deploymentEnvironmentText() {
  const privateKey = auditKeys.privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64url");
  const publicKey = auditKeys.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64url");
  return [
    `ONE_FETCH_INSTANCE_ID=${instanceId}`,
    `ONE_FETCH_BOOTSTRAP_SECRET=${Buffer.alloc(32, 1).toString("base64url")}`,
    `ONE_FETCH_PEPPER=${Buffer.alloc(32, 2).toString("base64url")}`,
    `ONE_FETCH_AUDIT_SIGNING_PRIVATE_KEY=${privateKey}`,
    `ONE_FETCH_AUDIT_VERIFYING_PUBLIC_KEY=${publicKey}`,
    "ONE_FETCH_AUDIT_KEY_ID=audit-test",
    "ONE_FETCH_ALLOWED_ADMIN_ORIGINS=https://admin.example",
    "ONE_FETCH_ALLOWED_CLIENT_ORIGINS=",
    `ONE_FETCH_CONTROL_BASE_URL=https://${projectRef}.supabase.co/functions/v1/one-fetch-control`,
    `ONE_FETCH_GATEWAY_BASE_URL=https://${projectRef}.supabase.co/functions/v1/one-fetch-gateway`,
  ].join("\n");
}

test("build IDs bind an artifact to an exact commit", () => {
  assert.equal(buildId("0.1.0", commit), `0.1.0+supabase.g${"a".repeat(12)}`);
  assert.throws(() => buildId("latest", commit));
});

test("deployment env parsing preserves values and validates the project", () => {
  const values = parseEnv("# comment\nONE_FETCH_TOKEN=a=b=c\r\n");
  assert.equal(values.get("ONE_FETCH_TOKEN"), "a=b=c");
  assert.deepEqual(assertHostedDeployment(environment(), projectRef), {
    instanceId,
    controlUrl: new URL(
      `https://${projectRef}.supabase.co/functions/v1/one-fetch-control`,
    ),
    gatewayUrl: new URL(
      `https://${projectRef}.supabase.co/functions/v1/one-fetch-gateway`,
    ),
  });
  assert.throws(() => assertHostedDeployment(environment(), "z".repeat(20)));
  assert.throws(
    () => parseEnv("ONE_FETCH_INSTANCE_ID=a\nONE_FETCH_INSTANCE_ID=b"),
    /Duplicate/u,
  );
});

test("deployment env validation rejects unknown fields and mismatched audit keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-env-check-"));
  const path = join(directory, "deployment.env");
  try {
    await writeFile(path, deploymentEnvironmentText());
    await assert.doesNotReject(readDeploymentEnvironment(path));
    await writeFile(
      path,
      `${deploymentEnvironmentText()}\nUNEXPECTED_SECRET=x`,
    );
    await assert.rejects(
      readDeploymentEnvironment(path),
      /Unknown or reserved/u,
    );
    await writeFile(
      path,
      deploymentEnvironmentText().replace(
        /^ONE_FETCH_AUDIT_VERIFYING_PUBLIC_KEY=.*$/mu,
        `ONE_FETCH_AUDIT_VERIFYING_PUBLIC_KEY=${Buffer.alloc(44, 3).toString("base64url")}`,
      ),
    );
    await assert.rejects(
      readDeploymentEnvironment(path),
      /valid Ed25519 pair/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deployment baseline and Function version transitions fail closed", () => {
  const build = buildId("0.1.0", commit);
  assert.equal(assertExpectedCurrentBuild("none"), "none");
  assert.equal(assertExpectedCurrentBuild(build), build);
  assert.throws(() => assertExpectedCurrentBuild("0.1.0-preview"));

  const empty = parseFunctionList("[]");
  assert.doesNotThrow(() => assertFunctionBaseline(empty, "none"));
  assert.doesNotThrow(() =>
    assertFunctionBaseline(parseFunctionList("null"), "none"),
  );
  const before = parseFunctionList(
    JSON.stringify([
      functionRecord("one-fetch-control", 4),
      functionRecord("one-fetch-gateway", 7),
    ]),
  );
  assert.doesNotThrow(() => assertFunctionBaseline(before, build));
  assert.throws(() => assertFunctionBaseline(before, "none"), /already exist/u);
  assert.throws(
    () =>
      assertFunctionBaseline(
        parseFunctionList(
          JSON.stringify([functionRecord("one-fetch-control", 4)]),
        ),
        build,
      ),
    /partial/u,
  );

  const afterControl = parseFunctionList(
    JSON.stringify([
      functionRecord("one-fetch-control", 5),
      functionRecord("one-fetch-gateway", 7),
    ]),
  );
  assert.doesNotThrow(() =>
    assertFunctionTransition(before, afterControl, "one-fetch-control"),
  );
  assert.throws(
    () => assertFunctionTransition(before, before, "one-fetch-control"),
    /did not advance/u,
  );
  assert.throws(
    () =>
      assertFunctionTransition(
        before,
        parseFunctionList(
          JSON.stringify([
            functionRecord("one-fetch-control", 3),
            functionRecord("one-fetch-gateway", 7),
          ]),
        ),
        "one-fetch-control",
      ),
    /did not advance/u,
  );
  for (const patch of [
    { status: "FAILED" },
    { verify_jwt: true },
    { version: "5" },
    { ezbr_sha256: "not-a-digest" },
    { entrypoint_path: "functions/one-fetch-control/index.ts" },
  ]) {
    assert.throws(
      () =>
        parseFunctionList(
          JSON.stringify([
            { ...functionRecord("one-fetch-control", 5), ...patch },
          ]),
        ),
      /unsafe deployment metadata/u,
    );
  }
});

test("post-deploy verification checks Control pair/build and Gateway", async () => {
  const expectedBuildId = buildId("0.1.0", commit);
  const seen = [];
  const request = async (input, init) => {
    assert(init?.signal instanceof globalThis.AbortSignal);
    const url = new URL(input);
    seen.push(url.pathname);
    if (url.pathname.endsWith("/api/v1/health")) {
      return globalThis.Response.json({
        instanceId,
        service: "one-fetch-control",
        status: "ok",
        version: expectedBuildId,
      });
    }
    if (url.pathname.endsWith("/api/v1/capabilities")) {
      return globalThis.Response.json({
        instanceId,
        controlGatewayPairId: instanceId,
        buildVersion: expectedBuildId,
      });
    }
    if (url.pathname.endsWith("/api/v1/openapi.json")) {
      return globalThis.Response.json({
        servers: [
          {
            url: `https://${projectRef}.supabase.co/functions/v1/one-fetch-control`,
          },
        ],
        paths: {
          "/api/v1/auth/totp/prepare": {
            post: { responses: { 401: {}, 501: {} } },
          },
          "/api/v1/auth/totp/enable": {
            post: { responses: { 401: {}, 501: {} } },
          },
        },
      });
    }
    return globalThis.Response.json(
      { error: "invalid_metadata" },
      {
        status: 400,
        headers: { "one-fetch-build-version": expectedBuildId },
      },
    );
  };
  await verifyDeployment({
    buildId: expectedBuildId,
    environment: environment(),
    projectRef,
    fetch: request,
  });
  assert.deepEqual(seen, [
    "/functions/v1/one-fetch-control/api/v1/health",
    "/functions/v1/one-fetch-control/api/v1/capabilities",
    "/functions/v1/one-fetch-control/api/v1/openapi.json",
    "/functions/v1/one-fetch-gateway/__one_fetch_deploy_probe__",
  ]);
});

test("post-deploy verification rejects a stale Control build", async () => {
  const request = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/api/v1/health")) {
      return globalThis.Response.json({
        instanceId,
        service: "one-fetch-control",
        status: "ok",
        version: "stale-build",
      });
    }
    throw new Error("verification continued after a stale health response");
  };
  await assert.rejects(
    verifyDeployment({
      buildId: buildId("0.1.0", commit),
      environment: environment(),
      projectRef,
      fetch: request,
    }),
    /does not match the deployed pair\/build/u,
  );
});

test("post-deploy verification rejects degraded Control health", async () => {
  const expectedBuildId = buildId("0.1.0", commit);
  await assert.rejects(
    verifyDeployment({
      buildId: expectedBuildId,
      environment: environment(),
      projectRef,
      fetch: async () =>
        globalThis.Response.json({
          instanceId,
          service: "one-fetch-control",
          status: "degraded",
          version: expectedBuildId,
        }),
    }),
    /does not match the deployed pair\/build/u,
  );
});

test("both deploy entrypoints delegate to the shared guarded orchestrator", async () => {
  for (const name of ["deploy.sh", "deploy.ps1"]) {
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    assert.match(
      source,
      /deploy-release\.mjs/u,
      `${name} bypasses the orchestrator`,
    );
    assert.doesNotMatch(source, /supabase\s+(?:db|secrets|functions)/u);
  }
});

test("pnpm preflight launcher works without a command shell", () => {
  const invocation = pnpmInvocation(["--version"]);
  const result = spawnSync(invocation.file, invocation.args, {
    encoding: "utf8",
    shell: false,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^11\.25\.0\s*$/u);
});

test("Preview preflight writes an executable plan without remote mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "one-fetch-deploy-test-"));
  const envFile = join(directory, "deployment.env");
  const stateFile = join(directory, "state.json");
  const currentBuild = buildId("0.1.0", "a".repeat(40));
  const desiredBuild = buildId("0.1.0", "b".repeat(40));
  await writeFile(envFile, deploymentEnvironmentText());
  const inventory = [
    functionRecord("one-fetch-control", 4),
    functionRecord("one-fetch-gateway", 7),
  ];
  const commands = [];
  const command = (file, args) => {
    commands.push([file, ...args]);
    if (args.some((argument) => argument.endsWith("build-id.mjs"))) {
      return `${desiredBuild}\n`;
    }
    if (args.includes("functions") && args.includes("list"))
      return JSON.stringify(inventory);
    if (args.includes("backups") && args.includes("list"))
      return JSON.stringify({
        region: "us-east-1",
        pitr_enabled: false,
        walg_enabled: true,
        backups: [],
      });
    return "";
  };
  const request = async (input) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/api/v1/health")) {
      return globalThis.Response.json({
        instanceId,
        service: "one-fetch-control",
        status: "ok",
        version: currentBuild,
      });
    }
    if (url.pathname.endsWith("/api/v1/capabilities")) {
      return globalThis.Response.json({
        instanceId,
        controlGatewayPairId: instanceId,
        buildVersion: currentBuild,
      });
    }
    return globalThis.Response.json(
      { error: "invalid_metadata" },
      {
        status: 400,
        headers: { "one-fetch-build-version": currentBuild },
      },
    );
  };
  try {
    await runDeployment({
      options: {
        apply: false,
        projectRef,
        envFile,
        expectedCurrentBuild: currentBuild,
        stateFile,
      },
      command,
      fetch: request,
      readBundles: async () => [
        {
          functionName: "one-fetch-control",
          bytes: 100,
          sha256: "c".repeat(64),
        },
        {
          functionName: "one-fetch-gateway",
          bytes: 200,
          sha256: "d".repeat(64),
        },
      ],
    });
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(state.status, "ready");
    assert.equal(state.apply.available, true);
    assert.equal(state.apply.databaseRestoreAutomatic, false);
    assert.equal(state.bundles.length, 2);
    assert.equal(state.backups.restoreTestVerified, false);
    const dryRun = commands.find(
      (entry) => entry.includes("db") && entry.includes("--dry-run"),
    );
    const mutations = commands.filter(
      (entry) => entry.includes("db") && !entry.includes("--dry-run"),
    );
    assert(dryRun);
    assert.equal(mutations.length, 0);
    assert.equal(
      commands.some(
        (entry) => entry.includes("functions") && entry.includes("deploy"),
      ),
      false,
    );
    assert.equal(
      commands.some((entry) => entry.includes("secrets")),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
