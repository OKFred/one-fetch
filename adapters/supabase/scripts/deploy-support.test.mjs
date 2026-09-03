import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

import {
  assertHostedDeployment,
  buildId,
  parseEnv,
} from "./deploy-support.mjs";
import { verifyDeployment } from "./verify-deployment.mjs";

const commit = "a".repeat(40);
const projectRef = "abcdefghijklmnopqrst";
const instanceId = "00000000-0000-4000-8000-000000000001";

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
});

test("post-deploy verification checks Control pair/build and Gateway", async () => {
  const expectedBuildId = buildId("0.1.0", commit);
  const seen = [];
  const request = async (input) => {
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
      { status: 400 },
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

test("both deploy entrypoints gate every remote mutation", async () => {
  for (const name of ["deploy.sh", "deploy.ps1"]) {
    const source = await readFile(new URL(name, import.meta.url), "utf8");
    const preflight = source.indexOf("pnpm run predeploy");
    const build = source.indexOf("scripts/build-id.mjs");
    const database = source.indexOf("supabase db push");
    const secrets = source.indexOf("supabase secrets set");
    const control = source.indexOf("functions deploy one-fetch-control");
    const gateway = source.indexOf("functions deploy one-fetch-gateway");
    const injectedBuild = source.indexOf("ONE_FETCH_BUILD_VERSION=");
    const verification = source.indexOf("scripts/verify-deployment.mjs");
    for (const [step, index] of Object.entries({
      preflight,
      build,
      database,
      secrets,
      control,
      gateway,
      injectedBuild,
      verification,
    })) {
      assert.notEqual(index, -1, `${name} is missing ${step}`);
    }
    assert(preflight < build, `${name} computes a build before preflight`);
    for (const mutation of [database, secrets, control, gateway]) {
      assert(preflight < mutation, `${name} mutates before preflight`);
      assert(build < mutation, `${name} mutates before source validation`);
    }
    assert(gateway < injectedBuild, `${name} labels a partial deployment`);
    assert(injectedBuild < verification, `${name} verifies before labeling`);
  }
});
