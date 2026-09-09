import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import {
  createCloudflareConfigs,
  latestVersionId,
  writePrivateJson,
} from "./cloudflare-support.mjs";

const executeFile = promisify(execFile);
export const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const adapterRoot = join(repositoryRoot, "adapters", "cloudflare");
const wranglerEntry = createRequire(join(adapterRoot, "package.json")).resolve(
  "wrangler",
);

export async function runWrangler(arguments_, options = {}) {
  await access(wranglerEntry);
  const result = await executeFile(
    process.execPath,
    [wranglerEntry, ...arguments_],
    {
      cwd: adapterRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  return options.json === true
    ? JSON.parse(result.stdout)
    : `${result.stdout}\n${result.stderr}`;
}

export async function workerExists(name) {
  try {
    await runWrangler(["versions", "list", "--name", name, "--json"], {
      json: true,
    });
    return true;
  } catch (error) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
    if (/not found|does not exist|10090/iu.test(output)) return false;
    throw error;
  }
}

export async function readToken(path) {
  const token = (await readFile(resolve(path), "utf8")).trim();
  if (token.length < 16)
    throw new Error("Admin token file is empty or invalid");
  return token;
}

export async function setPaused(state, token, paused) {
  const response = await globalThis.fetch(
    new globalThis.URL("/api/v1/config/gateway-paused", state.controlUrl),
    {
      method: "PUT",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ schemaVersion: 1, paused }),
      cache: "no-store",
    },
  );
  if (!response.ok)
    throw new Error(`Control pause failed with ${response.status}`);
  const value = await response.json();
  if (value.gatewayPaused !== paused)
    throw new Error("Control did not confirm Gateway pause state");
  return value;
}

function configOptions(values, deploymentId, buildId, databaseId) {
  return {
    deploymentId,
    buildId,
    databaseId,
    adminAllowedOrigins:
      values.get("--admin-origins") ?? "http://localhost:5173",
    xpanelAllowedOrigins:
      values.get("--xpanel-origins") ??
      "chrome-extension://diaemdialoooebdennhpgnmobnjabohm",
    controlMain: join(adapterRoot, "src", "control.ts"),
    gatewayMain: join(adapterRoot, "src", "gateway.ts"),
    migrationsDirectory: join(adapterRoot, "migrations"),
  };
}

export async function writeConfigs(
  directory,
  values,
  deploymentId,
  buildId,
  databaseId,
) {
  const configs = createCloudflareConfigs(
    configOptions(values, deploymentId, buildId, databaseId),
  );
  const control = join(directory, "wrangler.control.json");
  const gateway = join(directory, "wrangler.gateway.json");
  await writePrivateJson(control, configs.control);
  await writePrivateJson(gateway, configs.gateway);
  return { control, gateway };
}

export async function currentVersionId(name) {
  return latestVersionId(
    await runWrangler(["versions", "list", "--name", name, "--json"], {
      json: true,
    }),
  );
}
