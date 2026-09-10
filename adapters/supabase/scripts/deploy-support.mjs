import { Buffer } from "node:buffer";
import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";

export const deploymentFunctionSlugs = [
  "one-fetch-control",
  "one-fetch-gateway",
];
const deploymentEnvironmentNames = new Set([
  "ONE_FETCH_INSTANCE_ID",
  "ONE_FETCH_BOOTSTRAP_SECRET",
  "ONE_FETCH_PEPPER",
  "ONE_FETCH_AUDIT_SIGNING_PRIVATE_KEY",
  "ONE_FETCH_AUDIT_VERIFYING_PUBLIC_KEY",
  "ONE_FETCH_AUDIT_KEY_ID",
  "ONE_FETCH_ALLOWED_ADMIN_ORIGINS",
  "ONE_FETCH_ALLOWED_CLIENT_ORIGINS",
  "ONE_FETCH_CONTROL_BASE_URL",
  "ONE_FETCH_GATEWAY_BASE_URL",
]);

export function buildId(packageVersion, commit) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageVersion)) {
    throw new Error("Package version cannot be used in a build ID");
  }
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    throw new Error("Expected a full Git commit SHA");
  }
  return `${packageVersion}+supabase.g${commit.slice(0, 12)}`;
}

export function parseEnv(source) {
  const values = new Map();
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) throw new Error("Invalid environment file line");
    const name = trimmed.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      throw new Error(`Invalid environment variable name ${name}`);
    }
    if (values.has(name)) {
      throw new Error(`Duplicate environment variable ${name}`);
    }
    values.set(name, trimmed.slice(separator + 1));
  }
  return values;
}

export async function readDeploymentEnvironment(path) {
  const values = parseEnv(await readFile(path, "utf8"));
  for (const name of values.keys()) {
    if (!deploymentEnvironmentNames.has(name)) {
      throw new Error(
        `Unknown or reserved deployment environment variable ${name}`,
      );
    }
  }
  for (const name of deploymentEnvironmentNames) {
    if (!values.has(name)) throw new Error(`Missing ${name} in env file`);
  }
  assertSecretBytes(values.get("ONE_FETCH_BOOTSTRAP_SECRET"), "bootstrap", 32);
  assertSecretBytes(values.get("ONE_FETCH_PEPPER"), "pepper", 32);
  assertAuditKeyPair(values);
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(values.get("ONE_FETCH_AUDIT_KEY_ID"))) {
    throw new Error("Audit key ID is invalid");
  }
  assertOrigins(values.get("ONE_FETCH_ALLOWED_ADMIN_ORIGINS"), false);
  assertOrigins(values.get("ONE_FETCH_ALLOWED_CLIENT_ORIGINS"), true);
  return values;
}

function decodeBase64url(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${label} must be canonical base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error(`${label} must be canonical base64url`);
  }
  return decoded;
}

function assertSecretBytes(value, label, minimumBytes) {
  if (decodeBase64url(value, label).length < minimumBytes) {
    throw new Error(
      `${label} must contain at least ${minimumBytes} random bytes`,
    );
  }
}

function assertAuditKeyPair(values) {
  try {
    const privateDer = decodeBase64url(
      values.get("ONE_FETCH_AUDIT_SIGNING_PRIVATE_KEY"),
      "audit signing private key",
    );
    const publicDer = decodeBase64url(
      values.get("ONE_FETCH_AUDIT_VERIFYING_PUBLIC_KEY"),
      "audit verifying public key",
    );
    const privateKey = createPrivateKey({
      key: privateDer,
      format: "der",
      type: "pkcs8",
    });
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error();
    const derived = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    if (
      derived.length !== publicDer.length ||
      !timingSafeEqual(derived, publicDer)
    ) {
      throw new Error();
    }
  } catch {
    throw new Error(
      "Audit signing and verifying keys are not a valid Ed25519 pair",
    );
  }
}

function assertOrigins(value, allowExtension) {
  if (typeof value !== "string") throw new Error("Origin list is missing");
  const origins = value ? value.split(",").map((item) => item.trim()) : [];
  if (
    origins.some((origin) => !origin) ||
    new Set(origins).size !== origins.length
  ) {
    throw new Error("Origin lists cannot contain empty or duplicate entries");
  }
  for (const origin of origins) {
    if (allowExtension && /^chrome-extension:\/\/[a-p]{32}$/u.test(origin)) {
      continue;
    }
    const url = new URL(origin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== origin
    ) {
      throw new Error(`Unsafe deployment origin ${origin}`);
    }
  }
}

export function assertHostedDeployment(values, projectRef) {
  if (!/^[a-z0-9]{20}$/u.test(projectRef)) {
    throw new Error("Expected a 20-character Supabase project ref");
  }
  const instanceId = values.get("ONE_FETCH_INSTANCE_ID");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      instanceId ?? "",
    )
  ) {
    throw new Error("ONE_FETCH_INSTANCE_ID must be a UUID");
  }
  const controlUrl = new URL(values.get("ONE_FETCH_CONTROL_BASE_URL"));
  const gatewayUrl = new URL(values.get("ONE_FETCH_GATEWAY_BASE_URL"));
  for (const [name, url, suffix] of [
    ["Control", controlUrl, "/functions/v1/one-fetch-control"],
    ["Gateway", gatewayUrl, "/functions/v1/one-fetch-gateway"],
  ]) {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      url.pathname !== suffix
    ) {
      throw new Error(`${name} URL is not a safe hosted function base URL`);
    }
  }
  const expectedHost = `${projectRef}.supabase.co`;
  if (
    controlUrl.hostname !== expectedHost ||
    gatewayUrl.hostname !== expectedHost
  ) {
    throw new Error("Function URLs do not match the explicit Supabase project");
  }
  return { instanceId, controlUrl, gatewayUrl };
}

export function assertExpectedCurrentBuild(value) {
  if (value === "none") return value;
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\+supabase\.g[a-f0-9]{12}$/u.test(value)
  ) {
    throw new Error(
      "Expected current build must be 'none' or package-version+supabase.g<12-character-commit>",
    );
  }
  return value;
}

export function parseFunctionList(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Supabase function list did not return JSON");
  }
  if (parsed === null) return new Map();
  if (!Array.isArray(parsed)) {
    throw new Error("Supabase function list JSON must be an array");
  }
  const functions = new Map();
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Supabase Function inventory contains an invalid item");
    }
    const slug = item.slug ?? item.name;
    if (!deploymentFunctionSlugs.includes(slug)) continue;
    if (functions.has(slug)) {
      throw new Error(`Supabase reported ${slug} more than once`);
    }
    const expectedEntrypoint = new RegExp(
      `(?:^|/)functions/${slug}/\\.one-fetch-bundle/index\\.js$`,
      "u",
    );
    if (
      typeof item.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        item.id,
      ) ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1 ||
      item.status !== "ACTIVE" ||
      item.verify_jwt !== false ||
      typeof item.entrypoint_path !== "string" ||
      !expectedEntrypoint.test(item.entrypoint_path) ||
      typeof item.ezbr_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.ezbr_sha256) ||
      !Number.isSafeInteger(item.created_at) ||
      item.created_at < 0 ||
      !Number.isSafeInteger(item.updated_at) ||
      item.updated_at < item.created_at
    ) {
      throw new Error(
        `Supabase reported unsafe deployment metadata for ${slug}`,
      );
    }
    functions.set(slug, {
      id: item.id,
      slug,
      version: item.version,
      status: item.status,
      verifyJwt: item.verify_jwt,
      entrypointPath: item.entrypoint_path,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      bundleSha256: item.ezbr_sha256,
    });
  }
  return functions;
}

export function serializableFunctionList(functions) {
  return deploymentFunctionSlugs.flatMap((slug) => {
    const item = functions.get(slug);
    return item === undefined ? [] : [item];
  });
}

export function assertFunctionBaseline(functions, expectedCurrentBuild) {
  assertExpectedCurrentBuild(expectedCurrentBuild);
  const present = deploymentFunctionSlugs.filter((slug) => functions.has(slug));
  if (expectedCurrentBuild === "none") {
    if (present.length > 0) {
      throw new Error(
        `Expected a first deployment, but these Functions already exist: ${present.join(", ")}`,
      );
    }
    return;
  }
  if (present.length !== deploymentFunctionSlugs.length) {
    throw new Error(
      `Remote deployment is partial; expected both Functions but found: ${present.join(", ") || "none"}`,
    );
  }
}

export function assertFunctionTransition(before, after, changedSlug) {
  if (!deploymentFunctionSlugs.includes(changedSlug)) {
    throw new Error(`Unknown deployment Function ${changedSlug}`);
  }
  for (const slug of deploymentFunctionSlugs) {
    const previous = before.get(slug);
    const current = after.get(slug);
    if (slug === changedSlug) {
      if (current === undefined) {
        throw new Error(`${slug} is missing after deployment`);
      }
      if (previous !== undefined && current.version <= previous.version) {
        throw new Error(`${slug} version did not advance after deployment`);
      }
    } else if (
      (previous === undefined) !== (current === undefined) ||
      (previous !== undefined &&
        JSON.stringify(current) !== JSON.stringify(previous))
    ) {
      throw new Error(`${slug} changed while deploying ${changedSlug}`);
    }
  }
}

export function assertSecretRefreshTransition(before, after) {
  for (const slug of deploymentFunctionSlugs) {
    const previous = before.get(slug);
    const current = after.get(slug);
    if (previous === undefined || current === undefined) {
      throw new Error(`${slug} disappeared while refreshing secrets`);
    }
    if (
      current.id !== previous.id ||
      current.slug !== previous.slug ||
      current.status !== previous.status ||
      current.verifyJwt !== previous.verifyJwt ||
      current.bundleSha256 !== previous.bundleSha256 ||
      current.createdAt !== previous.createdAt ||
      current.version < previous.version ||
      current.updatedAt < previous.updatedAt
    ) {
      throw new Error(`${slug} code changed while refreshing secrets`);
    }
  }
}

export function recoverySteps(phase, desiredBuildId, expectedCurrentBuild) {
  const steps = [
    "Stop automated rollout attempts and inspect this state record plus Supabase Function logs.",
    `Prefer roll-forward: deploy both Functions from the staged ${desiredBuildId} artifacts, then set ONE_FETCH_BUILD_VERSION and rerun verification.`,
  ];
  if (phase !== "preflight") {
    steps.push(
      "Treat the service as degraded until both Function versions and Control/Gateway probes are verified together.",
    );
  }
  if (expectedCurrentBuild !== "none") {
    steps.push(
      `The recorded prior application build is ${expectedCurrentBuild}; regenerate it from its immutable commit only if schema compatibility is confirmed.`,
    );
  }
  if (
    [
      "database",
      "secrets",
      "control",
      "gateway",
      "build-secret",
      "verify",
    ].includes(phase)
  ) {
    steps.push(
      "Do not reverse SQL on the active database. If roll-forward is unsafe, restore a pre-deploy backup into a separate project, verify it, and switch clients explicitly.",
    );
  }
  return steps;
}
