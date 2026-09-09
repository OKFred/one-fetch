import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertHttpPreviewCapabilities,
  assertExpectedBuild,
  createCloudflareConfigs,
  deploymentNames,
  latestVersionId,
  parseD1CreateOutput,
  parseWorkersUrl,
  readDeploymentState,
  stateDirectory,
  validateBuildId,
  validateSecretsFile,
  writePrivateJson,
} from "./cloudflare-support.mjs";

test("Cloudflare verification accepts only nested HTTP Preview states", () => {
  const buildId = "0.1.0+cloudflare.g1234567";
  const capabilities = {
    provider: "cloudflare",
    buildVersion: buildId,
    transports: {
      http: { state: "stable" },
      websocket: { state: "unsupported" },
      tcp: { state: "unsupported" },
      tls: { state: "unsupported" },
    },
  };
  assert.equal(
    assertHttpPreviewCapabilities(capabilities, buildId),
    capabilities,
  );
  assert.throws(
    () =>
      assertHttpPreviewCapabilities(
        {
          ...capabilities,
          transports: { ...capabilities.transports, tcp: { state: "stable" } },
        },
        buildId,
      ),
    /HTTP Preview contract/u,
  );
});

test("Cloudflare deployment names are exact and bounded", () => {
  assert.deepEqual(deploymentNames("preview-a1"), {
    control: "preview-a1-control",
    gateway: "preview-a1-gateway",
    database: "preview-a1-db",
  });
  for (const value of [
    "ab",
    "Upper",
    "-bad",
    "bad-",
    "bad_name",
    "x".repeat(41),
  ]) {
    assert.throws(() => deploymentNames(value));
  }
  assert.equal(validateBuildId("0.1.0+abc123"), "0.1.0+abc123");
  assert.throws(() => validateBuildId("spaces are unsafe"));
});

test("Cloudflare generated config uses exact owned resources", () => {
  const configs = createCloudflareConfigs({
    deploymentId: "preview-a1",
    buildId: "0.1.0+abc123",
    databaseId: "01234567-89ab-cdef-0123-456789abcdef",
    adminAllowedOrigins: "https://admin.example",
    xpanelAllowedOrigins: "chrome-extension://example",
    controlMain: "/repo/adapters/cloudflare/src/control.ts",
    gatewayMain: "/repo/adapters/cloudflare/src/gateway.ts",
    migrationsDirectory: "/repo/adapters/cloudflare/migrations",
  });
  assert.equal(configs.control.name, "preview-a1-control");
  assert.equal(
    configs.control.d1_databases[0].database_id,
    "01234567-89ab-cdef-0123-456789abcdef",
  );
  assert.equal(configs.gateway.services[0].service, "preview-a1-control");
  assert.equal(configs.gateway.services[0].entrypoint, "ControlService");
  assert.equal(configs.control.observability.enabled, false);
  assert.equal(configs.gateway.observability.enabled, false);
  assert.equal("nodejs_compat" in configs.control, false);
  assert.equal(
    configs.gateway.compatibility_flags.includes("nodejs_compat"),
    false,
  );
  assert.deepEqual(configs.control.exports, {
    AuthDurableObject: { type: "durable-object", storage: "sqlite" },
    QuotaDurableObject: { type: "durable-object", storage: "sqlite" },
  });
});

test("Wrangler output parsers reject ambiguous results", () => {
  const uuid = "01234567-89ab-cdef-0123-456789abcdef";
  assert.equal(parseD1CreateOutput(`database_id = "${uuid}"`), uuid);
  assert.equal(
    parseWorkersUrl("Uploaded https://preview-a1-control.example.workers.dev"),
    "https://preview-a1-control.example.workers.dev",
  );
  assert.equal(latestVersionId([{ id: "version-one" }]), "version-one");
  assert.equal(
    latestVersionId({ items: [{ version_id: "version-two" }] }),
    "version-two",
  );
  assert.throws(() => parseD1CreateOutput("nothing"));
  assert.throws(() => parseWorkersUrl("https://example.com"));
  assert.throws(() => latestVersionId([]));
});

test("Cloudflare secrets and deployment state remain private and strict", async () => {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-cloudflare-"));
  try {
    const secretPath = join(root, "secrets.json");
    const secrets = {
      AUDIT_SIGNING_KEY: "a".repeat(64),
      BOOTSTRAP_SECRET: "b".repeat(32),
      ENCRYPTION_KEY: "c".repeat(32),
      INSTANCE_PEPPER: "d".repeat(32),
    };
    await writeFile(secretPath, JSON.stringify(secrets));
    await validateSecretsFile(secretPath);
    await writeFile(
      secretPath,
      JSON.stringify({ ...secrets, EXTRA: "not-allowed" }),
    );
    await assert.rejects(validateSecretsFile(secretPath));

    const directory = stateDirectory(root, "preview-a1");
    const statePath = join(directory, "state.json");
    await writePrivateJson(statePath, {
      schemaVersion: 1,
      deploymentId: "preview-a1",
      buildId: "0.1.0",
      resources: { databaseId: "01234567-89ab-cdef-0123-456789abcdef" },
    });
    assert.equal(
      (await readDeploymentState(root, "preview-a1")).buildId,
      "0.1.0",
    );
    assert.doesNotMatch(await readFile(statePath, "utf8"), /BOOTSTRAP_SECRET/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cloudflare update compare-and-swap is explicit", () => {
  assert.doesNotThrow(() => assertExpectedBuild(undefined, "none"));
  assert.doesNotThrow(() => assertExpectedBuild({ buildId: "0.1.0" }, "0.1.0"));
  assert.throws(() => assertExpectedBuild({ buildId: "0.1.0" }, "none"));
  assert.throws(() => assertExpectedBuild({ buildId: "0.1.0" }, "0.1.1"));
});
