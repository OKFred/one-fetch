import { readFile } from "node:fs/promises";
import { URL } from "node:url";

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
    values.set(name, trimmed.slice(separator + 1));
  }
  return values;
}

export async function readDeploymentEnvironment(path) {
  const values = parseEnv(await readFile(path, "utf8"));
  if (values.has("ONE_FETCH_BUILD_VERSION")) {
    throw new Error(
      "Remove ONE_FETCH_BUILD_VERSION from the env file; deploy scripts inject the commit build ID",
    );
  }
  for (const name of [
    "ONE_FETCH_INSTANCE_ID",
    "ONE_FETCH_CONTROL_BASE_URL",
    "ONE_FETCH_GATEWAY_BASE_URL",
  ]) {
    if (!values.get(name)) throw new Error(`Missing ${name} in env file`);
  }
  return values;
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
