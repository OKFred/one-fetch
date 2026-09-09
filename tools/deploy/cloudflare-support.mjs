import { createHash } from "node:crypto";
import { readFile, stat, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

const DEPLOYMENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/u;
const BUILD_ID_PATTERN = /^[A-Za-z0-9._+-]{1,128}$/u;
const REQUIRED_SECRETS = [
  "AUDIT_SIGNING_KEY",
  "BOOTSTRAP_SECRET",
  "ENCRYPTION_KEY",
  "INSTANCE_PEPPER",
];

export function deploymentNames(deploymentId) {
  if (!DEPLOYMENT_ID_PATTERN.test(deploymentId))
    throw new Error(
      "Cloudflare deployment ID must be 3-40 lowercase characters",
    );
  return {
    control: `${deploymentId}-control`,
    gateway: `${deploymentId}-gateway`,
    database: `${deploymentId}-db`,
  };
}

export function validateBuildId(buildId) {
  if (!BUILD_ID_PATTERN.test(buildId))
    throw new Error("Cloudflare build ID is invalid");
  return buildId;
}

export function assertHttpPreviewCapabilities(capabilities, buildId) {
  if (
    capabilities?.provider !== "cloudflare" ||
    capabilities.buildVersion !== buildId ||
    capabilities.transports?.http?.state !== "stable" ||
    capabilities.transports?.websocket?.state !== "unsupported" ||
    capabilities.transports?.tcp?.state !== "unsupported" ||
    capabilities.transports?.tls?.state !== "unsupported"
  ) {
    throw new Error(
      "Cloudflare capabilities do not match the HTTP Preview contract",
    );
  }
  return capabilities;
}

export function parseD1CreateOutput(output) {
  const id = output.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/iu)?.[0];
  if (!id) throw new Error("Wrangler did not return a D1 database ID");
  return id.toLowerCase();
}

export function parseWorkersUrl(output) {
  const url = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/iu)?.[0];
  if (!url) throw new Error("Wrangler did not return a workers.dev URL");
  return new globalThis.URL(url).origin;
}

export function latestVersionId(value) {
  const list = Array.isArray(value) ? value : value?.items;
  const candidate = Array.isArray(list) ? list[0] : undefined;
  const id = candidate?.id ?? candidate?.version_id;
  if (typeof id !== "string" || id.length === 0)
    throw new Error("Wrangler did not return a Worker version ID");
  return id;
}

export function createCloudflareConfigs(options) {
  const names = deploymentNames(options.deploymentId);
  const common = {
    compatibility_date: "2026-09-04",
    workers_dev: true,
    observability: { enabled: false },
  };
  return {
    control: {
      ...common,
      name: names.control,
      main: options.controlMain,
      vars: {
        ADAPTER_NAME: "cloudflare",
        ADAPTER_VERSION: validateBuildId(options.buildId),
        ADMIN_ALLOWED_ORIGINS: options.adminAllowedOrigins,
        DEFAULT_ACCESS_TTL_SECONDS: "900",
        DEFAULT_REFRESH_TTL_SECONDS: "2592000",
        REPORT_TTL_SECONDS: "600",
      },
      d1_databases: [
        {
          binding: "DB",
          database_name: names.database,
          database_id: options.databaseId,
          migrations_dir: options.migrationsDirectory,
        },
      ],
      durable_objects: {
        bindings: [
          { name: "AUTH", class_name: "AuthDurableObject" },
          { name: "QUOTA", class_name: "QuotaDurableObject" },
        ],
      },
      exports: {
        AuthDurableObject: { type: "durable-object", storage: "sqlite" },
        QuotaDurableObject: { type: "durable-object", storage: "sqlite" },
      },
      triggers: { crons: ["*/10 * * * *"] },
    },
    gateway: {
      ...common,
      name: names.gateway,
      main: options.gatewayMain,
      compatibility_flags: ["enable_request_signal"],
      vars: {
        ADAPTER_NAME: "cloudflare",
        ADAPTER_VERSION: validateBuildId(options.buildId),
        MAX_METADATA_BYTES: "49152",
        MAX_REQUEST_BYTES: "20971520",
        MAX_RESPONSE_BYTES: "20971520",
        MAX_REDIRECTS: "20",
        XPANEL_ALLOWED_ORIGINS: options.xpanelAllowedOrigins,
      },
      services: [
        {
          binding: "CONTROL",
          service: names.control,
          entrypoint: "ControlService",
        },
      ],
    },
  };
}

export async function validateSecretsFile(path) {
  const details = await stat(path);
  if (!details.isFile())
    throw new Error("Cloudflare secrets path is not a file");
  const secrets = JSON.parse(await readFile(path, "utf8"));
  if (
    Object.keys(secrets).sort().join(",") !== REQUIRED_SECRETS.join(",") ||
    REQUIRED_SECRETS.some(
      (name) => typeof secrets[name] !== "string" || secrets[name].length < 32,
    )
  ) {
    throw new Error(
      "Cloudflare secrets file must contain exactly the required secrets",
    );
  }
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

export async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export function stateDirectory(repositoryRoot, deploymentId) {
  deploymentNames(deploymentId);
  return resolve(repositoryRoot, ".tools", "cloudflare", deploymentId);
}

export async function readDeploymentState(repositoryRoot, deploymentId) {
  const path = join(stateDirectory(repositoryRoot, deploymentId), "state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  if (
    state?.schemaVersion !== 1 ||
    state.deploymentId !== deploymentId ||
    typeof state.buildId !== "string" ||
    typeof state.resources?.databaseId !== "string"
  ) {
    throw new Error("Cloudflare deployment state is invalid");
  }
  return state;
}

export function assertExpectedBuild(state, expectedBuild) {
  if (expectedBuild === "none") {
    if (state !== undefined)
      throw new Error("Expected a fresh Cloudflare install");
    return;
  }
  if (state?.buildId !== expectedBuild) {
    throw new Error(
      `Expected Cloudflare build ${expectedBuild}, found ${state?.buildId ?? "none"}`,
    );
  }
}
